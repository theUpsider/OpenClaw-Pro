import type { resolveOpenAIRequestReasoning } from "../providers/openai-request-reasoning.js";
import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";
import type { OpenAIModeModel } from "./openai-transport-shared.js";

export function applyCompletionsReasoningAndRouting(
  params: Record<string, unknown>,
  model: OpenAIModeModel,
  reasoning: ReturnType<typeof resolveOpenAIRequestReasoning> & {
    thinkingExplicit: boolean;
  },
  compat: ResolvedOpenAICompletionsCompat,
  mode: "direct" | "managed",
): void {
  const direct = mode === "direct";
  const nativeEffort = compat.thinkingFormat === "openrouter" ? undefined : reasoning.effort;
  const enabled = reasoning.thinkingEnabled ?? false;
  if (
    model.reasoning &&
    (!compat.thinkingOffControlUndeclared ||
      reasoning.thinkingEnabled !== undefined ||
      !reasoning.thinkingExplicit)
  ) {
    let allowScalarEffort = true;
    if (Object.keys(compat.numericReasoningEfforts ?? {}).length > 0) {
      // The route declares a numeric effort map, so its wire shape is chat_template_kwargs:
      // `thinking` is binary and the numeric effort is the only effort field the endpoint sees.
      allowScalarEffort = false;
      const existing = params.chat_template_kwargs;
      const carried =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>) }
          : {};
      // Foreign keys stay, but this contract owns the thinking controls: drop a conflicting
      // `enable_thinking` and a stale nested effort so the numeric shape cannot contradict itself.
      delete carried.enable_thinking;
      delete carried.reasoning_effort;
      params.chat_template_kwargs = {
        ...carried,
        thinking: enabled,
        ...(reasoning.numericEffort !== undefined
          ? { reasoning_effort: reasoning.numericEffort }
          : {}),
      };
      delete params.reasoning_effort;
    } else if (direct && compat.thinkingFormat === "zai") {
      params.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
      allowScalarEffort = false;
    } else if (compat.thinkingFormat === "qwen") {
      params.enable_thinking = enabled;
      allowScalarEffort = false;
    } else if (compat.thinkingFormat === "qwen-chat-template") {
      const chatTemplateReasoningEffort =
        enabled && reasoning.thinkingExplicit && model.compat?.supportedReasoningEfforts?.length
          ? reasoning.effort
          : undefined;
      params.chat_template_kwargs = {
        enable_thinking: enabled,
        ...(direct ? { preserve_thinking: true } : {}),
        ...(chatTemplateReasoningEffort ? { reasoning_effort: chatTemplateReasoningEffort } : {}),
      };
      allowScalarEffort = false;
    } else if (
      compat.thinkingFormat === "together" ||
      (direct && compat.thinkingFormat === "deepseek")
    ) {
      if (compat.thinkingFormat === "deepseek") {
        params.thinking = { type: enabled ? "enabled" : "disabled" };
      } else {
        params.reasoning = { enabled };
      }
      allowScalarEffort = enabled;
    }
    if (
      allowScalarEffort &&
      compat.supportsReasoningEffort &&
      (direct ? nativeEffort !== undefined : nativeEffort)
    ) {
      params.reasoning_effort = nativeEffort;
    }
  }
  if (!direct) {
    return;
  }

  if (compat.openRouterRouting) {
    params.provider = compat.openRouterRouting;
  }

  if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
    const routing = model.compat.vercelGatewayRouting;
    if (routing.only || routing.order) {
      const gatewayOptions: Record<string, string[]> = {};
      if (routing.only) {
        gatewayOptions.only = routing.only;
      }
      if (routing.order) {
        gatewayOptions.order = routing.order;
      }
      params.providerOptions = { gateway: gatewayOptions };
    }
  }
}
