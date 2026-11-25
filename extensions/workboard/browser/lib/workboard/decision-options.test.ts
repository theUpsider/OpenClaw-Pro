import { describe, expect, it } from "vitest";
import { resolveWorkboardDecisionOptions } from "./decision-options.ts";
import { createWorkboardCard } from "./test/index-helpers.ts";
import type { WorkboardDecisionOption } from "./types.ts";

function decisionCard(notes?: string, decisionOptions?: WorkboardDecisionOption[]) {
  return createWorkboardCard({
    status: "blocked",
    labels: ["decision"],
    notes,
    ...(decisionOptions ? { metadata: { automation: { decisionOptions } } } : {}),
  });
}

describe("resolveWorkboardDecisionOptions", () => {
  it("prefers the agent's options over the notes' task items, in the agent's order", () => {
    expect(
      resolveWorkboardDecisionOptions(
        decisionCard("- [ ] From notes", [
          { label: "B", description: "Second letter." },
          { label: "A", recommended: true },
        ]),
      ),
    ).toEqual({
      structured: true,
      options: [
        { label: "B", description: "Second letter." },
        { label: "A", recommended: true },
      ],
    });
  });

  it("keeps only the first recommendation and at most six options", () => {
    const options = Array.from({ length: 8 }, (_, index) => ({
      label: `Option ${index + 1}`,
      recommended: index > 0,
    }));
    const { options: resolved } = resolveWorkboardDecisionOptions(decisionCard(undefined, options));
    expect(resolved.map((option) => option.label)).toEqual([
      "Option 1",
      "Option 2",
      "Option 3",
      "Option 4",
      "Option 5",
      "Option 6",
    ]);
    expect(resolved.filter((option) => option.recommended)).toEqual([
      { label: "Option 2", recommended: true },
    ]);
  });

  it("falls back to the notes' task items as plain labels", () => {
    expect(
      resolveWorkboardDecisionOptions(
        decisionCard("Which store?\n- [ ] SQLite\n- [x] Done already\n* [ ] Postgres", [
          { label: "Only one", recommended: true },
        ]),
      ),
    ).toEqual({ structured: false, options: [{ label: "SQLite" }, { label: "Postgres" }] });
  });

  it("offers nothing when neither source has options", () => {
    expect(resolveWorkboardDecisionOptions(decisionCard("Pick a store"))).toEqual({
      structured: false,
      options: [],
    });
    expect(resolveWorkboardDecisionOptions(decisionCard())).toEqual({
      structured: false,
      options: [],
    });
  });
});
