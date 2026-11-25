import "../../test/dom.setup.ts";
import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { createWorkboardView } from "./view.test-support.ts";

/**
 * Review finding on PR #79 (Opus 5.5, 2026-11-13): the same class of defect as the notes
 * disclosure, but through `For`. `<For each={options()}>` in the decision face has no `keyed`
 * function, so rows match by object identity; the `options` memo builds new objects from
 * `card()` on every refresh. The option buttons are therefore re-created and keyboard focus
 * is lost mid-decision.
 */
const notes = "Which store should this use?\n- [ ] SQLite\n- [ ] Postgres";

function decisionCard() {
  return createWorkboardCard({
    id: "decision-card",
    title: "Pick a store",
    status: "blocked",
    labels: ["decision"],
    notes,
  });
}

describe("needs-you face keeps its option rows across a refresh", () => {
  it("does not re-create the option buttons when the card object is replaced", () => {
    const client = createWorkboardTestClient({});
    const view = createWorkboardView({ client, canWrite: true });
    view.state.cards = [decisionCard()];
    view.state.attentionInbox = true;
    view.renderView();
    const before = [
      ...view.container.querySelectorAll<HTMLButtonElement>(".workboard-face__option"),
    ];
    expect(before.length).toBe(2);
    before[1]!.focus();
    expect(document.activeElement).toBe(before[1]);

    // A refresh delivers a fresh object for the same card.
    view.state.cards = [decisionCard()];
    view.renderView();
    flush();

    const after = [
      ...view.container.querySelectorAll<HTMLButtonElement>(".workboard-face__option"),
    ];
    expect(after.length).toBe(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(document.activeElement).toBe(before[1]);
  });
});
