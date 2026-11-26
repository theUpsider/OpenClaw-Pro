import {
  MODEL_CATALOG_THINKING_LEVELS,
  resolveOpenAIThinkingApi,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { clampThinkingLevel } from "../model-utils.js";
import { isKnownOpenAIEndpoint } from "../transports/openai-completions-compat.js";
import {
  resolveOpenAINumericReasoningEffort,
  resolveOpenAINumericReasoningEfforts,
  resolveOpenAIReasoningEffortMap,
} from "../transports/openai-reasoning-compat.js";
import type { Api, Model, ModelThinkingLevel, SimpleStreamOptions } from "../types.js";
import {
  normalizeOpenAIReasoningEffort,
  resolveOpenAIModelReasoningEfforts,
  resolveOpenAIReasoningEffortForModel,
  resolveOpenAIReasoningEffortMapping,
  supportsOpenAIReasoningEffort,
} from "./openai-reasoning-effort.js";

export type OpenAIRequestReasoningEffort = ModelThinkingLevel | "none";

/** Preserve explicit off until the selected route maps it to its native value. */
export function resolveOpenAISimpleReasoningEffort<TApi extends Api>(
  model: Model<TApi>,
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
): ModelThinkingLevel | undefined {
  return reasoning === undefined ? undefined : clampThinkingLevel(model, reasoning);
}

export function resolveOpenAIRequestReasoning(
  model: Pick<Model, "id" | "provider" | "api" | "reasoning" | "thinkingLevelMap"> & {
    compat?: unknown;
    baseUrl?: string;
  },
  reasoning: string | undefined,
): { effort: string | undefined; thinkingEnabled: boolean | undefined; numericEffort?: number } {
  // Logical off can map to a minimum effort; native none only uses its own explicit mapping.
  const requested = normalizeOpenAIReasoningEffort(reasoning ?? "off");
  // A declared numeric map owns the route's wire effort: numbers replace the string mapping for
  // every level, and a level without an entry intentionally sends no effort at all. The field is a
  // Completions contract, so a shared Responses route that happens to carry it is unaffected.
  const numericEfforts =
    resolveOpenAIThinkingApi(model.api) === "openai-completions"
      ? resolveOpenAINumericReasoningEfforts(model)
      : {};
  const usesNumericEfforts = Object.keys(numericEfforts).length > 0;
  const modelLevel = MODEL_CATALOG_THINKING_LEVELS.find((candidate) => candidate === requested);
  const modelMapped = modelLevel ? model.thinkingLevelMap?.[modelLevel] : undefined;
  const mapped =
    modelMapped === null
      ? null
      : (resolveOpenAIReasoningEffortMapping(requested, resolveOpenAIReasoningEffortMap(model)) ??
        modelMapped);
  const intent =
    mapped !== undefined ? mapped?.trim() : reasoning === undefined ? undefined : requested;
  const normalizedIntent = normalizeOpenAIReasoningEffort(intent ?? "off");
  const disabled = requested === "off" || requested === "none";
  const supported = resolveOpenAIModelReasoningEfforts(
    disabled &&
      resolveOpenAIThinkingApi(model.api) !== "openai-chatgpt-responses" &&
      !isKnownOpenAIEndpoint(model)
      ? { compat: model.compat }
      : model,
  );
  const effort = usesNumericEfforts
    ? undefined
    : !model.reasoning || supported?.length === 0 || intent === undefined
      ? undefined
      : supported === undefined
        ? disabled && mapped === undefined
          ? undefined
          : intent
        : resolveOpenAIReasoningEffortForModel({
            model,
            effort: requested,
            fallbackMap: { [requested]: intent },
          });
  // The numeric map is the route's only mapping, so the string ladder (including an off/none
  // entry) owns no part of the binary state either: it follows the logical level itself.
  const disabledLevel = usesNumericEfforts
    ? requested === "off" || requested === "none"
    : normalizedIntent === "off" || normalizedIntent === "none";
  const thinkingEnabled = intent === undefined ? undefined : model.reasoning && !disabledLevel;
  return {
    // Sol and Luna accept none on ChatGPT; other subscription models need route metadata.
    effort:
      effort === "none" &&
      resolveOpenAIThinkingApi(model.api) === "openai-chatgpt-responses" &&
      !supportsOpenAIReasoningEffort(
        model.id === "gpt-6-sol" || model.id === "gpt-6-luna"
          ? model
          : { compat: model.compat, thinkingLevelMap: model.thinkingLevelMap },
        "none",
      )
        ? undefined
        : effort,
    // Binary thinking is independent of scalar effort support.
    thinkingEnabled,
    // Off/none is a binary state: a numeric entry for a disabled level must never ship an effort.
    ...(usesNumericEfforts && !disabledLevel
      ? { numericEffort: resolveOpenAINumericReasoningEffort(requested, numericEfforts) }
      : {}),
  };
}
