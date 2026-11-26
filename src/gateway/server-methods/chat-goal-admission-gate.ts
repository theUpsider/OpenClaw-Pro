import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { findRestartRecoveryUnsafeChatAdmissionHook } from "../../plugins/restart-recovery-hook-safety.js";
import { resolveSessionDispatchKind } from "../../sessions/session-key-utils.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/**
 * A Goal start/resume refused because an active admission hook owns chat admission.
 *
 * The restart-safe admission lists `before_dispatch`, `before_agent_run`,
 * `before_message_write`, and `reply_dispatch` as admission-unsafe. A deployment
 * plugin can register such a hook globally (for example a lane document-scope
 * `before_agent_run` guard), so the plausible-looking refusal is not about the
 * built-in runtime or session history it names. Naming the hook and tagging a typed
 * reason lets the Control UI show a definitive rejection instead of an unconfirmed
 * Goal that leaves a stuck "Retry resume".
 */
export function hasUnsafeChatAdmissionHook(sessionKey: string, entry?: SessionEntry): boolean {
  return (
    findRestartRecoveryUnsafeChatAdmissionHook(resolveSessionDispatchKind(sessionKey, entry)) !==
    undefined
  );
}

export function goalAdmissionGateError(): SessionGoalOperationError {
  return new SessionGoalOperationError(
    "admission-gate",
    "Goal start or resume is unavailable while an active execution hook owns chat admission (for example a document-scope gate). Retry once that hook no longer gates this session; a Goal otherwise needs the built-in OpenClaw runtime and an idle local session with recoverable history.",
  );
}

/**
 * The refusal for a Goal that no admission path accepted: the ambiguous hook case gets
 * its own typed, honest message; every other case keeps the historical runtime message.
 */
export function goalAdmissionRefusalError(
  sessionKey: string,
  entry?: SessionEntry,
): SessionGoalOperationError | Error {
  return hasUnsafeChatAdmissionHook(sessionKey, entry)
    ? goalAdmissionGateError()
    : new Error(
        "Goal start or resume requires the built-in OpenClaw runtime and an idle local session with recoverable history. This action is unavailable for native Codex and other external runtimes.",
      );
}

/**
 * Answer a typed Goal admission refusal; true when the response was sent.
 *
 * The wire shape is the same typed rejection the Goal receipt path uses, so the
 * Control UI classifies it as definitive instead of an unconfirmed Goal.
 */
export function respondGoalAdmissionRefusal(
  error: unknown,
  respond: GatewayRequestHandlerOptions["respond"],
): boolean {
  if (!(error instanceof SessionGoalOperationError)) {
    return false;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
      details: { code: "GOAL_OPERATION_REJECTED", reason: error.code },
    }),
  );
  return true;
}
