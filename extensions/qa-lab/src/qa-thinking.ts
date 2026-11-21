export type QaThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max"
  | "ultra";

export function normalizeQaThinkingLevel(input: unknown): QaThinkingLevel | undefined {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  const collapsed = value.replace(/[\s_-]+/g, "");
  switch (collapsed) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "adaptive":
    case "max":
    case "ultra":
      return collapsed;
    case "min":
      return "minimal";
    case "med":
      return "medium";
    case "extrahigh":
      return "xhigh";
    case "auto":
      return "adaptive";
    default:
      return undefined;
  }
}
