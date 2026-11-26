import { hasGlobalHooks } from "./hook-runner-global.js";
import type { PluginHookReplyDispatchKind } from "./hook-types.js";

const RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS = [
  "before_dispatch",
  "before_agent_run",
  "before_message_write",
  "reply_dispatch",
] as const;

/**
 * Admission-unsafe hooks that refuse a Goal start or resume.
 *
 * `before_agent_run` is excluded: it gates the agent run rather than owning the reply
 * or the durable transcript write, and it re-runs inside the recovered turn's normal
 * hook pipeline. Treating it as unsafe refused every Goal on a deployment with a
 * globally registered execution gate (for example a document-scope guard), even though
 * such a host uses no native Codex runtime. The remaining hooks still refuse the Goal:
 * reply-claiming dispatch hooks cannot replay an interrupted turn, and a write gate can
 * reject the durable user turn the Goal commit depends on.
 */
const RESTART_RECOVERY_UNSAFE_GOAL_ADMISSION_HOOKS = [
  "before_dispatch",
  "before_message_write",
  "reply_dispatch",
] as const;

/**
 * First admission-unsafe hook for ordinary restart-safe chat admission.
 *
 * `before_agent_reply` is intentionally absent: initial admission defers it until
 * after its durable checkpoint. `reply_dispatch` is dispatch-scoped, so an ACP-only
 * dispatch hook does not disqualify an agent turn.
 */
export function findRestartRecoveryUnsafeChatAdmissionHook(
  dispatchKind: PluginHookReplyDispatchKind,
): (typeof RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS)[number] | undefined {
  return RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS.find((hookName) =>
    hookName === "reply_dispatch"
      ? hasGlobalHooks(hookName, { dispatchKind })
      : hasGlobalHooks(hookName),
  );
}

/** First admission-unsafe hook that refuses a Goal; see the goal hook set above. */
export function findRestartRecoveryUnsafeGoalAdmissionHook(
  dispatchKind: PluginHookReplyDispatchKind,
): (typeof RESTART_RECOVERY_UNSAFE_GOAL_ADMISSION_HOOKS)[number] | undefined {
  return RESTART_RECOVERY_UNSAFE_GOAL_ADMISSION_HOOKS.find((hookName) =>
    hookName === "reply_dispatch"
      ? hasGlobalHooks(hookName, { dispatchKind })
      : hasGlobalHooks(hookName),
  );
}
