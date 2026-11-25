// Qa Lab tests cover thinking-level normalization for the QA CLI surface.
import { describe, expect, it } from "vitest";
import { normalizeQaThinkingLevel } from "./qa-thinking.js";

describe("normalizeQaThinkingLevel", () => {
  it.each([
    ["ultra", "ultra"],
    ["Ultra", "ultra"],
    ["ULTRA", "ultra"],
    ["  ultra  ", "ultra"],
    ["u_l_t_r_a", "ultra"],
    ["U L T R A", "ultra"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeQaThinkingLevel(input)).toBe(expected);
  });

  it.each([
    ["off", "off"],
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["adaptive", "adaptive"],
    ["max", "max"],
  ] as const)("keeps the existing level %s", (input, expected) => {
    expect(normalizeQaThinkingLevel(input)).toBe(expected);
  });

  it.each([
    ["min", "minimal"],
    ["med", "medium"],
    ["extrahigh", "xhigh"],
    ["auto", "adaptive"],
    [" MAX ", "max"],
    [" Auto ", "adaptive"],
  ] as const)("keeps the existing alias %s", (input, expected) => {
    expect(normalizeQaThinkingLevel(input)).toBe(expected);
  });

  // The shared `[\s_-]+` collapse strips separator edges, so `ultra-` normalizes to `ultra` — the same
  // rule that already turned `max-` into `max` before this change. It cannot be tightened for `ultra`
  // alone without changing that behaviour for the existing levels.
  it.each([
    ["max-", "max"],
    ["-max", "max"],
    ["ultra-", "ultra"],
    ["-ultra", "ultra"],
    ["ultra_", "ultra"],
  ] as const)("collapses separator edges of %s", (input, expected) => {
    expect(normalizeQaThinkingLevel(input)).toBe(expected);
  });

  it.each([["ultraa"], ["xultra"], ["enormous"], ["galaxy"], [""], [undefined], [123]])(
    "rejects %s",
    (input) => {
      expect(normalizeQaThinkingLevel(input)).toBeUndefined();
    },
  );
});
