/**
 * Spawn-requester policy: the one gate a session passes before it starts a child run.
 *
 * Two rules answer the same question — may this session start this child — so a caller reads one
 * verdict instead of remembering two, and neither rule can be skipped by adding a later call site.
 */
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { resolvePathScopePolicy, uncoveredScopeEntries } from "./path-scope-policy.js";

/** Sender policy provenance is host-owned and survives delegated turns. */
export function resolveSenderRestrictedSpawnError(params: {
  inheritedToolPolicySource?: "sender";
  requesterAgentId?: string;
  targetAgentId?: string;
  visible?: boolean;
}): string | undefined {
  if (
    params.inheritedToolPolicySource === "sender" &&
    (params.visible || (params.targetAgentId && params.targetAgentId !== params.requesterAgentId))
  ) {
    return "This sender may only start hidden helpers of the same agent.";
  }
  return undefined;
}

/**
 * Refuse a spawn that would not carry the requester's path rules.
 *
 * A parent that hides operator-listed paths could otherwise delegate the read to a child. The check
 * resolves both models through the same owner the spawn plan uses, so a configured `subagents.model`
 * and a harmless alias are handled the same way the child will be.
 *
 * A child passes only when its own rules cover every path the requester hides. Unrelated entries on
 * the child's provider are not coverage: they would look like protection while the parent's path
 * stays readable for the child. ACP children cannot be verified to enforce the rules, so a
 * restricted requester never spawns one.
 */
export function resolvePathScopeSpawnRefusal(params: {
  /** Live spawn options name this field `config`, not `cfg`. */
  config?: OpenClawConfig;
  requesterAgentIdOverride?: string;
  /** The child's target agent; another agent resolves its own model, not the requester's. */
  targetAgentId?: string;
  requesterModel?: { provider?: string; model?: string };
  /** Explicit `sessions_spawn` model override, as supplied by the model. */
  modelOverride?: string;
  /** Spawn runtime; anything other than `acp` is treated as the native subagent path. */
  agentRuntime?: "native" | "acp" | "subagent";
}): string | undefined {
  // A caller that pins its config passes it; the Gateway runtime path deliberately omits it so
  // policy follows live config updates, and reads the live config elsewhere for exactly that
  // reason. Reading the same live config here is what makes this one gate one rule: the child's
  // model and rules are resolved from the live config too, so the verdict cannot disagree with the
  // run it admits. A null snapshot keeps the old "no config, nothing to honour" contract.
  const cfg = params.config ?? getRuntimeConfigSnapshot();
  const agentId = params.requesterAgentIdOverride?.trim();
  if (!cfg || !agentId) {
    // Without config or agent there cannot be a rule to honour, so nothing is carried away.
    return undefined;
  }

  // The requester's effective model: the reported one when the call path knows it, otherwise the
  // model this agent would run anyway. Both route through the owning selector, so a call path that
  // does not report a model (worker executor, HTTP invoke) is not treated as unrestricted.
  const reportedRequester = params.requesterModel;
  const resolvedRequester = reportedRequester?.provider
    ? { provider: reportedRequester.provider, model: reportedRequester.model ?? "" }
    : resolveEffectiveModel(cfg, agentId);
  const parentPolicy = resolvePathScopePolicy({
    cfg,
    agentId,
    modelProvider: resolvedRequester.provider,
    modelId: resolvedRequester.model,
  });
  // No rules anywhere for this agent, or none that match the requester's model: nothing to carry.
  if (!parentPolicy || parentPolicy.entries.length === 0) {
    return undefined;
  }

  if (params.agentRuntime === "acp") {
    return (
      "This session hides operator-listed paths, and an ACP child run does not enforce those rules. " +
      "Start the child as a native subagent, or drop the spawn."
    );
  }

  const childAgentId = params.targetAgentId?.trim() || agentId;
  const childSelection = resolveSubagentSpawnModelSelection({
    cfg,
    agentId: childAgentId,
    modelOverride: params.modelOverride,
    // The child inherits the requester's model only when it is the same agent and the model is known.
    inheritedModel:
      childAgentId === agentId
        ? { provider: resolvedRequester.provider, model: resolvedRequester.model }
        : undefined,
  });
  // The selector returns a resolved ref for a known model and a `provider/model` string otherwise.
  // A bare id that resolves to neither would make the split invent a provider, so that case is
  // refused below rather than compared against a provider the child will never run.
  const childRef = childSelection.resolvedModel ?? splitModelRef(childSelection.model);
  const childProviderResolved =
    childSelection.resolvedModel !== undefined || childSelection.model.includes("/");
  if (!childProviderResolved) {
    return (
      `This session hides operator-listed paths, and the child model "${childSelection.model}" ` +
      `names no provider, so its rules cannot be selected. Pass a provider-qualified model, or ` +
      `drop the spawn.`
    );
  }
  const childPolicy = resolvePathScopePolicy({
    cfg,
    agentId: childAgentId,
    modelProvider: childRef.provider,
    modelId: childRef.model,
  });

  // The child's rules must leave nothing of the requester's hidden set uncovered.
  const uncovered = uncoveredScopeEntries(parentPolicy, childPolicy);
  if (uncovered.length > 0) {
    // The count is safe to name; the paths are not. The refusal reaches the model, and naming a
    // concealed path would tell it exactly what the rules hide — the one thing they must not.
    return (
      `This session hides ${uncovered.length} operator-listed path rule(s) that a child on ` +
      `${childRef.provider} would not carry. Give that provider matching tools.pathScopes entries, ` +
      `or drop the spawn.`
    );
  }
  return undefined;
}

/** The model this agent would run when no caller reports one. */
function resolveEffectiveModel(
  cfg: OpenClawConfig,
  agentId: string,
): { provider: string; model: string } {
  // The agent's own default model, not the subagent selection: the latter prefers a configured
  // `subagents.model`, which would make a restricted requester look unrestricted and let the spawn
  // through. The spawn's own model is resolved separately, for the child side of the comparison.
  return resolveDefaultModelForAgent({ cfg, agentId });
}

/** Split a `provider/model` ref, tolerating a bare id. */
function splitModelRef(ref: string): { provider: string; model: string } {
  const separator = ref.indexOf("/");
  return separator === -1
    ? { provider: ref, model: "" }
    : { provider: ref.slice(0, separator), model: ref.slice(separator + 1) };
}

/** The one gate a requester passes before a spawn starts. */
export function resolveSpawnRequesterRefusal(params: {
  inheritedToolPolicySource?: "sender";
  requesterAgentId?: string;
  targetAgentId?: string;
  visible?: boolean;
  config?: OpenClawConfig;
  requesterAgentIdOverride?: string;
  requesterModel?: { provider?: string; model?: string };
  modelOverride?: string;
  agentRuntime?: "native" | "acp" | "subagent";
}): string | undefined {
  return resolveSenderRestrictedSpawnError(params) ?? resolvePathScopeSpawnRefusal(params);
}
