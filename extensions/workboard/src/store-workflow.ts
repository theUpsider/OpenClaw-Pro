import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  WorkboardArtifact,
  WorkboardCard,
  WorkboardClaim,
  WorkboardMetadata,
  WorkboardRunAttempt,
} from "@openclaw/workboard-contract";
import {
  isFutureDateTimestampMs,
  resolveOptionalIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  appendComment,
  assertCanMutateClaimedCard,
  cardBoardId,
  cardChildIds,
  cardParentIds,
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
  isDependencyPromotableStatus,
  latestRunningAttempt,
  mutationActorId,
  retryBudgetExhausted,
} from "./store-card-helpers.js";
import {
  addWorkboardDurationMs,
  DEFAULT_CLAIM_TTL_MS,
  isWorkboardClaimReclaimable,
  MAX_CARD_ARTIFACTS,
  secondsToDurationMs,
  workboardBoardOwnerSlotLimit,
  workboardCardIsExternallyDispatched,
} from "./store-constants.js";
import {
  appendEvidence,
  buildCompletionClaims,
  buildVerification,
  evidenceFits,
} from "./store-evidence.js";
import type {
  WorkboardBlockInput,
  WorkboardCardPatch,
  WorkboardClaimInput,
  WorkboardClaimOptions,
  WorkboardCompleteInput,
  WorkboardDecomposeInput,
  WorkboardHeartbeatInput,
  WorkboardMutationScope,
  WorkboardReassignInput,
  WorkboardReclaimInput,
  WorkboardSpecifyInput,
  WorkboardVerifyInput,
} from "./store-inputs.js";
import {
  appendCompletionProof,
  appendWorkerLogEntry,
  capText,
  capWorkboardSummary,
  clearDiagnostics,
  deriveChildIdempotencyKey,
  normalizeArtifact,
  normalizeBoundedString,
  normalizeProofInput,
  normalizeStatus,
  normalizeStringList,
} from "./store-normalizers.js";
import { WorkboardPromoteStore } from "./store-promote.js";
import { finishRun } from "./store-status-write.js";

export const WORKBOARD_DANGLING_SESSION_REASON =
  "Linked session is missing; termination unconfirmed.";

class WorkboardClaimRefusedError extends Error {
  constructor(message: string) {
    super(message);
    // The name lets Gateway tool invocation return the actionable message.
    this.name = "ToolInputError";
  }
}

function assertClaimIdentity(claim: WorkboardClaim, input: WorkboardHeartbeatInput): void {
  const token = normalizeOptionalString(input.token);
  const ownerId = normalizeOptionalString(input.ownerId);
  if (token && !safeEqualSecret(token, claim.token)) {
    throw new Error("claim token does not match.");
  }
  if (!token && ownerId && ownerId !== claim.ownerId) {
    throw new Error("claim owner does not match.");
  }
}

