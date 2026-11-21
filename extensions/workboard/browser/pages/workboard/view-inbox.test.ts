import { describe, expect, it } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { WORKBOARD_STATUSES } from "../../lib/workboard/types.ts";
import { createWorkboardView, requireButton, textButton } from "./view.test-support.ts";

const HOUR = 3_600_000;

function inboxToggle(container: Element) {
  const toggle = container.querySelector<HTMLButtonElement>("button.workboard-inbox-toggle");
  expect(toggle).not.toBeNull();
  return toggle!;
}

function inboxRows(container: Element) {
  return [...container.querySelectorAll<HTMLElement>(".workboard-inbox__item")];
}

function unownedRow(container: Element) {
  return container.querySelector<HTMLButtonElement>("button.workboard-inbox__unowned-row");
}

function inboxHeadingCount(container: Element) {
  const count = container.querySelector<HTMLElement>(
    ".workboard-inbox .workboard-column__heading .workboard-column__count",
  );
  expect(count).not.toBeNull();
  return count!.textContent;
}

function waitingCards() {
  const now = Date.now();
  return [
    createWorkboardCard({
      id: "review-unowned",
      title: "Review and unowned",
      status: "review",
      priority: "urgent",
      labels: ["decision"],
      createdAt: now - 5 * HOUR,
      events: [{ id: "m1", kind: "moved", at: now - 3 * HOUR, toStatus: "review" }],
    }),
    createWorkboardCard({
      id: "unowned-urgent",
      title: "Urgent unowned",
      status: "todo",
      priority: "urgent",
      createdAt: now - HOUR,
    }),
    createWorkboardCard({
      id: "decision",
      title: "Decision card",
      status: "blocked",
      priority: "low",
      agentId: "b",
      labels: ["decision"],
      createdAt: now - 9 * HOUR,
    }),
    createWorkboardCard({
      id: "unowned-blocked",
      title: "Unowned blocked decision",
      status: "blocked",
      labels: ["decision"],
      createdAt: now - 10 * HOUR,
    }),
    createWorkboardCard({
      id: "input-card",
      title: "Input card",
      status: "blocked",
      priority: "low",
      agentId: "b",
      createdAt: now - 8 * HOUR,
      metadata: { automation: { ask: "Which tenant?", askKind: "input" } },
    }),
    createWorkboardCard({
      id: "busy",
      title: "Busy card",
      status: "running",
      agentId: "b",
    }),
    // A `decision` label on a card the operator already answered: no reason left, not in the inbox.
    createWorkboardCard({
      id: "answered",
      title: "Answered decision",
      status: "ready",
      agentId: "b",
      labels: ["decision"],
    }),
  ];
}

