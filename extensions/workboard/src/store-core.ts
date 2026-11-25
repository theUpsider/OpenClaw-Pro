import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  WorkboardCard,
  WorkboardDeleteResult,
  WorkboardEvent,
  WorkboardLink,
  WorkboardMetadata,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { definedFields } from "../record-fields.js";
import {
  applyWorkboardCardClassifications,
  type WorkboardClassificationChange,
} from "./classification-palette.js";
import type { PersistedWorkboardCard } from "./persistence-types.js";
import { normalizeAutomationPatch, normalizeCardAutomation } from "./store-automation.js";
import { WorkboardBoardStore } from "./store-boards.js";
import {
  assertCanMutateClaimedCard,
  assertCanSettlePendingResult,
  cardBoardId,
  cardParentIds,
  cardSessionKey,
  isActiveDependencyTarget,
  isDependencyPromotableStatus,
  syncExecutionAttemptMetadata,
  updateEvent,
  appendEvent,
} from "./store-card-helpers.js";
import {
  MAX_CARD_COMMENTS,
  MAX_CARD_WORKER_LOGS,
  POSITION_STEP,
  workboardCardIsExternallyDispatched,
} from "./store-constants.js";
import { normalizeWithoutEvidence, withStoredEvidence } from "./store-evidence.js";
import type {
  WorkboardCardPatch,
  WorkboardCommentInput,
  WorkboardLinkInput,
  WorkboardLinkedCreateInput,
  WorkboardListOptions,
  WorkboardMutationScope,
  WorkboardOwnedCardPatch,
  WorkboardStatsResult,
  WorkboardUpdateCardOptions,
} from "./store-inputs.js";
import {
  appendLinkPreservingDependencies,
  metadataIsEmpty,
  normalizeBoardId,
  normalizeBoundedString,
  normalizeExecution,
  normalizeInteraction,
  normalizeLinkType,
  normalizeMetadata,
  normalizeNotes,
  normalizePriority,
  normalizeRunId,
  normalizeStatus,
  normalizeStringList,
  normalizeTemplateId,
  normalizeTimestamp,
  normalizeTitle,
  syncExecutionSessionKey,
  trimMetadataToBudget,
} from "./store-normalizers.js";
import { readCards } from "./store-read.js";
import { reviewWrittenInPatch } from "./store-review.js";
import { resolveLifecycleStatusWrite, settleManualStatusTransition } from "./store-status-write.js";
import { normalizeCappedStringList } from "./store-string-lists.js";

export class WorkboardCoreStore extends WorkboardBoardStore {
  private lastNotificationSequence = 0;

  async compensateWorkspaceMutation(before: WorkboardCard, after: WorkboardCard): Promise<void> {
    await this.enqueueMutation(async () => {
      const current = await this.get(after.id);
      const currentAutomation = current?.metadata?.automation;
      const afterAutomation = after.metadata?.automation;
      if (
        !current ||
        !isDeepStrictEqual(currentAutomation?.workspace, afterAutomation?.workspace) ||
        !isDeepStrictEqual(currentAutomation?.workspaceAccess, afterAutomation?.workspaceAccess)
      ) {
        return;
      }
      const automation = { ...currentAutomation };
      const originalAutomation = before.metadata?.automation;
      for (const key of ["workspace", "workspaceAccess"] as const) {
        if (originalAutomation?.[key] === undefined) {
          delete automation[key];
        }
      }
      const metadata = {
        ...current.metadata,
        automation: {
          ...automation,
          ...(originalAutomation?.workspace ? { workspace: originalAutomation.workspace } : {}),
          ...(originalAutomation?.workspaceAccess
            ? { workspaceAccess: originalAutomation.workspaceAccess }
            : {}),
        },
      };
      const restored = {
        ...current,
        metadata,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      };
      await this.store.registerIfUpdatedAt(
        restored.id,
        { version: 1, card: restored },
        current.updatedAt,
      );
    });
  }

  protected async updateLatestCard(
    id: string,
    buildPatch: (current: WorkboardCard) => WorkboardOwnedCardPatch | undefined,
    options: WorkboardUpdateCardOptions = {},
  ): Promise<{ card: WorkboardCard; updated: boolean }> {
    const current = await this.requireCard(id);
    if (
      options.expectedUpdatedAt !== undefined &&
      current.updatedAt !== options.expectedUpdatedAt
    ) {
      throw new WorkboardCardConflictError(current);
    }
    const ownedPatch = buildPatch(current);
    if (!ownedPatch) {
      return { card: current, updated: false };
    }
    const { ownedLaunch, ownedEvidence, ...patch } = ownedPatch;
    const card = await this.updateCard(current, patch, {
      ...options,
      automationLaunch: ownedLaunch,
      automationEvidence: ownedEvidence,
      expectedUpdatedAt: current.updatedAt,
    });
    return { card, updated: card.updatedAt !== current.updatedAt };
  }

