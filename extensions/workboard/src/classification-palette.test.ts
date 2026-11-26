import type { WorkboardClassification } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import {
  applyWorkboardCardClassifications,
  normalizeWorkboardClassifications,
  seedWorkboardClassifications,
} from "./classification-palette.js";

const NAMES = [
  "bug",
  "feature",
  "docs",
  "chore",
  "research",
  "ops",
  "design",
  "test",
  "infra",
  "ux",
];
const COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;

function fullPalette(): WorkboardClassification[] {
  return NAMES.map((name, index) => ({ name, color: COLORS[index % COLORS.length] ?? "red" }));
}

function apply(
  palette: readonly WorkboardClassification[],
  labels: string[],
  options: { previousLabels?: string[]; replaces?: unknown } = {},
) {
  return applyWorkboardCardClassifications({
    boardId: "default",
    palette,
    previousLabels: options.previousLabels ?? [],
    labels,
    replaces: options.replaces,
  });
}

describe("normalizeWorkboardClassifications", () => {
  it("trims names and keeps valid entries in order", () => {
    expect(
      normalizeWorkboardClassifications([
        { name: " bug ", color: "red" },
        { name: "docs", color: "cyan" },
      ]),
    ).toEqual([
      { name: "bug", color: "red" },
      { name: "docs", color: "cyan" },
    ]);
  });

  it("rejects invalid palettes naming the offending entry", () => {
    expect(() => normalizeWorkboardClassifications("bug")).toThrow(
      "classifications must be an array.",
    );
    expect(() =>
      normalizeWorkboardClassifications([...fullPalette(), { name: "extra", color: "red" }]),
    ).toThrow("at most 10 classifications; got 11");
    expect(() => normalizeWorkboardClassifications([{ name: "  ", color: "red" }])).toThrow(
      "Classification 1 needs a name of 1-40 characters.",
    );
    expect(() =>
      normalizeWorkboardClassifications([{ name: "x".repeat(41), color: "red" }]),
    ).toThrow("Classification 1 needs a name");
    expect(() =>
      normalizeWorkboardClassifications([
        { name: "Bug", color: "red" },
        { name: "bug", color: "blue" },
      ]),
    ).toThrow('Classification "bug" is listed twice');
    expect(() => normalizeWorkboardClassifications([{ name: "docs", color: "teal" }])).toThrow(
      'Classification "docs" color must be one of red, blue',
    );
    expect(() =>
      normalizeWorkboardClassifications([{ name: "Parallelizable", color: "red" }]),
    ).toThrow('Classification "Parallelizable" is a system label');
  });
});

describe("seedWorkboardClassifications", () => {
  it("orders by card count, then first appearance in creation order, colors by slot", () => {
    const seeded = seedWorkboardClassifications([
      { id: "c", createdAt: 3, labels: ["docs", "bug"] },
      { id: "a", createdAt: 1, labels: ["feature", "Bug", "bug"] },
      { id: "b", createdAt: 2, labels: ["docs", "parallelizable"] },
      { id: "d", createdAt: 4, labels: ["ops"], metadata: { archivedAt: 5 } },
    ]);
    // bug: 2 cards (counted once on card a), docs: 2, feature: 1. Bug was seen first.
    expect(seeded).toEqual([
      { name: "Bug", color: "red" },
      { name: "docs", color: "blue" },
      { name: "feature", color: "green" },
    ]);
  });

  it("caps at 10 slots and wraps the 8 colors", () => {
    const labels = Array.from({ length: 12 }, (_, index) => `label-${index}`);
    const seeded = seedWorkboardClassifications([{ id: "a", createdAt: 1, labels }]);
    expect(seeded.map((entry) => entry.name)).toEqual(labels.slice(0, 10));
    expect(seeded.map((entry) => entry.color)).toEqual([...COLORS, "red", "blue"]);
  });

  it("seeds an empty palette for a board without labels", () => {
    expect(seedWorkboardClassifications([])).toEqual([]);
    expect(seedWorkboardClassifications([{ id: "a", createdAt: 1, labels: [] }])).toEqual([]);
  });
});

describe("applyWorkboardCardClassifications", () => {
  it("reuses a known name case-insensitively and leaves the palette alone", () => {
    const result = apply(fullPalette(), ["BUG"]);
    expect(result.labels).toEqual(["bug"]);
    expect(result.changed).toBe(false);
    expect(result.change.classifications).toEqual(fullPalette());
  });

  it("registers an unknown name in the next free slot", () => {
    const result = apply([{ name: "bug", color: "red" }], ["bug", "docs"]);
    expect(result.labels).toEqual(["bug", "docs"]);
    expect(result.change).toEqual({
      boardId: "default",
      classifications: [
        { name: "bug", color: "red" },
        { name: "docs", color: "blue" },
      ],
      added: ["docs"],
    });
  });

  it("refuses an 11th name without replaces, listing the palette and the parameter", () => {
    expect(() => apply(fullPalette(), ["security"])).toThrow(
      'Board "default" already has 10 classifications: bug (red), feature (blue), docs (green), chore (yellow), research (purple), ops (orange), design (pink), test (cyan), infra (red), ux (blue). Reuse one of them for "security", or pass replaces',
    );
  });

  it("overwrites the named slot in place when replaces is given", () => {
    const result = apply(fullPalette(), ["security"], { replaces: "Chore" });
    expect(result.labels).toEqual(["security"]);
    expect(result.change.replaced).toEqual({ name: "chore", by: "security" });
    expect(result.change.classifications[3]).toEqual({ name: "security", color: "yellow" });
    expect(result.change.classifications).toHaveLength(10);
  });

  it("allows one replacement per write", () => {
    expect(() => apply(fullPalette(), ["security", "perf"], { replaces: "chore" })).toThrow(
      "(one replacement per write)",
    );
  });

  it("rejects replaces that names no slot or is not needed", () => {
    expect(() => apply(fullPalette(), ["security"], { replaces: "absent" })).toThrow(
      'replaces "absent" is not a classification on board "default"',
    );
    expect(() => apply(fullPalette(), ["bug"], { replaces: "chore" })).toThrow(
      'replaces "chore" was not used',
    );
    expect(() => apply([{ name: "bug", color: "red" }], ["docs"], { replaces: "bug" })).toThrow(
      'replaces "bug" was not used',
    );
    expect(() => apply(fullPalette(), ["security"], { replaces: " " })).toThrow(
      "replaces must name an existing classification.",
    );
  });

  it("never checks system labels or labels the card already carried", () => {
    const result = apply(fullPalette(), ["legacy", "Parallelizable", "bug"], {
      previousLabels: ["legacy"],
    });
    expect(result.labels).toEqual(["legacy", "Parallelizable", "bug"]);
    expect(result.changed).toBe(false);
  });
});
