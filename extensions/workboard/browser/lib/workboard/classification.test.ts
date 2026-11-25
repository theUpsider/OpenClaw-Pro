import { describe, expect, it } from "vitest";
import { resolveCardClassification, type WorkboardClassification } from "./classification.ts";

const palette: WorkboardClassification[] = [
  { name: "Bug", color: "red" },
  { name: "research", color: "purple" },
  { name: "ops", color: "not-a-color" },
];
const resolveColor = (value: string) =>
  ["red", "purple"].includes(value) ? `var(--session-color-${value})` : "";

describe("resolveCardClassification", () => {
  it("picks the first palette match in stored order and pins it first", () => {
    const result = resolveCardClassification(
      ["frontend", "research", "bug", "later"],
      palette,
      resolveColor,
    );
    expect(result.primary).toEqual({ label: "research", color: "var(--session-color-purple)" });
    expect(result.orderedLabels).toEqual(["research", "frontend", "bug", "later"]);
    expect([...result.colors]).toEqual([
      ["research", "var(--session-color-purple)"],
      ["bug", "var(--session-color-red)"],
    ]);
  });

  it("matches labels case-insensitively, including case-only duplicates", () => {
    const result = resolveCardClassification(
      [" BUG ", "Research", "research"],
      palette,
      resolveColor,
    );
    expect(result.primary?.label).toBe(" BUG ");
    expect(result.orderedLabels).toEqual([" BUG ", "Research", "research"]);
    expect(result.colors.get("Research")).toBe("var(--session-color-purple)");
    expect(result.colors.get("research")).toBe("var(--session-color-purple)");
  });

  it("treats a palette color the resolver does not know as no color", () => {
    const result = resolveCardClassification(["ops", "misc"], palette, resolveColor);
    expect(result.primary).toBeUndefined();
    expect(result.colors.size).toBe(0);
    expect(result.orderedLabels).toEqual(["ops", "misc"]);
  });

  it("returns no primary and stored order when no label matches", () => {
    const labels = ["frontend", "later"];
    const result = resolveCardClassification(labels, palette, resolveColor);
    expect(result.primary).toBeUndefined();
    expect(result.colors.size).toBe(0);
    expect(result.orderedLabels).toEqual(labels);
  });
});