export class WorkboardWorkflowStore extends WorkboardPromoteStore {
  async claim(
    id: string,
    input: WorkboardClaimInput,
    options: WorkboardClaimOptions = {},
  ): Promise<{ card: WorkboardCard; token: string }> {
    const ownerId = normalizeBoundedString(input.ownerId, undefined, 120, "claim owner");
    if (!ownerId) {
      throw new Error("claim ownerId is required.");
    }
    const ttlSeconds = resolveOptionalIntegerOption(input.ttlSeconds, { min: 1 });
    const token =
      normalizeBoundedString(input.token, undefined, 160, "claim token") ?? randomUUID();
    return await this.enqueueMutation(async () => {
      const now = Date.now();
      const expiresAt = addWorkboardDurationMs(
        now,
        ttlSeconds ? secondsToDurationMs(ttlSeconds) : DEFAULT_CLAIM_TTL_MS,
      );
      const guarded = await this.promoteDependencyReady(await this.requireCard(id), now);
      if (guarded.metadata?.archivedAt) {
        throw new Error("card is archived.");
      }
      const expectedAuthority = options.expectedAuthority;
      if (
        expectedAuthority &&
        (guarded.status !== expectedAuthority.status ||
          cardBoardId(guarded) !== expectedAuthority.boardId ||
          guarded.agentId !== expectedAuthority.agentId ||
          // A native start assumes the card is still locally placed: an edit to
          // external placement between selection and claim must refuse the claim
          // instead of racing the external controller. An absent flag means the
          // caller assumed native, which is the only placement a pass starts.
          Boolean(expectedAuthority.externallyDispatched) !==
            workboardCardIsExternallyDispatched(guarded) ||
          !isDeepStrictEqual(
            guarded.metadata?.automation?.workspace,
            expectedAuthority.workspace,
          ) ||
          !isDeepStrictEqual(
            guarded.metadata?.automation?.workspaceAccess,
            expectedAuthority.workspaceAccess,
          ))
      ) {
        throw new Error("card workspace authority changed before claim.");
      }
      const existingClaim = guarded.metadata?.claim;
      const activeClaim =
        existingClaim &&
        (isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now }) ||
          // External transport may still be alive after an outage. Its owner
          // confirms cleanup and explicitly releases/reclaims before replacement.
          workboardCardIsExternallyDispatched(guarded) ||
          // Direct claims must honor the same running-worker heartbeat grace
          // as dispatcher recovery; otherwise they silently steal live tokens.
          (guarded.status === "running" && !isWorkboardClaimReclaimable(existingClaim, now)))
          ? existingClaim
          : undefined;
      const parentIds = cardParentIds(guarded);
      if (parentIds.length > 0 && guarded.status !== "ready" && !activeClaim) {
        if (guarded.status === "blocked") {
          throw new WorkboardClaimRefusedError(
            "card is blocked; use workboard_unblock before claiming.",
          );
        }
        // Dependency promotion skips review and running cards, so judge the parents.
        if (!(await this.parentsDone(parentIds))) {
          throw new WorkboardClaimRefusedError("card dependencies are not done.");
        }
      }
      if (guarded.status === "scheduled") {
        throw new WorkboardClaimRefusedError("card is scheduled for later.");
      }
      if (retryBudgetExhausted(guarded)) {
        throw new WorkboardClaimRefusedError("card exhausted its retry budget.");
      }
      if (activeClaim) {
        throw new WorkboardClaimRefusedError(`card already claimed by ${activeClaim.ownerId}.`);
      }
      // A claim from a startable status begins a new attempt; an open one would run twice.
      if (isDependencyPromotableStatus(guarded.status) && latestRunningAttempt(guarded)) {
        throw new WorkboardClaimRefusedError(
          "card still has a running attempt; complete, block, or reclaim it before claiming.",
        );
      }
      const metadata = clearDiagnostics(guarded.metadata, ["stranded_ready"]);
      const board = await this.boardStore.lookup(cardBoardId(guarded));
      const card = await this.updateCard(
        guarded,
        {
          status:
            guarded.status === "backlog" || guarded.status === "todo" || guarded.status === "ready"
              ? "running"
              : guarded.status,
          ...(options.adoptWorkspaceAccess && !guarded.metadata?.automation?.workspaceAccess
            ? { workspaceAccess: options.adoptWorkspaceAccess }
            : {}),
          metadata: {
            ...metadata,
            claim: { ownerId, token, claimedAt: now, lastHeartbeatAt: now, expiresAt },
          },
        },
        {
          expectedUpdatedAt: guarded.updatedAt,
          ownerSlot: { ownerId, now, limit: workboardBoardOwnerSlotLimit(board?.board) },
        },
      );
      return { card, token };
    }, options.assertOwnerCurrent);
  }

  async heartbeat(id: string, input: WorkboardHeartbeatInput): Promise<WorkboardCard> {
    const note = normalizeBoundedString(input.note, undefined, 400, "heartbeat note");
    return await this.updateMetadata(id, (existing) => {
      const claim = existing.metadata?.claim;
      if (!claim) {
        throw new Error("card is not claimed.");
      }
      const now = Math.max(Date.now(), claim.lastHeartbeatAt + 1);
      assertClaimIdentity(claim, input);
      const nextClaim = {
        ...claim,
        lastHeartbeatAt: now,
        expiresAt: claim.expiresAt
          ? addWorkboardDurationMs(
              now,
              Math.max(
                1,
                claim.expiresAt > claim.claimedAt
                  ? claim.expiresAt - claim.lastHeartbeatAt
                  : DEFAULT_CLAIM_TTL_MS,
              ),
            )
          : undefined,
      };
      const metadata = clearDiagnostics(existing.metadata, ["running_without_heartbeat"]);
      return {
        ...metadata,
        claim: nextClaim,
        comments: appendComment(metadata.comments, note, now),
      };
    });
  }

  async releaseClaim(
    id: string,
    input: WorkboardHeartbeatInput & { status?: unknown } = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      const status = normalizeStatus(input.status, existing.status);
      const claim = existing.metadata?.claim;
      if (claim) {
        assertClaimIdentity(claim, input);
      }
      return await this.updateCard(
        existing,
        {
          status,
          metadata: { ...existing.metadata, claim: undefined },
        },
        { actor: scope ?? null, enforceStatusHolds: input.status !== undefined },
      );
    });
  }

  async complete(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(() => this.completeDirect(id, input, scope, "review"));
  }

  /**
   * A worker's own completion is not acceptance: it lands in `review` with an
   * acceptance marker until someone moves the card to `done`. Acceptance is decided
   * by identity, not by status: operator completion (null scope) accepts, and so
   * does a completion by anyone other than the owner that reported the pending
   * result. Decomposition otherwise completes its parent as `done`, because the
   * children wait on that parent.
   */
  private async completeDirect(
    id: string,
    input: WorkboardCompleteInput,
    scope: WorkboardMutationScope | null | undefined,
    unacceptedStatus: "review" | "done",
  ): Promise<WorkboardCard> {
    const existing = await this.requireCard(id);
    assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
    const completedBy = scope === null ? undefined : mutationActorId(existing, scope);
    const { awaitingAcceptance, autoCompletedBy } = existing.metadata?.automation ?? {};
    const acceptsPendingResult = Boolean(
      awaitingAcceptance && autoCompletedBy && completedBy && autoCompletedBy !== completedBy,
    );
    const status =
      scope === null || acceptsPendingResult
        ? "done"
        : awaitingAcceptance
          ? "review"
          : unacceptedStatus;
    const now = Date.now();
    const createdCardIds = normalizeStringList(input.createdCardIds, "created card ids", 120);
    const childIds = cardChildIds(existing);
    for (const createdCardId of createdCardIds) {
      const createdCard = await this.get(createdCardId);
      if (!createdCard) {
        throw new Error(`created card not found: ${createdCardId}`);
      }
      const linkedFromParent =
        childIds.includes(createdCardId) && cardParentIds(createdCard).includes(existing.id);
      if (!linkedFromParent) {
        throw new Error(`created card is not linked to this card: ${createdCardId}`);
      }
    }
    // Prose, not authority: cap an over-long summary instead of discarding the
    // proof, artifacts, and status move that travel with it. The truncation is
    // recorded on the card as a warning worker log.
    const { summary, workerLog: summaryCapLog } = capWorkboardSummary(
      input.summary,
      "completion summary",
      now,
    );
    const proofInput = isRecord(input.proof) ? input.proof : undefined;
    const proofId = normalizeBoundedString(input.proofId, undefined, 120, "proof id");
    if (input.proofId !== undefined && !proofId) {
      throw new Error("proofId must be a non-empty string.");
    }
    const proof = proofInput ? normalizeProofInput(proofInput, now) : undefined;
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts
          .map((artifact) => normalizeArtifact({ ...artifact, createdAt: now }))
          .filter((artifact): artifact is WorkboardArtifact => artifact !== null)
          .slice(-MAX_CARD_ARTIFACTS)
      : [];
    const finished = finishRun(existing, status, now);
    // Claims are stamped with the caller. Gateway completion has none and must not
    // borrow the claim owner's name.
    const claimedBy = normalizeOptionalString(scope?.ownerId);
    if (!claimedBy && input.claims !== undefined) {
      throw new Error(
        "claims need the completing agent's identity; complete through workboard_complete.",
      );
    }
    const claims = claimedBy ? buildCompletionClaims(existing, input.claims, claimedBy, now) : [];
    const metadata = clearDiagnostics(finished.metadata, ["missing_proof"]);
    const notifications = this.appendNotification(metadata, now, {
      kind: "completed",
      message: capText(summary, 240) ?? "Workboard card completed.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    });
    return await this.updateCard(
      existing,
      {
        ...finished,
        metadata: {
          ...metadata,
          automation: { ...metadata.automation, summary, createdCardIds },
              ...(status === "review"
                ? {
                    awaitingAcceptance: true,
                    autoCompletedAt: now,
                    autoCompletedBy: completedBy,
                    acceptanceSeenAt: undefined,
                  }
                : { awaitingAcceptance: false }),
          comments: appendComment(metadata.comments, summary, now),
          workerLogs: appendWorkerLogEntry(metadata.workerLogs, summaryCapLog),
          proof: appendCompletionProof(metadata.proof, proof, proofId),
          artifacts: artifacts.length
            ? [...(metadata.artifacts ?? []), ...artifacts].slice(-MAX_CARD_ARTIFACTS)
            : metadata.artifacts,
          notifications,
        },
      },
      {
        actor: scope ?? null,
        enforceStatusHolds: true,
        preserveProofId: proofId ?? proof?.id,
        preserveNotificationId: notifications.at(-1)?.id,
        ...(claims.length
          ? { automationEvidence: appendEvidence(existing.metadata?.automation?.evidence, claims) }
          : {}),
        agentId: scope?.agentId,
        interaction: scope?.interaction,
      },
    );
  }

  /**
   * Records a checker's verdict. Evidence only: status, claim, proof, and dependency
   * scheduling are untouched, so it works the same before or after completion.
   */
  async verify(
    id: string,
    input: WorkboardVerifyInput,
    scope: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const checkerId = normalizeOptionalString(scope.ownerId);
    if (!checkerId) {
      throw new Error("verification needs a caller identity.");
    }
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope);
      const verification = buildVerification(existing, input, checkerId, Date.now());
      if (!evidenceFits(existing, verification)) {
        // A checker gets a visible refusal, as a tool input error, rather than a silent drop.
        throw new WorkboardClaimRefusedError(
          "card metadata has no room for this verification; shorten scope, note, or url.",
        );
      }
      return await this.updateCard(
        existing,
        {},
        {
          automationEvidence: appendEvidence(existing.metadata?.automation?.evidence, [
            verification,
          ]),
        },
      );
    });
  }

  protected buildBlockedCardPatch(
    existing: WorkboardCard,
    reason: string,
    now: number,
    options: { clearExecutionAssociation?: boolean } = {},
  ): WorkboardCardPatch & { metadata: WorkboardMetadata } {
    const finished = finishRun(existing, "blocked", now, reason);
    const metadata = finished.metadata;
    const notifications = this.appendNotification(metadata, now, {
      kind: "failed",
      message: capText(reason, 240) ?? "Workboard card blocked.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    });
    return {
      ...finished,
      ...(options.clearExecutionAssociation
        ? { sessionKey: null, runId: null, execution: null }
        : {}),
      metadata: {
        ...metadata,
        comments: appendComment(metadata.comments, reason, now),
        notifications,
      },
    };
  }

  /**
   * Records what an authoritative sweep saw of a running card's accepted session link.
   * A first miss is only marked; a second consecutive miss for the same attempt blocks
   * the card once through the normal block path. Link, execution and attempt history
   * stay for the operator. A reappearing session clears an unreconciled marker.
   */
  async reconcileDanglingSession(
    id: string,
    input: { sessionKey: string; present: boolean; now: number },
  ): Promise<"marked" | "blocked" | "cleared" | undefined> {
    return await this.enqueueMutation(async () => {
      let outcome: "marked" | "blocked" | "cleared" | undefined;
      const result = await this.updateLatestCard(id, (card) => {
        const automation = card.metadata?.automation;
        const marker = automation?.danglingSession;
        if (input.present) {
          if (!marker || card.status === "blocked") {
            return undefined;
          }
          outcome = "cleared";
          return {
            metadata: {
              ...card.metadata,
              automation: { ...automation, danglingSession: undefined },
            },
          };
        }
        const launch = automation?.launch;
        if (
          card.metadata?.archivedAt ||
          card.sessionKey !== input.sessionKey ||
          (card.status !== "running" && card.execution?.status !== "running") ||
          (launch && launch.phase !== "accepted")
        ) {
          return undefined;
        }
        const runId = cardRunId(card);
        if (!marker || marker.sessionKey !== input.sessionKey || marker.runId !== runId) {
          outcome = "marked";
          const danglingSession = {
            sessionKey: input.sessionKey,
            ...(runId ? { runId } : {}),
            detectedAt: input.now,
            misses: 1,
          };
          return { metadata: { ...card.metadata, automation: { ...automation, danglingSession } } };
        }
        outcome = "blocked";
        const reason = `${WORKBOARD_DANGLING_SESSION_REASON} Session: ${input.sessionKey}`;
        const patch = this.buildBlockedCardPatch(card, reason, input.now);
        return {
          ...patch,
          metadata: {
            ...patch.metadata,
            automation: {
              ...patch.metadata.automation,
              danglingSession: { ...marker, misses: marker.misses + 1 },
            },
          },
        };
      });
      return result.updated ? outcome : undefined;
    });
  }

  async block(
    id: string,
    input: WorkboardBlockInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
    options: { clearExecutionAssociation?: boolean } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 2000, "block reason") ??
        "Workboard card blocked.";
      const patch = this.buildBlockedCardPatch(existing, reason, now, options);
      return await this.updateCard(
        existing,
        {
          ...patch,
          ...(input.decisionOptions === undefined
            ? {}
            : { decisionOptions: input.decisionOptions }),
          ...(input.ask === undefined ? {} : { ask: input.ask }),
          ...(input.askKind === undefined ? {} : { askKind: input.askKind }),
        },
        { actor: scope ?? null, agentId: scope?.agentId, interaction: scope?.interaction },
      );
    });
  }

  async unblock(id: string, scope?: WorkboardMutationScope): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["blocked_too_long"]);
      return await this.updateCard(
        existing,
        { status: "todo", metadata: { ...metadata, stale: null } },
        { actor: scope ?? null },
      );
    });
  }

  async reassign(
    id: string,
    input: WorkboardReassignInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const agentId =
        input.agentId === undefined ? existing.agentId : normalizeOptionalString(input.agentId);
      const status = normalizeStatus(input.status, existing.status);
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "reassign reason");
      const shouldResetFailures = input.resetFailures !== false;
      const baseMetadata = shouldResetFailures
        ? clearDiagnostics(existing.metadata, ["blocked_too_long", "repeated_failures"])
        : existing.metadata;
      const metadata = {
        ...baseMetadata,
        ...(shouldResetFailures ? { failureCount: 0 } : {}),
        comments: appendComment(baseMetadata?.comments, reason),
      };
      return await this.updateCard(
        existing,
        { agentId, status, metadata },
        {
          actor: scope ?? null,
          enforceStatusHolds: true,
          agentId: scope?.agentId,
          interaction: scope?.interaction,
        },
      );
    });
  }

  async reclaim(
    id: string,
    input: WorkboardReclaimInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 1000, "reclaim reason") ??
        "Workboard claim reclaimed.";
      const targetStatus =
        input.status === undefined
          ? existing.status === "running"
            ? "ready"
            : existing.status
          : normalizeStatus(input.status, existing.status);
      const reclaimed = await this.updateCard(
        existing,
        {
          status: targetStatus,
          execution: existing.execution?.status === "running" ? null : existing.execution,
          metadata: {
            ...existing.metadata,
            claim: undefined,
            attempts: closeRunningAttempts(existing.metadata?.attempts, now, "stopped", reason),
            comments: appendComment(existing.metadata?.comments, reason, now),
            stale: null,
          },
        },
        { actor: scope ?? null, enforceStatusHolds: true },
      );
      return await this.promoteDependencyReady(reclaimed, now);
    });
  }

  async runs(id: string): Promise<{ card: WorkboardCard; attempts: WorkboardRunAttempt[] }> {
    const card = await this.requireCard(id);
    return { card, attempts: card.metadata?.attempts ?? [] };
  }

  async specify(
    id: string,
    input: WorkboardSpecifyInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      if (
        existing.status !== "triage" &&
        existing.status !== "backlog" &&
        existing.status !== "todo"
      ) {
        throw new Error("only triage, backlog, or todo cards can be specified.");
      }
      const requestedStatus = normalizeStatus(input.status, "todo");
      if (requestedStatus !== "todo") {
        throw new Error("specified cards must move to todo.");
      }
      const now = Date.now();
      const { summary, workerLog: summaryCapLog } = capWorkboardSummary(
        input.summary,
        "spec summary",
        now,
      );
      const metadata = {
        ...existing.metadata,
        comments: appendComment(existing.metadata?.comments, summary, now),
        automation: {
          ...existing.metadata?.automation,
          summary: summary ?? existing.metadata?.automation?.summary,
        },
        workerLogs: appendWorkerLogEntry(existing.metadata?.workerLogs, summaryCapLog),
      };
      const { summary: _summary, status: _status, ...cardPatch } = input;
      return await this.updateCard(
        existing,
        {
          ...cardPatch,
          status: "todo",
          metadata,
        },
        {
          actor: scope ?? null,
          enforceStatusHolds: true,
          event: { kind: "specified" },
          eventAt: now,
        },
      );
    });
  }

  async decompose(
    id: string,
    input: WorkboardDecomposeInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<{ parent: WorkboardCard; children: WorkboardCard[] }> {
    return await this.enqueueMutation(async () => {
      const parent = await this.requireCard(id);
      assertCanMutateClaimedCard(parent, scope === null ? undefined : scope);
      const childrenInput = Array.isArray(input.children) ? input.children : [];
      if (childrenInput.length === 0) {
        throw new Error("children are required.");
      }
      if (childrenInput.length > 20) {
        throw new Error("at most 20 children can be created at once.");
      }
      const parentAutomation = parent.metadata?.automation;
      const children: WorkboardCard[] = [];
      for (const child of childrenInput) {
        if (!isRecord(child)) {
          throw new Error("children must be objects.");
        }
        const created = await this.createDirect(
          {
            ...child,
            parents: [parent.id],
            boardId: child.boardId ?? parentAutomation?.boardId,
            tenant: child.tenant ?? parentAutomation?.tenant,
            // Persist placement before the child can ever be promoted to ready.
            dispatchMode: child.dispatchMode ?? parentAutomation?.dispatchMode,
            createdByCardId: parent.id,
            idempotencyKey:
              child.idempotencyKey ??
              deriveChildIdempotencyKey(parentAutomation?.idempotencyKey, children.length + 1),
          },
          scope === null ? undefined : scope,
        );
        children.push(
          cardParentIds(created).includes(parent.id)
            ? created
            : await this.linkCardsDirect(parent.id, created.id, Date.now(), {
                allowStatusOnlyActiveChild: true,
                scope: scope === null ? undefined : scope,
              }),
        );
      }
      const completeParent = input.completeParent !== false;
      // A completing decomposition routes through completeDirect, which caps and
      // marks the summary; an open parent is capped here at the same shared path.
      const updatedParent = completeParent
        ? await this.completeDirect(
            parent.id,
            { summary: input.summary, createdCardIds: children.map((child) => child.id) },
            scope,
            "done",
          )
        : await (async () => {
            const latestParent = await this.requireCard(parent.id);
            const now = Date.now();
            const { summary, workerLog: summaryCapLog } = capWorkboardSummary(
              input.summary,
              "decompose summary",
              now,
            );
            return await this.updateCard(
              latestParent,
              {
                status:
                  latestParent.status === "triage" || latestParent.status === "backlog"
                    ? "todo"
                    : latestParent.status,
                metadata: {
                  ...latestParent.metadata,
                  automation: {
                    ...latestParent.metadata?.automation,
                    summary,
                    createdCardIds: children.map((child) => child.id),
                  },
                },
              },
              { actor: scope ?? null, enforceStatusHolds: true },
            );
          })();
      const decomposedParent = await this.updateCard(
        updatedParent,
        {},
        {
          event: { kind: "decomposed" },
          expectedUpdatedAt: updatedParent.updatedAt,
        },
      );
      return { parent: decomposedParent, children };
    });
  }
}