  protected async updateMetadata(
    id: string,
    mutate: (existing: WorkboardCard) => WorkboardMetadata,
    options: {
      preserveProofId?: string;
      expectedUpdatedAt?: number;
      agentId?: string;
      interaction?: WorkboardUpdateCardOptions["interaction"];
      /**
       * Explicit audit event for a metadata write whose change the generic
       * `updateEvent` inference would misreport (for example an unlink, which
       * would otherwise be recorded as `link_added`).
       */
      event?: Omit<WorkboardEvent, "id" | "at">;
      eventAt?: number;
    } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      async () => await this.updateMetadataDirect(id, mutate, options),
    );
  }

  /**
   * The write half of `updateMetadata`, for callers already inside one queued
   * mutation: the queue is not reentrant, so a queued writer must reach the
   * card write directly (the same split as `linkCards`/`linkCardsDirect`).
   * Returning `undefined` from `mutate` skips the write entirely, so a caller
   * can make a replay a no-op instead of bumping `updatedAt` and the event log.
   */
  protected async updateMetadataDirect(
    id: string,
    mutate: (existing: WorkboardCard) => WorkboardMetadata | undefined,
    options: {
      preserveProofId?: string;
      expectedUpdatedAt?: number;
      agentId?: string;
      interaction?: WorkboardUpdateCardOptions["interaction"];
      event?: Omit<WorkboardEvent, "id" | "at">;
      eventAt?: number;
    } = {},
  ): Promise<WorkboardCard> {
    const result = await this.updateLatestCard(
      id,
      (current) => {
        const metadata = mutate(current);
        return metadata === undefined ? undefined : { metadata };
      },
      options,
    );
    return result.card;
  }

  protected async deleteDetachedAttachments(
    existing: WorkboardCard,
    next: WorkboardCard,
  ): Promise<void> {
    const nextIds = new Set(next.metadata?.attachments?.map((attachment) => attachment.id) ?? []);
    for (const attachment of existing.metadata?.attachments ?? []) {
      if (!nextIds.has(attachment.id)) {
        await this.attachmentStore.delete(attachment.id);
      }
    }
  }

  protected nextNotificationSequence(now: number): number {
    const base = Math.max(0, Math.trunc(now)) * 1000;
    this.lastNotificationSequence = Math.max(this.lastNotificationSequence + 1, base);
    return this.lastNotificationSequence;
  }

  async stats(input: WorkboardListOptions = {}, now = Date.now()): Promise<WorkboardStatsResult> {
    const boardId = normalizeBoardId(input.boardId);
    const aggregates = await this.store.listStatsAggregates(boardId);
    const byStatus: Partial<Record<WorkboardStatus, number>> = {};
    const byAgent = Object.create(null) as Record<string, number>;
    let oldestReadyAt: number | undefined;
    let updatedAt: number | undefined;
    let archived = 0;
    let total = 0;
    for (const aggregate of aggregates) {
      byStatus[aggregate.status] = (byStatus[aggregate.status] ?? 0) + aggregate.total;
      const agentId = aggregate.agentId ?? "(default)";
      byAgent[agentId] = (byAgent[agentId] ?? 0) + aggregate.total;
      total += aggregate.total;
      archived += aggregate.archived;
      if (aggregate.oldestReadyAt !== undefined) {
        oldestReadyAt = Math.min(oldestReadyAt ?? aggregate.oldestReadyAt, aggregate.oldestReadyAt);
      }
      updatedAt = Math.max(updatedAt ?? 0, aggregate.updatedAt);
    }
    return {
      id: boardId ?? "all",
      total,
      active: total - archived,
      archived,
      byStatus,
      byAgent,
      ...(oldestReadyAt ? { oldestReadyAgeMs: Math.max(0, now - oldestReadyAt) } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  async get(id: string): Promise<WorkboardCard | undefined> {
    const entry = await this.store.lookup(id.trim());
    return entry?.card;
  }

  protected async requireCard(id: string): Promise<WorkboardCard> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return card;
  }

  private async removeReferencesToCard(
    cardId: string,
  ): Promise<NonNullable<WorkboardDeleteResult["referenceUpdates"]>> {
    const referenceUpdates: NonNullable<WorkboardDeleteResult["referenceUpdates"]> = [];
    for (const card of await this.list()) {
      if (!card.metadata?.links?.some((link) => link.targetCardId === cardId)) {
        continue;
      }
      let previousUpdatedAt = card.updatedAt;
      const result = await this.updateLatestCard(card.id, (current) => {
        const links = current.metadata?.links;
        if (!links?.some((link) => link.targetCardId === cardId)) {
          return undefined;
        }
        previousUpdatedAt = current.updatedAt;
        return {
          metadata: {
            ...current.metadata,
            links: links.filter((link) => link.targetCardId !== cardId),
          },
        };
      });
      if (result.updated) {
        referenceUpdates.push({
          id: card.id,
          previousUpdatedAt,
          updatedAt: result.card.updatedAt,
        });
      }
    }
    return referenceUpdates;
  }

  async create(
    input: WorkboardLinkedCreateInput,
    scope?: WorkboardMutationScope,
    assertOwnerCurrent?: () => void,
    onClassifications?: WorkboardUpdateCardOptions["onClassifications"],
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      () => this.createDirect(input, scope, { onClassifications }),
      assertOwnerCurrent,
    );
  }

  /**
   * The one palette gate for card label writes: create and the shared update path
   * both call it. It refuses before the card write and stores palette changes only
   * after that write lands, so a rejected or conflicting write leaves the palette as is.
   */
  private async prepareCardClassifications(params: {
    boardId: string;
    previousLabels: readonly string[];
    labels: readonly string[];
    replaces: unknown;
    boardCards?: readonly WorkboardCard[];
  }): Promise<{ labels: string[]; commit: () => Promise<WorkboardClassificationChange> }> {
    const palette = await this.seedClassificationsDirect(params.boardId, params.boardCards);
    const { labels, change, changed } = applyWorkboardCardClassifications({ ...params, palette });
    return {
      labels,
      commit: async () => {
        if (changed) {
          await this.writeClassificationsDirect(params.boardId, change.classifications);
        }
        return change;
      },
    };
  }

  protected async createDirect(
    input: WorkboardLinkedCreateInput,
    scope?: WorkboardMutationScope,
    options: Pick<WorkboardUpdateCardOptions, "onClassifications"> & {
      cardId?: string;
      insertIfAbsent?: boolean;
    } = {},
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const requestedStatus = normalizeStatus(input.status, "todo");
    const cards = await this.list();
    const parents = normalizeStringList(input.parents, "parents", 120);
    const automation = normalizeCardAutomation(input);
    const heldBySchedule =
      Boolean(automation?.scheduledAt && automation.scheduledAt > now) &&
      requestedStatus !== "blocked";
    let status: WorkboardStatus = heldBySchedule ? "scheduled" : requestedStatus;
    let heldByDependencies = false;
    // A requested `review` records finished work, which dependencies never hide.
    if (parents.length > 0 && status === "running") {
      status = "todo";
      heldByDependencies = true;
    }
    if (automation?.idempotencyKey) {
      const existing = cards.find(
        (card) =>
          card.metadata?.automation?.idempotencyKey === automation.idempotencyKey &&
          card.metadata?.automation?.tenant === automation.tenant &&
          cardBoardId(card) === (automation.boardId ?? "default"),
      );
      if (existing) {
        return existing;
      }
    }
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    const parentCards = parents.map((parentId) => {
      const parent = cardsById.get(parentId);
      if (!parent) {
        throw new Error(`card not found: ${parentId}`);
      }
      assertCanMutateClaimedCard(parent, scope);
      return parent;
    });
    const childAutomation =
      parents.length === 1
        ? { ...automation, createdByCardId: automation?.createdByCardId ?? parents[0] }
        : automation;
    const normalizedPosition = resolveNonNegativeIntegerOption(input.position, Number.NaN);
    const notes = normalizeNotes(input.notes);
    const agentId = normalizeOptionalString(input.agentId);
    const sessionKey = normalizeOptionalString(input.sessionKey);
    const runId = normalizeRunId(input.runId);
    const sourceUrl = normalizeOptionalString(input.sourceUrl);
    const normalizedExecution = normalizeExecution(input.execution);
    const execution =
      normalizedExecution?.status === "running" && (heldBySchedule || heldByDependencies)
        ? undefined
        : normalizedExecution;
    const startedAt =
      input.startedAt === undefined
        ? status === "running"
          ? now
          : undefined
        : normalizeTimestamp(input.startedAt, 0) || undefined;
    const completedAt =
      input.completedAt === undefined
        ? status === "done"
          ? now
          : undefined
        : normalizeTimestamp(input.completedAt, 0) || undefined;
    const metadata = normalizeMetadata(
      input.metadata,
      {
        templateId: normalizeTemplateId(input.templateId),
        ...(childAutomation ? { automation: childAutomation } : {}),
      },
      { allowMetadataDependencyLinks: false, allowArchivedAt: false },
    );
    const syncedMetadata = trimMetadataToBudget(
      syncExecutionAttemptMetadata(metadata, execution, now),
      // Same non-terminality as in `updateCard`: this trim runs after the guarded
      // `normalizeMetadata` and adds the attempt data, so a create carrying a review must
      // carry the flag here too or it would shed a comment for the review (R27/A9).
      { reviewWritten: reviewWrittenInPatch(input.metadata) },
    );
    const boardId = syncedMetadata.automation?.boardId ?? "default";
    const position = Number.isFinite(normalizedPosition)
      ? normalizedPosition
      : Math.max(
          0,
          ...cards
            .filter((card) => card.status === status && cardBoardId(card) === boardId)
            .map((card) => card.position),
        ) + POSITION_STEP;
    const classified = await this.prepareCardClassifications({
      boardId,
      previousLabels: [],
      labels: normalizeCappedStringList(input.labels, "labels"),
      replaces: input.replaces,
      boardCards: cards.filter((card) => cardBoardId(card) === boardId),
    });
    let card: WorkboardCard = {
      id: options.cardId ?? randomUUID(),
      title: normalizeTitle(input.title),
      status,
      priority: normalizePriority(input.priority, "normal"),
      labels: classified.labels,
      position,
      createdAt: now,
      updatedAt: now,
      events: [
        {
          id: randomUUID(),
          kind: "created",
          at: now,
          toStatus: status,
          ...(sessionKey ? { sessionKey } : {}),
          ...(runId ? { runId } : {}),
        },
      ],
      ...(notes ? { notes } : {}),
      ...(agentId ? { agentId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(execution ? { execution } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(!metadataIsEmpty(syncedMetadata) ? { metadata: syncedMetadata } : {}),
    };
    if (options.insertIfAbsent) {
      const inserted = await this.store.registerIfAbsent(card.id, { version: 1, card });
      if (!inserted) {
        const winner = await this.get(card.id);
        if (!winner) {
          throw new Error("captured session card disappeared during creation.");
        }
        return winner;
      }
    } else {
      await this.store.register(card.id, { version: 1, card });
    }
    const classificationChange = await classified.commit();
    options.onClassifications?.(classificationChange);
    for (const parent of parentCards) {
      card = await this.linkCardsDirect(parent.id, card.id, now, {
        allowStatusOnlyActiveChild: true,
        scope,
      });
    }
    return card;
  }

  async captureSession(input: WorkboardLinkedCreateInput): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const sessionKey = normalizeOptionalString(input.sessionKey);
      if (!sessionKey) {
        throw new Error("sessionKey is required.");
      }
      const boardId = normalizeBoardId(input.boardId) ?? "default";
      await this.assertCardsBoard(boardId);
      const matches = (await readCards(this.store, { kind: "session", sessionKey }))
        .filter((card) => cardSessionKey(card) === sessionKey)
        .toSorted((left, right) => right.updatedAt - left.updatedAt);
      const existing = matches.find((card) => !card.metadata?.archivedAt) ?? matches[0];
      if (existing) {
        if (!existing.metadata?.archivedAt) {
          return existing;
        }
        const restored = await this.updateLatestCard(existing.id, (current) => {
          if (cardSessionKey(current) !== sessionKey) {
            throw new Error("captured session identity collision.");
          }
          return current.metadata?.archivedAt
            ? { metadata: { ...current.metadata, archivedAt: 0 } }
            : undefined;
        });
        return restored.card;
      }
      const digest = createHash("sha256")
        .update("openclaw.workboard.session-capture.v1\0")
        .update(sessionKey)
        .digest();
      // RFC 9562 version 8 keeps the documented UUID-shaped card id while the
      // existing primary key becomes the cross-process session identity.
      digest.writeUInt8((digest.readUInt8(6) & 0x0f) | 0x80, 6);
      digest.writeUInt8((digest.readUInt8(8) & 0x3f) | 0x80, 8);
      const hex = digest.toString("hex", 0, 16);
      const cardId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const winner = await this.createDirect({ ...input, boardId, parents: undefined }, undefined, {
        cardId,
        insertIfAbsent: true,
      });
      if (cardSessionKey(winner) !== sessionKey) {
        throw new Error("captured session identity collision.");
      }
      return winner;
    });
  }

  async update(
    id: string,
    patch: WorkboardCardPatch,
    options: Pick<
      WorkboardUpdateCardOptions,
      "expectedUpdatedAt" | "onClassifications" | "agentId" | "interaction"
    > = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      async () =>
        // Operator-only: Gateway, CLI and bulk edits. Agent tools route only
        // label, priority and parallelism patches here.
        await this.updateCard(await this.requireCard(id), patch, {
          actor: null,
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
          expectedUpdatedAt: options.expectedUpdatedAt,
          onClassifications: options.onClassifications,
          agentId: options.agentId,
          interaction: options.interaction,
        }),
    );
  }

  protected async updateCard(
    existing: WorkboardCard,
    patch: WorkboardCardPatch,
    options: WorkboardUpdateCardOptions = {},
  ): Promise<WorkboardCard> {
    if (
      options.expectedUpdatedAt !== undefined &&
      existing.updatedAt !== options.expectedUpdatedAt
    ) {
      throw new WorkboardCardConflictError(existing);
    }
    const statusWrite = resolveLifecycleStatusWrite(existing, patch);
    if (!statusWrite) {
      return existing;
    }
    const { effectivePatch, hasFreshLifecycleStatusSource } = statusWrite;
    const status = normalizeStatus(effectivePatch.status, existing.status);
    const now = Math.max(Date.now(), existing.updatedAt + 1);
    const startedAt =
      effectivePatch.startedAt === undefined
        ? status === "running"
          ? (existing.startedAt ?? now)
          : existing.startedAt
        : normalizeTimestamp(effectivePatch.startedAt, 0) || undefined;
    const completedAt =
      effectivePatch.completedAt === undefined
        ? status === "done"
          ? (existing.completedAt ?? now)
          : undefined
        : normalizeTimestamp(effectivePatch.completedAt, 0) || undefined;
    const sessionKey =
      effectivePatch.sessionKey === undefined
        ? existing.sessionKey
        : normalizeOptionalString(effectivePatch.sessionKey);
    let execution =
      effectivePatch.execution === undefined
        ? effectivePatch.sessionKey === undefined
          ? existing.execution
          : syncExecutionSessionKey(existing.execution, sessionKey)
        : normalizeExecution(effectivePatch.execution);
    let metadata = normalizeWithoutEvidence(effectivePatch.metadata, existing, options);
    // The guard has to hold for the whole write, not only where the patch was normalized:
    // `normalizeMetadata` is the *first* of several metadata trims this write runs through,
    // and the ones below add card data of their own (the interaction stamp, the automation
    // patch, the execution-attempt sync, a settle notification). Reaching them without the
    // flag is how a single write carrying a review *and* another field shed a comment and a
    // proof to make room for the review (R27/A9) - measured 2026-11-20. Same reader as the
    // resolution inside `normalizeMetadata`, so both answer alike for one write.
    const metadataWriteOptions = {
      ...options,
      reviewWritten: reviewWrittenInPatch(effectivePatch.metadata, existing.metadata?.review),
    };
    // A card-bound turn records which session is editing the card. Reference data
    // only (like the voice board binding): `startedAt` keeps the first turn of an
    // existing link, `updatedAt` moves on every turn, and nothing here is read as
    // execution or as authority. Absent for operator, CLI, and unbound writes.
    if (options.interaction) {
      const stamp = options.interaction;
      const nextInteraction = normalizeInteraction({
        sessionKey: stamp.sessionKey,
        agentId: stamp.agentId,
        surface: stamp.surface,
        startedAt: metadata.interaction?.startedAt ?? stamp.at,
        updatedAt: stamp.at,
      });
      if (nextInteraction) {
        metadata = trimMetadataToBudget(
          { ...metadata, interaction: nextInteraction },
          metadataWriteOptions,
        );
      }
    }
    if (status !== existing.status && !hasFreshLifecycleStatusSource) {
      ({ execution, metadata } = settleManualStatusTransition({
        existing,
        status,
        execution,
        metadata,
        now,
        // Only the operator's own settle (null actor: operator or system) stamps
        // acceptance; a reviewer's acceptance leaves the result unseen for the operator.
        acceptedByOperator: options.actor === null,
        nextNotificationSequence: () => this.nextNotificationSequence(now),
        preserveProofId: options.preserveProofId,
        // The settle appends a notification and runs its own trim; without the flag that
        // trim is unguarded and would shed a comment for the review in the same write.
        reviewWritten: metadataWriteOptions.reviewWritten,
      }));
    }
    const automationPatch: Record<string, unknown> = {};
    for (const key of [
      "tenant",
      "boardId",
      "createdByCardId",
      "idempotencyKey",
      "skills",
      "workspace",
      "workspaceAccess",
      "maxRuntimeSeconds",
      "maxRetries",
      "parallelizable",
      "maxConcurrentPerOwner",
      "dispatchMode",
      "scheduledAt",
      "acceptanceSeenAt",
      "decisionOptions",
      "ask",
      "askKind",
    ] as const) {
      if (Object.hasOwn(effectivePatch, key) && effectivePatch[key] !== undefined) {
        automationPatch[key] = effectivePatch[key];
      }
    }
    if (Object.keys(automationPatch).length > 0) {
      metadata = trimMetadataToBudget(
        {
          ...metadata,
          automation: normalizeAutomationPatch(automationPatch, metadata.automation),
        },
        metadataWriteOptions,
      );
    }
    const next = definedFields<WorkboardCard>({
      ...existing,
      title:
        effectivePatch.title === undefined ? existing.title : normalizeTitle(effectivePatch.title),
      notes:
        effectivePatch.notes === undefined ? existing.notes : normalizeNotes(effectivePatch.notes),
      status,
      priority: normalizePriority(effectivePatch.priority, existing.priority),
      labels:
        effectivePatch.labels === undefined
          ? existing.labels
          : normalizeCappedStringList(effectivePatch.labels, "labels"),
      agentId:
        effectivePatch.agentId === undefined
          ? existing.agentId
          : normalizeOptionalString(effectivePatch.agentId),
      sessionKey,
      runId:
        effectivePatch.runId === undefined ? existing.runId : normalizeRunId(effectivePatch.runId),
      sourceUrl:
        effectivePatch.sourceUrl === undefined
          ? existing.sourceUrl
          : normalizeOptionalString(effectivePatch.sourceUrl),
      execution,
      metadata:
        effectivePatch.templateId === undefined
          ? metadata
          : { ...metadata, templateId: normalizeTemplateId(effectivePatch.templateId) },
      position:
        effectivePatch.position === undefined
          ? existing.position
          : resolveNonNegativeIntegerOption(effectivePatch.position, existing.position),
      updatedAt: now,
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    });
    next.metadata = withStoredEvidence(
      syncExecutionAttemptMetadata(next.metadata ?? {}, execution, now),
      metadataWriteOptions,
      existing,
    );
    // Placement stays fixed from claim through execution settlement. Check the
    // existing owner after normalizing the entire patch so metadata replacement
    // or a simultaneous claim/status clear cannot bypass the launch fence.
    if (
      workboardCardIsExternallyDispatched(existing) !== workboardCardIsExternallyDispatched(next) &&
      isActiveDependencyTarget(existing, { allowStatusOnly: true })
    ) {
      throw new Error(
        "dispatch mode cannot change while a claim or execution owns the card; complete, block, or reclaim it first.",
      );
    }
    const event = options.event ?? updateEvent(existing, next);
    next.events = appendEvent(
      next,
      options.agentId ? { ...event, agentId: options.agentId } : event,
      options.eventAt ?? now,
    );
    if (options.enforceStatusHolds && effectivePatch.status !== undefined) {
      await this.assertActiveStatusAllowed(existing, next, now);
    }
    if (status !== "done") {
      delete next.completedAt;
    }
    if (effectivePatch.startedAt !== undefined && !startedAt) {
      delete next.startedAt;
    }
    if (effectivePatch.completedAt !== undefined && !completedAt) {
      delete next.completedAt;
    }
    if (metadataIsEmpty(next.metadata)) {
      delete next.metadata;
    }
    assertCanSettlePendingResult(existing, next, options.actor);
    // Writes that leave labels alone (status, metadata, claims) never touch the palette.
    const classified =
      effectivePatch.labels === undefined && effectivePatch.replaces === undefined
        ? undefined
        : await this.prepareCardClassifications({
            boardId: cardBoardId(next),
            previousLabels: existing.labels,
            labels: next.labels,
            replaces: effectivePatch.replaces,
          });
    if (classified) {
      next.labels = classified.labels;
    }
    const expectedUpdatedAt = options.expectedUpdatedAt ?? existing.updatedAt;
    const nextEntry: PersistedWorkboardCard = { version: 1, card: next };
    let updated: boolean;
    if (options.ownerSlot) {
      const result = await this.store.claimIfOwnerAvailable(
        next.id,
        nextEntry,
        expectedUpdatedAt,
        options.ownerSlot,
      );
      if (result === "owner_busy") {
        throw new Error(`Owner ${options.ownerSlot.ownerId} already has active Workboard work.`);
      }
      updated = result === "updated";
    } else {
      updated = await this.store.registerIfUpdatedAt(next.id, nextEntry, expectedUpdatedAt);
    }
    if (updated) {
      await this.deleteDetachedAttachments(existing, next);
      if (classified) {
        const classificationChange = await classified.commit();
        options.onClassifications?.(classificationChange);
      }
      return next;
    }
    const current = await this.get(next.id);
    if (!current) {
      throw new Error(`card not found: ${existing.id}`);
    }
    throw new WorkboardCardConflictError(current);
  }

  private async assertActiveStatusAllowed(
    existing: WorkboardCard,
    next: WorkboardCard,
    now: number,
  ): Promise<void> {
    if (
      next.status !== "ready" &&
      next.status !== "running" &&
      next.status !== "review" &&
      next.status !== "done"
    ) {
      return;
    }
    // Dependencies gate starts (`ready`/`running`) and acceptance (`done`); they never
    // block recording completion (`review`). The schedule hold stays in force for every
    // gated status except `done`.
    const parents = cardParentIds(next);
    if (next.status !== "review" && parents.length > 0 && !(await this.parentsDone(parents))) {
      throw new Error("card dependencies are not done.");
    }
    if (next.status === "done") {
      return;
    }
    const scheduledAt = next.metadata?.automation?.scheduledAt;
    if ((scheduledAt && scheduledAt > now) || (existing.status === "scheduled" && !scheduledAt)) {
      throw new Error("card is scheduled for later.");
    }
  }

  async delete(
    id: string,
    options: { expectedUpdatedAt?: number } = {},
  ): Promise<WorkboardDeleteResult> {
    return await this.enqueueMutation(async () => {
      const cardId = id.trim();
      const deleted =
        options.expectedUpdatedAt === undefined
          ? await this.store.delete(cardId)
          : await this.store.deleteIfUpdatedAt(cardId, options.expectedUpdatedAt);
      if (!deleted) {
        if (options.expectedUpdatedAt !== undefined) {
          const current = await this.get(cardId);
          if (current) {
            throw new WorkboardCardConflictError(current);
          }
        }
        return { deleted: false };
      }
      for (const entry of await this.subscriptionStore.entries()) {
        if (entry.value.subscription.cardId === cardId) {
          await this.subscriptionStore.delete(entry.key);
        }
      }
      const referenceUpdates = await this.removeReferencesToCard(cardId);
      return {
        deleted: true,
        ...(referenceUpdates.length > 0 ? { referenceUpdates } : {}),
      };
    });
  }

  async addComment(
    id: string,
    input: WorkboardCommentInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const body = normalizeBoundedString(input.body, undefined, 2000, "comment body");
    if (!body) {
      throw new Error("comment body is required.");
    }
    const comment = { id: randomUUID(), body, createdAt: now };
    return await this.updateMetadata(
      id,
      (existing) => {
        assertCanMutateClaimedCard(existing, scope);
        return {
          ...existing.metadata,
          comments: [...(existing.metadata?.comments ?? []), comment].slice(-MAX_CARD_COMMENTS),
        };
      },
      { agentId: scope?.agentId, interaction: scope?.interaction },
    );
  }

  async addLink(id: string, input: WorkboardLinkInput): Promise<WorkboardCard> {
    const now = Date.now();
    const targetCardId = normalizeBoundedString(input.targetCardId, undefined, 120, "link target");
    const url = normalizeBoundedString(input.url, undefined, 2000, "link URL");
    const title = normalizeBoundedString(input.title, undefined, 180, "link title");
    if (!targetCardId && !url) {
      throw new Error("link targetCardId or url is required.");
    }
    const type = normalizeLinkType(input.type, "relates_to");
    if (type === "parent" || type === "child") {
      throw new Error("parent and child dependency links must use linkDependency.");
    }
    const link: WorkboardLink = {
      id: randomUUID(),
      type,
      createdAt: now,
      ...(targetCardId ? { targetCardId } : {}),
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
    };
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      links: appendLinkPreservingDependencies(existing.metadata?.links ?? [], link),
    }));
  }

  async linkCards(
    parentId: string,
    childId: string,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(() =>
      this.linkCardsDirect(parentId, childId, Date.now(), { scope }),
    );
  }

  protected async linkCardsDirect(
    parentId: string,
    childId: string,
    now = Date.now(),
    options: { allowStatusOnlyActiveChild?: boolean; scope?: WorkboardMutationScope } = {},
  ): Promise<WorkboardCard> {
    if (parentId.trim() === childId.trim()) {
      throw new Error("parent and child cards must differ.");
    }
    const parent = await this.get(parentId);
    const child = await this.get(childId);
    if (!parent) {
      throw new Error(`card not found: ${parentId}`);
    }
    if (!child) {
      throw new Error(`card not found: ${childId}`);
    }
    assertCanMutateClaimedCard(parent, options.scope);
    assertCanMutateClaimedCard(child, options.scope);
    if (child.status === "done" || child.status === "blocked") {
      const parentIds = [...cardParentIds(child), parent.id].filter(
        (id, index, ids) => ids.indexOf(id) === index,
      );
      if (!(await this.parentsDone(parentIds))) {
        throw new Error("terminal child cards cannot gain incomplete parent dependencies.");
      }
    }
    if (isActiveDependencyTarget(child, { allowStatusOnly: options.allowStatusOnlyActiveChild })) {
      throw new Error("active child cards cannot gain parent dependencies.");
    }
    if (await this.dependsOn(parent.id, child.id)) {
      throw new Error("dependency link would create a cycle.");
    }
    const linkTo = (card: WorkboardCard, targetCardId: string, type: "parent" | "child") => {
      const links = card.metadata?.links ?? [];
      return links.some((link) => link.type === type && link.targetCardId === targetCardId)
        ? links
        : appendLinkPreservingDependencies(links, {
            id: randomUUID(),
            type,
            targetCardId,
            createdAt: now,
          });
    };
    const nextParentLinks = linkTo(parent, child.id, "child");
    const nextChildLinks = linkTo(child, parent.id, "parent");
    await this.updateCard(parent, {
      metadata: { ...parent.metadata, links: nextParentLinks },
    });
    const nextChild = await this.updateCard(child, {
      metadata: { ...child.metadata, links: nextChildLinks },
    });
    return await this.promoteDependencyReady(nextChild);
  }

  async unlinkCards(
    parentId: string,
    childId: string,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(() => this.unlinkCardsDirect(parentId, childId, { scope }));
  }

  /**
   * Removes one dependency pair: the parent's `child` link to `childId` and the
   * child's `parent` link to `parentId`. Each side is filtered against exactly
   * one target, so every other link (including other parent/child pairs) survives
   * byte-for-byte - unlike the generic metadata path, which reinstates dependency
   * links from the old card and therefore cannot remove them.
   *
   * A side without the link skips its write, so a repeated unlink is a no-op:
   * no event, no `updatedAt` bump. Purely structural: this never calls
   * `promoteDependencyReady`, because dropping a gate is not dropping work - the
   * caller moves or completes the card next.
   */
  protected async unlinkCardsDirect(
    parentId: string,
    childId: string,
    options: { scope?: WorkboardMutationScope } = {},
  ): Promise<WorkboardCard> {
    if (parentId.trim() === childId.trim()) {
      throw new Error("parent and child cards must differ.");
    }
    const parent = await this.requireCard(parentId);
    const child = await this.requireCard(childId);
    assertCanMutateClaimedCard(parent, options.scope);
    assertCanMutateClaimedCard(child, options.scope);
    const withoutDependencyLink = (
      current: WorkboardCard,
      type: "parent" | "child",
      targetCardId: string,
    ): WorkboardMetadata | undefined => {
      const links = current.metadata?.links ?? [];
      const next = links.filter(
        (link) => !(link.type === type && link.targetCardId === targetCardId),
      );
      return next.length === links.length ? undefined : { ...current.metadata, links: next };
    };
    await this.updateMetadataDirect(
      parent.id,
      (current) => withoutDependencyLink(current, "child", child.id),
      { event: { kind: "unlinked" } },
    );
    return await this.updateMetadataDirect(
      child.id,
      (current) => withoutDependencyLink(current, "parent", parent.id),
      { event: { kind: "unlinked" } },
    );
  }

  protected async parentsDone(parentIds: readonly string[]): Promise<boolean> {
    const statusById = new Map(
      (await this.store.listCardStatuses(parentIds)).map((card) => [card.id, card.status]),
    );
    return parentIds.every((id) => statusById.get(id) === "done");
  }

  private async dependencyTargetStatus(card: WorkboardCard, now: number): Promise<WorkboardStatus> {
    const scheduledAt = card.metadata?.automation?.scheduledAt;
    const parents = cardParentIds(card);
    if (card.status === "scheduled" && !scheduledAt) {
      return "scheduled";
    }
    if (parents.length === 0) {
      if (scheduledAt && scheduledAt > now && isDependencyPromotableStatus(card.status)) {
        return "scheduled";
      }
      return card.status === "scheduled" ? "ready" : card.status;
    }
    const parentsDone = await this.parentsDone(parents.map((parentId) => parentId.trim()));
    if (!isDependencyPromotableStatus(card.status)) {
      return card.status;
    }
    if (scheduledAt && scheduledAt > now) {
      return "scheduled";
    }
    return parentsDone ? "ready" : "todo";
  }

  private async dependsOn(cardId: string, targetParentId: string): Promise<boolean> {
    const cards = new Map((await this.list()).map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === targetParentId) {
        return true;
      }
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      const card = cards.get(id);
      return Boolean(card && cardParentIds(card).some(visit));
    };
    return visit(cardId);
  }

  protected async recordOrchestrationCandidate(
    card: WorkboardCard,
    now: number,
  ): Promise<WorkboardCard> {
    const result = await this.updateLatestCard(card.id, (current) => ({
      metadata: {
        ...current.metadata,
        workerLogs: [
          ...(current.metadata?.workerLogs ?? []),
          {
            id: randomUUID(),
            level: "info" as const,
            message:
              "Auto orchestration marked this triage card for specification or decomposition.",
            createdAt: now,
          },
        ].slice(-MAX_CARD_WORKER_LOGS),
        workerProtocol: {
          state: "idle" as const,
          updatedAt: now,
          detail: "Awaiting workboard_specify or workboard_decompose.",
        },
      },
    }));
    return result.card;
  }

  protected async promoteDependencyReady(
    card: WorkboardCard,
    now = Date.now(),
  ): Promise<WorkboardCard> {
    if (card.metadata?.archivedAt) {
      return card;
    }
    const target = await this.dependencyTargetStatus(card, now);
    if (target === card.status) {
      return card;
    }
    return await this.updateCard(card, { status: target });
  }
}

export class WorkboardCardConflictError extends Error {
  constructor(readonly current: WorkboardCard) {
    super("Card changed while you were editing. Review the latest values and retry.");
    this.name = "WorkboardCardConflictError";
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