describe("needs-you inbox lens", () => {
  it.each(["board", "list"] as const)(
    "renders one ordered inbox with reasons and state-entry time in %s view",
    (viewMode) => {
      const { state, container, renderView } = createWorkboardView();
      state.viewMode = viewMode;
      state.cards = waitingCards();
      renderView();

      const toggle = inboxToggle(container);
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      // The toggle counts the operator's own steps (decide + review), not the agentless rest;
      // the collapsed "no agent" row states its own count. Four of the five entries are steps.
      expect(toggle.getAttribute("aria-label")).toBe("Needs you (4)");
      expect(container.querySelector(".workboard-inbox")).toBeNull();

      toggle.click();
      renderView();
      expect(inboxToggle(container).getAttribute("aria-pressed")).toBe("true");
      // One sequence instead of status columns.
      expect(container.querySelectorAll(".workboard-column")).toHaveLength(1);
      // The tier key decides first: the two decision-tier cards (both LOW priority), then the
      // review card (urgent). Priority only orders inside one tier, so an urgent review can never
      // overtake a low-priority decision; the urgent agentless card is housekeeping and collapsed.
      const rows = inboxRows(container);
      expect(rows.map((row) => row.dataset.cardId)).toEqual([
        "unowned-blocked",
        "decision",
        "input-card",
        "review-unowned",
      ]);
      // The answered `decision`-labelled card (`ready`) and the busy card never appear.
      expect(rows.map((row) => row.dataset.cardId)).not.toContain("answered");
      expect(rows.map((row) => row.dataset.cardId)).not.toContain("busy");

      // Each headline card carries its face right next to it instead of the plain reason line;
      // the face's strip is what names the reason and the time in status there.
      const faces = [...container.querySelectorAll<HTMLElement>(".workboard-face")];
      expect(faces).toHaveLength(4);
      expect(
        faces.map((face) => face.querySelector(".workboard-face__reason")?.textContent),
      ).toEqual(["Decision", "Decision", "Answer needed", "Review"]);
      // `review` already asks on its own; the missing agent adds no second reason there.
      const since = rows[3]!.querySelector<HTMLTimeElement>(".workboard-face__age")!;
      expect(since.textContent).toBe("in Review 3h ago");
      // The stored ask kind ranks at the decision tier through the shared predicate, so it sits
      // above review even though it is newer than the review card.
      // The unowned blocker names only the decision: `unowned` never applies to `blocked`.
      expect(container.querySelectorAll(".workboard-inbox__why")).toHaveLength(0);
      expect(
        faces.map((face) => face.querySelector(".workboard-face__title")?.textContent),
      ).toEqual(["Unowned blocked decision", "Decision card", "Input card", "Review and unowned"]);
    },
  );

  it("keeps the agentless cards in one collapsed count row, expanded only on request", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = waitingCards();
    state.attentionInbox = true;
    renderView();

    // Collapsed by default: the agentless card is not rendered at all, only counted.
    expect(state.inboxUnownedExpanded).toBe(false);
    expect(inboxRows(container).map((row) => row.dataset.cardId)).not.toContain("unowned-urgent");
    const row = unownedRow(container);
    expect(row).toBeTruthy();
    expect(row!.getAttribute("aria-expanded")).toBe("false");
    expect(row!.querySelector(".workboard-inbox__unowned-count")?.textContent).toBe("1");
    expect(row!.textContent).toContain("No agent");
    expect(row!.getAttribute("aria-label")).toBe("1 open cards wait for an agent");

    row!.click();
    renderView();
    expect(state.inboxUnownedExpanded).toBe(true);
    expect(unownedRow(container)!.getAttribute("aria-expanded")).toBe("true");
    expect(inboxRows(container).map((item) => item.dataset.cardId)).toContain("unowned-urgent");
    // Nothing else moved: the headline order is untouched by expanding the rest.
    expect(inboxRows(container).map((item) => item.dataset.cardId)).toEqual([
      "unowned-blocked",
      "decision",
      "input-card",
      "review-unowned",
      "unowned-urgent",
    ]);

    unownedRow(container)!.click();
    renderView();
    expect(state.inboxUnownedExpanded).toBe(false);
    expect(inboxRows(container).map((item) => item.dataset.cardId)).not.toContain("unowned-urgent");
  });

  it("renders no unowned row when every waiting card is the operator's own step", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({ id: "review", status: "review", agentId: "b" }),
      createWorkboardCard({
        id: "decision",
        status: "blocked",
        agentId: "b",
        labels: ["decision"],
      }),
    ];
    state.attentionInbox = true;
    renderView();
    expect(unownedRow(container)).toBeNull();
    expect(inboxRows(container).map((row) => row.dataset.cardId)).toEqual(["decision", "review"]);
  });

  it("counts the operator's own steps, and a status filter narrows both", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = waitingCards();
    state.attentionInbox = true;
    renderView();
    // Four operator steps (three decide + one review); the agentless card is one collapsed row.
    expect(inboxToggle(container).textContent).toBe("Needs you4");
    expect(inboxRows(container)).toHaveLength(4);

    state.statusFilter.add("review");
    state.statusFilter.add("running");
    renderView();
    expect(inboxToggle(container).getAttribute("aria-label")).toBe("Needs you (1)");
    expect(inboxRows(container).map((row) => row.dataset.cardId)).toEqual(["review-unowned"]);
    expect(unownedRow(container)).toBeNull();
  });

  it("shows the operator's own steps in the lens heading, not the agentless rest", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = waitingCards();
    state.attentionInbox = true;
    renderView();
    // The heading sits directly under the toolbar toggle; two numbers naming the same thing may
    // not disagree. Four operator steps, the fifth entry is the agentless row's own count.
    expect(inboxToggle(container).textContent).toBe("Needs you4");
    expect(inboxHeadingCount(container)).toBe("4");
    expect(unownedRow(container)?.textContent).toContain("1");
  });

  it("shows a clearable chip that turns the lens off", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = waitingCards();
    state.attentionInbox = true;
    renderView();
    requireButton(container, "Remove filter: Needs you").click();
    renderView();
    expect(state.attentionInbox).toBe(false);
    expect(container.querySelector(".workboard-inbox")).toBeNull();
  });

  it("tells an empty inbox apart from one the other filters hide", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [createWorkboardCard({ id: "busy", status: "running", agentId: "b" })];
    state.attentionInbox = true;
    renderView();
    const empty = container.querySelector(".workboard-empty-state")!;
    expect(empty.textContent).toContain("Nothing needs you");
    textButton(empty, "Show all cards").click();
    renderView();
    expect(state.attentionInbox).toBe(false);
    expect(container.textContent).toContain("Build board");

    state.cards = waitingCards();
    state.attentionInbox = true;
    state.query = "no such card";
    renderView();
    const hidden = container.querySelector(".workboard-empty-state")!;
    expect(hidden.textContent).toContain("No cards that need you match these filters");
    textButton(hidden, "Clear other filters").click();
    renderView();
    expect(state.attentionInbox).toBe(true);
    expect(state.query).toBe("");
    expect(inboxRows(container)).toHaveLength(4);
  });

  it.each(["board", "list"] as const)(
    "keeps the status columns with the lens off in %s view",
    (viewMode) => {
      const { state, container, renderView } = createWorkboardView();
      state.viewMode = viewMode;
      state.sort = "created";
      state.cards = waitingCards();
      renderView();
      expect(container.querySelector(".workboard-inbox")).toBeNull();
      expect(container.querySelectorAll(".workboard-column")).toHaveLength(
        WORKBOARD_STATUSES.length,
      );
      expect(container.querySelector(".workboard-inbox__why")).toBeNull();
      expect(requireButton(container, "Remove filter: Sort: Newest created first")).toBeTruthy();
    },
  );
});
