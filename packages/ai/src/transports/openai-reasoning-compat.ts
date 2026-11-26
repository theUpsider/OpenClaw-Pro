/** Explicit model reasoning-effort compatibility metadata. */
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOpenAIReasoningEffort } from "../providers/openai-reasoning-effort.js";

/** Minimal model fields needed to resolve OpenAI reasoning effort compatibility. */
type OpenAIReasoningCompatModel = {
  provider?: string | null;
  id?: string | null;
  compat?: unknown;
};

// Provider metadata can remap reasoning effort names. Keep only string pairs so
// malformed compat data cannot poison request parameters.
function readCompatReasoningEffortMap(compat: unknown): Record<string, string> {
  const rawMap = asOptionalObjectRecord(asOptionalObjectRecord(compat)?.reasoningEffortMap);
  if (!rawMap) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(rawMap).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Resolves the reasoning effort remap for an OpenAI-compatible model. */
export function resolveOpenAIReasoningEffortMap(
  model: OpenAIReasoningCompatModel,
  fallbackMap: Record<string, string> = {},
): Record<string, string> {
  return {
    ...fallbackMap,
    ...readCompatReasoningEffortMap(model.compat),
  };
}

// Numeric efforts are an alternative wire mapping, so keep only finite numbers.
function readCompatNumericReasoningEfforts(compat: unknown): Record<string, number> {
  const rawMap = asOptionalObjectRecord(asOptionalObjectRecord(compat)?.numericReasoningEfforts);
  if (!rawMap) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(rawMap).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

/**
 * Resolves the numeric reasoning efforts for an OpenAI-compatible model. A non-empty result is the
 * route's only effort mapping; callers must not consult the string map for unbounded levels.
 */
export function resolveOpenAINumericReasoningEfforts(
  model: OpenAIReasoningCompatModel,
): Record<string, number> {
  return readCompatNumericReasoningEfforts(model.compat);
}

/** Resolves one logical level to its numeric wire effort with the string map's case tolerance. */
export function resolveOpenAINumericReasoningEffort(
  effort: string,
  numericEfforts: Record<string, number>,
): number | undefined {
  const requested = normalizeOpenAIReasoningEffort(effort);
  const direct = numericEfforts[requested] ?? numericEfforts[effort];
  if (direct !== undefined) {
    return direct;
  }
  return Object.entries(numericEfforts).find(
    ([key]) => normalizeOpenAIReasoningEffort(key) === requested,
  )?.[1];
}
