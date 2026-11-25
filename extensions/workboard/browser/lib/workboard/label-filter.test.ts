import { describe, expect, it } from "vitest";
import { buildWorkboardLabelOptions, matchesLabelFilter } from "./label-filter.ts";
import { createWorkboardCard } from "./test/index-helpers.ts";

describe("buildWorkboardLabelOptions", () => {
  it("de-duplicates labels case-insensitively, keeps the first spelling and sorts", () => {
    const options = buildWorkboardLabelOptions([
      createWorkboardCard({ id: "a", labels: ["UI", "bug", " ", "Bug"] }),
      createWorkboardCard({ id: "b", labels: ["Bug ", "release"] }),
      createWorkboardCard({ id: "c", labels: ["ui"] }),
    ]);
    expect(options).toEqual([
      { value: "bug", label: "bug", count: 2 },
      { value: "release", label: "release", count: 1 },
      { value: "ui", label: "UI", count: 2 },
    ]);
  });

  it("keeps selected labels listed when no visible card carries them", () => {
    const options = buildWorkboardLabelOptions(
      [createWorkboardCard({ labels: ["ops"] })],
      new Set(["ops", "gone"]),
    );
    expect(options).toEqual([
      { value: "gone", label: "gone", count: 0 },
      { value: "ops", label: "ops", count: 1 },
    ]);
  });
});

describe("matchesLabelFilter", () => {
  const card = createWorkboardCard({ labels: ["Frontend", "Bug"] });

  it("matches every card when no label is selected", () => {
    expect(matchesLabelFilter(createWorkboardCard(), new Set())).toBe(true);
  });

  it("matches any selected label regardless of case", () => {
    expect(matchesLabelFilter(card, new Set(["bug"]))).toBe(true);
    expect(matchesLabelFilter(card, new Set(["release", "frontend"]))).toBe(true);
    expect(matchesLabelFilter(card, new Set(["release"]))).toBe(false);
  });
});
