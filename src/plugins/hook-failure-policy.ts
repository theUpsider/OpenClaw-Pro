/**
 * Per-hook failure policy resolution.
 *
 * The standard runner used to decide fail-open vs fail-closed from a single
 * Gateway-owned table keyed only by hook name. Operators could therefore not
 * make an outbound guard (message_sending / reply_payload_sending) fail closed
 * without patching core: a guard timeout silently let the message through.
 *
 * This module resolves the effective policy per registered handler, in the same
 * precedence order already used for hook timeouts:
 *
 *   plugins.entries.<id>.hooks.failurePolicies.<hookName>
 *     -> plugins.entries.<id>.hooks.failurePolicy
 *       -> api.on(name, handler, { failurePolicy })
 *         -> Gateway per-hook default
 *           -> "fail-open"
 */
/** What happens when a registration throws or exceeds its timeout. */
export type HookFailurePolicy = "fail-open" | "fail-closed";

/** Narrow config slice so this leaf module does not depend on registry-state. */
export type PluginHookFailurePolicyConfig = {
  /** Default failure policy for this plugin's typed hooks. */
  failurePolicy?: HookFailurePolicy;
  /** Per-hook failure-policy overrides keyed by typed hook name. */
  failurePolicies?: Record<string, HookFailurePolicy>;
};

export const isHookFailurePolicy = (value: unknown): value is HookFailurePolicy =>
  value === "fail-open" || value === "fail-closed";

/**
 * Thrown when a handler fails (or times out) under a fail-closed policy.
 *
 * Consumers that previously swallowed every hook error must distinguish this
 * from an ordinary fail-open miss so they can block the guarded operation.
 * Delivery paths treat it as "do not send", not "send the unguarded payload".
 */
export class HookFailureClosedError extends Error {
  readonly hookName: string;
  readonly pluginId: string;

  constructor(params: { hookName: string; pluginId: string; message: string; cause?: unknown }) {
    super(params.message, { cause: params.cause });
    this.name = "HookFailureClosedError";
    this.hookName = params.hookName;
    this.pluginId = params.pluginId;
  }
}

/** Finds a HookFailureClosedError through Error.cause chains and AggregateError members. */
export function unwrapHookFailureClosedError(error: unknown): HookFailureClosedError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof HookFailureClosedError) {
      return current;
    }
    if (current instanceof AggregateError) {
      for (const member of current.errors) {
        const found = unwrapHookFailureClosedError(member);
        if (found) {
          return found;
        }
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * The policy explicitly configured for one registration: operator config first,
 * then the plugin's own `api.on(..., { failurePolicy })`. Undefined when nothing
 * is configured, so the registrar never bakes a fallback into the registration
 * and the runner still reaches the Gateway per-hook default.
 */
export function resolveConfiguredHookFailurePolicy(params: {
  hookName: string;
  policy?: PluginHookFailurePolicyConfig;
  registrationPolicy?: HookFailurePolicy;
}): HookFailurePolicy | undefined {
  return (
    params.policy?.failurePolicies?.[params.hookName] ??
    params.policy?.failurePolicy ??
    params.registrationPolicy
  );
}

/** Resolve the effective failure policy, falling back to the Gateway default. */
export function resolveHookFailurePolicy(params: {
  hookName: string;
  policy?: PluginHookFailurePolicyConfig;
  registrationPolicy?: HookFailurePolicy;
  defaultPolicy?: HookFailurePolicy;
}): HookFailurePolicy {
  return resolveConfiguredHookFailurePolicy(params) ?? params.defaultPolicy ?? "fail-open";
}
