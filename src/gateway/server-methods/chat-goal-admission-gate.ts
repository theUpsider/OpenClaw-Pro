import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/**
 * The typed refusal for a Goal start/resume whose sole admission blocker is an active
 * admission hook.
 *
 * The restart-safe admission lists `before_dispatch`, `before_agent_run`,
 * `before_message_write`, and `reply_dispatch` as admission-unsafe, and a deployment plugin
 * may register one globally (for example a lane document-scope guard) even on a pure
 * OpenClaw-runtime host. The historical message names a built-in runtime it does not
 * reflect, and the Control UI shows that untyped refusal as an unconfirmed Goal stuck behind
 * "Retry resume". Thrown by the resolver only for the hook case; the caller keeps the
 * historical message for every other refusal.
 */
export function goalAdmissionGateError(): SessionGoalOperationError {
  return new SessionGoalOperationError(
    "admission-gate",
    "Goal start or resume is unavailable while an active execution hook owns chat admission (for example a document-scope gate). Retry once that hook no longer gates this session; a Goal otherwise needs the built-in OpenClaw runtime and an idle local session with recoverable history.",
  );
}

/** The historical refusal for a Goal refused by anything other than an admission hook. */
export function goalAdmissionRefusalError(): Error {
  return new Error(
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
