import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { GOAL_VERIFICATION_DEFAULT_MAX_CONTINUATION_TURNS } from "../../config/sessions/goal-verification-config.js";
import { accountSessionGoalUsage } from "../../config/sessions/goals-transitions.js";
import { markSessionGoalAttention } from "../../config/sessions/goals.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getInProcessGatewayRequestContext } from "../../plugins/runtime/gateway-request-scope.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";
import {
  buildAttentionNotice,
  decideGoalTurnEndContinuation,
  type DecideGoalTurnEndParams,
  type GoalTurnEndDecision,
} from "./goal-verification-coordinator.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue/enqueue.js";
import { isFollowupRunAborted, type FollowupRun, type QueueSettings } from "./queue/types.js";
import { runAfterReplyOperationClear, type ReplyOperation } from "./reply-run-registry.js";

const goalVerificationLog = createSubsystemLogger("auto-reply/goal-verification");

/**
 * FAIL-OPEN boundary for the opt-in verification gate: verification decides
 * whether a goal may complete, never whether the session's turn survives. Any
 * bookkeeping failure (a store write after a verifier timeout, a registry error)
 * is logged and the turn continues exactly as it would have without the gate —
 * no completion authorized, no stuck session, no rejected finalization.
 */
async function goalTurnEndDecisionBeforeQueue(
  params: DecideGoalTurnEndParams,
): Promise<GoalTurnEndDecision> {
  try {
    return await decideGoalTurnEndContinuation(params);
  } catch (error) {
    goalVerificationLog.warn("goal verification bookkeeping failed; continuing today's flow", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { queue: true };
  }
}

export type GoalContinuation = Pick<SessionEntry, "sessionId" | "lifecycleRevision"> & {
  goalId: string;
  workerGoal?: true;
  localCodexGoal?: true;
  /**
   * Bounded recovery bookkeeping for one queued wake: how many times admission
   * deferred this exact continuation at a transient gate. Lives on the
   * continuation (inside the queued run) so every drain retry of the same item
   * counts, while a fresh continuation turn starts again at zero.
   */
  wakeDeferrals?: number;
};

/**
 * Defer cap for one automatic wake. Past this many transient refusals the wake
 * is not retried again; it stops visibly (attention + notice) instead of
 * spinning while the goal would otherwise stay silently stuck.
 */
export const GOAL_WAKE_DEFER_LIMIT = 5;

/**
 * Durable, visible stop for an automatic wake that kept being refused while the
 * goal stayed active. Uses the same attention marker and one-time notice as the
 * continuation/attempt caps so the stop is surfaced by `/goal status` and can be
 * resumed, instead of the loop vanishing without a trace.
 *
 * Returns the one-time notice text when this call recorded the marker (the first
 * caller wins), or `undefined` when a marker already existed / the goal moved.
 */
export async function markGoalWakeSuppressed(params: {
  sessionKey: string;
  storePath: string;
  goalId: string;
  objective: string;
  detail?: string;
  onNotice?: (text: string) => void | Promise<void>;
}): Promise<string | undefined> {
  const record = await markSessionGoalAttention({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    goalId: params.goalId,
    reason: "wake-suppressed",
    ...(params.detail ? { detail: params.detail } : {}),
    summary: "goal automation stopped: wake-suppressed",
  });
  if (!record.recorded) {
    return undefined;
  }
  const notice = buildAttentionNotice({
    objective: params.objective,
    reason: "wake-suppressed",
    missingPoints: [],
    verification: undefined,
    maxContinuationTurns: GOAL_VERIFICATION_DEFAULT_MAX_CONTINUATION_TURNS,
    ...(params.detail ? { detail: params.detail } : {}),
  });
  if (params.onNotice) {
    try {
      await params.onNotice(notice);
    } catch (error) {
      // The marker is already durable and surfaces through goal status, so a
      // failed notice is logged rather than allowed to turn the stop into an error.
      goalVerificationLog.warn("goal wake-suppressed notice could not be delivered", {
        sessionKey: params.sessionKey,
        goalId: params.goalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return notice;
}

async function resolveCodexGoalPlacement(params: {
  agentId?: string;
  sessionKey: string;
  sessionId: string;
  requiresWorker?: boolean;
}): Promise<"local" | "worker" | undefined> {
  const harness = getRegisteredAgentHarness("codex")?.harness;
  if (!harness) {
    return undefined;
  }
  const prepared =
    await getInProcessGatewayRequestContext()?.workerSessionPlacementService?.prepareSessionPlacement?.(
      params.sessionId,
    );
  if (!prepared) {
    return params.requiresWorker ? undefined : "local";
  }
  try {
    const pending = prepared.prepareRead();
    if (pending) {
      await pending;
    }
    const placement = prepared.current();
    if (!placement) {
      return params.requiresWorker ? undefined : "local";
    }
    if (
      placement.agentId !== params.agentId ||
      placement.sessionKey !== params.sessionKey ||
      placement.sessionId !== params.sessionId
    ) {
      return undefined;
    }
    if (placement.state === "local") {
      return params.requiresWorker ? undefined : "local";
    }
    return placement.executionMode === "remote-exec" &&
      harness.cloudPlacement?.mode === "remote-exec"
      ? "worker"
      : undefined;
  } finally {
    prepared.release();
  }
}

export function isGoalContinuationCurrent(
  continuation: GoalContinuation,
  entry: SessionEntry | undefined,
): boolean {
  const goal = entry && accountSessionGoalUsage(entry, Date.now());
  return Boolean(
    entry &&
    entry.sessionId === continuation.sessionId &&
    entry.lifecycleRevision === continuation.lifecycleRevision &&
    goal?.id === continuation.goalId &&
    goal.status === "active" &&
    !entry.abortedLastRun &&
    (entry.agentHarnessId === undefined ||
      entry.agentHarnessId === "openclaw" ||
      (entry.agentHarnessId === "codex" &&
        (continuation.workerGoal === true || continuation.localCodexGoal === true))),
  );
}

export async function isGoalContinuationPlacementCurrent(params: {
  continuation: GoalContinuation;
  agentId?: string;
  sessionKey: string;
  hasOperatorAuthority: boolean;
  requiresWorker: boolean;
}): Promise<boolean> {
  const { continuation } = params;
  if (!continuation.workerGoal && !continuation.localCodexGoal) {
    return true;
  }
  if (!params.hasOperatorAuthority || (continuation.localCodexGoal && params.requiresWorker)) {
    return false;
  }
  const placement = await resolveCodexGoalPlacement({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: continuation.sessionId,
    requiresWorker: continuation.workerGoal === true,
  });
  return continuation.workerGoal ? placement === "worker" : placement === "local";
}

function isGoalContinuationOutcome(result: EmbeddedAgentRunResult): boolean {
  const meta = result.meta;
  return (
    (meta.stopReason === "end_turn" || meta.stopReason === "stop") &&
    !meta.aborted &&
    !meta.error &&
    !meta.timeoutPhase &&
    !meta.yielded &&
    !meta.continuationPending &&
    !meta.pendingToolCalls?.length &&
    !result.acceptedSessionSpawns?.length &&
    !result.didSendDeterministicApprovalPrompt &&
    !result.payloads?.some((payload) => payload.isError)
  );
}

/** Queue custody, not a second scheduler, owns every automatic Goal turn. */
export async function enqueueGoalContinuation(params: {
  base: FollowupRun;
  result: EmbeddedAgentRunResult;
  initialGoalId?: string;
  expectedSession: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  sessionKey: string;
  storePath: string;
  reader?: SessionEntryCohortReader;
  queueKey: string;
  settings: QueueSettings;
  sourceRunId: string;
  operation: ReplyOperation;
  runFollowup: (run: FollowupRun) => Promise<void>;
  /**
   * Delivers the one-time "needs attention" notice when automation stops.
   * Callers route it through their own visible delivery path; absence only
   * affects a stopped loop's notice, never the goal state itself.
   */
  onNotice?: (text: string) => void | Promise<void>;
}): Promise<boolean> {
  const eligible = () =>
    !params.operation.abortSignal.aborted &&
    params.operation.result?.kind !== "failed" &&
    params.operation.result?.kind !== "aborted" &&
    !isFollowupRunAborted(params.base) &&
    getFollowupQueueDepth(params.queueKey) === 0;
  if (!isGoalContinuationOutcome(params.result) || !eligible()) {
    return false;
  }
  // Unsettled requester children are a *transient* gate: the requester's own
  // child-settle wake re-attempts this session once they finish, so refusing the
  // nudge here is recoverable rather than a silent stop. Admission additionally
  // defers a nudge that meets children appearing after it was queued.
  const { listUnsettledRequesterChildren } =
    await import("../../agents/subagents/registry/subagent-registry.js");
  const children = await listUnsettledRequesterChildren({
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.base.run.agentId,
  });
  if (children.length > 0 || !eligible()) {
    return false;
  }
  const entry = await readSessionEntryReadOnlyInWorker(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    undefined,
    params.reader,
  );
  params.base.operatorAuthority?.assertCurrent();
  if (!eligible() || !entry?.goal) {
    return false;
  }
  const codexPlacement =
    entry.agentHarnessId === "codex" && params.base.operatorAuthority
      ? await resolveCodexGoalPlacement({
          agentId: params.base.run.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.expectedSession.sessionId,
          requiresWorker: Boolean(params.base.run.config?.cloudWorkers?.requiredProfile),
        })
      : undefined;
  if (entry.agentHarnessId === "codex" && !codexPlacement) {
    return false;
  }
  params.base.operatorAuthority?.assertCurrent();
  if (!eligible()) {
    return false;
  }
  const continuation: GoalContinuation = {
    ...params.expectedSession,
    goalId: params.initialGoalId ?? entry.goal.id,
    ...(codexPlacement === "worker" ? { workerGoal: true as const } : {}),
    ...(codexPlacement === "local" ? { localCodexGoal: true as const } : {}),
  };
  if (!isGoalContinuationCurrent(continuation, entry)) {
    return false;
  }
  const source = params.base.queuedFollowupReplyDisposition;
  if (source?.kind === "drop") {
    return false;
  }
  // Adversarial completion verification (opt-in; no I/O when the gate is off).
  // A non-passing verdict replaces the nudge with the missing points, and an
  // exhausted budget stops automation with a one-time visible notice.
  const decision = await goalTurnEndDecisionBeforeQueue({
    cfg: params.base.run.config ?? {},
    agentId: params.base.run.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    goal: entry.goal,
    result: params.result,
    executor: { provider: params.base.run.provider, model: params.base.run.model },
    // A continuation keeps its verdict; a user turn invalidates a stored one.
    goalContinuation: params.base.goalContinuation !== undefined,
    signal: params.operation.abortSignal,
  });
  if (!decision.queue) {
    if (decision.notice) {
      // Best-effort: the attention marker is already durable and the goal status
      // surfaces it, so only the first caller reaches here. A delivery failure is
      // recorded rather than swallowed — the stop must stay diagnosable — and it
      // must never turn a stopped loop into a failed turn.
      try {
        await params.onNotice?.(decision.notice);
      } catch (error) {
        goalVerificationLog.warn("goal stopped-loop notice could not be delivered", {
          sessionKey: params.sessionKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return false;
  }
  const base = params.base;
  const cancellation = new AbortController();
  const nudge: FollowupRun = {
    ...base,
    goalContinuation: continuation,
    prompt:
      decision.promptOverride ??
      formatSystemTurnPrompt(
        "Advance the active goal; keep it active until fully achieved. Use the current goal context, and verify the entire objective before marking it complete.",
      ),
    summaryLine: "goal-continuation",
    messageId: ["goal", continuation.sessionId, continuation.goalId, params.sourceRunId].join(":"),
    abortSignal: base.abortSignal
      ? AbortSignal.any([base.abortSignal, cancellation.signal])
      : cancellation.signal,
    enqueuedAt: Date.now(),
    disableCollectBatching: true,
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    sourceTurnId: undefined,
    currentInboundContext: undefined,
    images: undefined,
    imageOrder: undefined,
    media: undefined,
    turnAdoptionLifecycle: undefined,
    replyOperationRunStates: undefined,
    onQueueDisposition: undefined,
    steerPending: undefined,
    strandedReplyRetry: undefined,
    stalledTurnRecovery: undefined,
    queuedFollowupReplyDisposition:
      source?.kind === "deliver"
        ? { kind: "deliver", deliver: source.deliver.createSourceRetry?.() ?? source.deliver }
        : source,
    run: {
      ...base.run,
      inputProvenance: { kind: "internal_system", sourceTool: "session_goal_continue" },
      suppressNextUserMessagePersistence: true,
      skillLibraryAuthoring: base.run.skillLibraryAuthoring && {
        target: "personal",
        defaultTarget: "personal",
        multipleProfiles: base.run.skillLibraryAuthoring.multipleProfiles,
        bind: () => {},
        invoke: async () => {
          throw new SkillLibraryError(
            "AUTHORITY_EXPIRED",
            "Skill authoring requires a fresh user request after the previous turn settled.",
          );
        },
      },
    },
  };
  const enqueued = enqueueFollowupRun(
    params.queueKey,
    nudge,
    params.settings,
    "message-id",
    params.runFollowup,
    false,
  );
  if (enqueued) {
    // Model completion precedes source delivery. A later terminal handling failure
    // invalidates this queued candidate before the existing owner starts its drain.
    runAfterReplyOperationClear(params.operation, () => {
      if (params.operation.result?.kind !== "completed") {
        cancellation.abort();
      }
    });
  }
  return enqueued;
}
