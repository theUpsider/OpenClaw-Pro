import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type {
  FollowupRun,
  ReplyOperation,
  ReplyOperationRunState,
  ReplyPreRunRejectionCode,
} from "../../sessions/session-controller.contracts.js";
import { resolveAgentTurnExecutionStatus } from "./agent-runner-execution-status.js";
import type { SessionEventExecution } from "./session-event-contract.js";
export type {
  ReplyOperationRunState,
  ReplyPreRunRejectionCode,
} from "../../sessions/session-controller.contracts.js";
   * Per-turn fact: the reply gate judged that no visible reply is needed. The turn still runs;
   * only automatic source delivery is suppressed. It lives apart from `suppressDelivery` so the
   * gate verdict stays attributable; `resolveSourceReplyVisibilityPolicy` folds it into
   * `suppressDelivery` additively, never clearing sendPolicy or message_tool_only suppression.
  visibleReplySuppression?: "reply-gate";
  /** Dispatch owner hook that re-derives its delivery policy when the fact is set mid-turn. */
  onVisibleReplySuppression?: () => void;

// Carries this invocation's admission decision through reply option spreads so
// cleanup never infers it from whichever operation is active later.
export const REPLY_OPERATION_RUN_STATE = Symbol("openclaw.replyOperationRunState");

export type ReplyOptionsWithOperationRunState = {
  [REPLY_OPERATION_RUN_STATE]?: ReplyOperationRunState;
};

export function resolveReplyOperationRunState(
  options: object | undefined,
): ReplyOperationRunState | undefined {
  return (options as ReplyOptionsWithOperationRunState | undefined)?.[REPLY_OPERATION_RUN_STATE];
}

/** Either source owner can prevent its retained background work from adding delivery. */
export function resolveReplySessionEventDelivery(
  options: object | undefined,
  run: {
    internalEventExecution?: Pick<SessionEventExecution, "deliver">;
    sessionEventOrigin?: { deliver?: false };
  },
): false | undefined {
  return run.internalEventExecution?.deliver === false ||
    run.sessionEventOrigin?.deliver === false ||
    resolveReplyOperationRunState(options)?.sessionEventDelivery === false
    ? false
    : undefined;
}

export function recordReplyOperationAgentTurn(
  states: readonly ReplyOperationRunState[] | undefined,
  owner: ReplyOperation | undefined,
  outcome?:
    | { kind: "aborted" | "rejected" }
    | {
        kind: "settled";
        status: "ok" | "failed";
        result: Pick<
          EmbeddedAgentRunResult,
          "messagingToolSentTargets" | "asyncWorkStarted" | "acceptedSessionSpawns"
        >;
      },
): void {
  for (const state of states ?? []) {
    state.agentTurn = resolveAgentTurnExecutionStatus(
      outcome ?? (owner?.result?.kind === "aborted" ? owner.result : undefined),
    );
    if (outcome?.kind === "settled") {
      state.messagingToolSentTargets = outcome.result.messagingToolSentTargets;
      state.backgroundWorkStarted = Boolean(
        outcome.result.asyncWorkStarted || outcome.result.acceptedSessionSpawns?.length,
      );
    } else if (!owner || state.agentTurnOwner !== owner) {
      state.messagingToolSentTargets = undefined;
      state.backgroundWorkStarted = false;
    }
    state.agentTurnOwner = owner;
  }
}

export function recordReplyFollowupAdmission(
  state: ReplyOperationRunState | undefined,
  params: {
    explicitFollowup: boolean;
    requesterMismatch: boolean;
    collaborationBlocked?: boolean;
    unavailableSteer: boolean;
    followupRun: FollowupRun;
  },
): void {
  if (!state) {
    return;
  }
  state.admission = {
    status: "accepted",
    mode: "followup",
    ...(params.explicitFollowup
      ? { reason: "explicit-followup" as const }
      : params.collaborationBlocked
        ? { reason: "collaborative-steering-disabled" as const }
        : params.requesterMismatch
          ? { reason: "requester-mismatch" as const }
          : params.unavailableSteer &&
              params.followupRun.currentInboundEventKind !== "room_event" &&
              (!params.followupRun.run.inputProvenance ||
                params.followupRun.run.inputProvenance.kind === "external_user")
            ? { reason: "steering-unavailable" as const }
            : {}),
  };
}

export function recordReplyPreRunRejection(
  state: ReplyOperationRunState | undefined,
  rejection: ReplyPreRunRejectionCode | undefined,
): void {
  if (state && rejection) {
    state.preRunRejection ??= rejection;
  }
}

export function resolveReplyOperationAgentTurn(state: ReplyOperationRunState | undefined) {
  return isReplyOperationSuperseded(state?.agentTurnOwner) ? "superseded" : state?.agentTurn;
}

/** Records the reply-gate verdict for this turn and refreshes the dispatch delivery policy. */
export function suppressVisibleReply(state: ReplyOperationRunState | undefined): void {
  if (!state) {
    return;
  }
  state.visibleReplySuppression = "reply-gate";
  state.onVisibleReplySuppression?.();
}
