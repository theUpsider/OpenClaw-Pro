import { describe, expect, it } from "vitest";
import { createWorkboardCard } from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";
import {
  getWorkboardDecisionOptions,
  getWorkboardWaitingReason,
  isWorkboardDecisionCard,
} from "./waiting-reason.ts";

const parentLink = (targetCardId: string) => ({
  id: `link-${targetCardId}`,
  type: "parent" as const,
  createdAt: 1,
  targetCardId,
});

function withParents(card: WorkboardCard, ...targets: string[]): WorkboardCard {
  return { ...card, metadata: { links: targets.map(parentLink) } };
}

describe("getWorkboardWaitingReason", () => {
  const openParent = createWorkboardCard({
    id: "parent-open",
    title: "Design API",
    status: "running",
  });
  const doneParent = createWorkboardCard({ id: "parent-done", title: "Spec", status: "done" });

  it("puts a blocked decision card on the operator before anything else", () => {
    const card = withParents(
      createWorkboardCard({ status: "blocked", labels: ["feature", "Decision"] }),
      "parent-open",
    );
    expect(getWorkboardWaitingReason(card, [card, openParent])).toEqual({ kind: "decision" });
  });

  it("reports the worker's recorded blocker detail", () => {
    const card = createWorkboardCard({
      status: "blocked",
      metadata: { workerProtocol: { state: "blocked", updatedAt: 2, detail: " Needs API key " } },
    });
    expect(getWorkboardWaitingReason(card, [card])).toEqual({
      kind: "blocked",
      detail: "Needs API key",
      parents: [],
    });
  });

  it("explains a card blocked because a gateway restart tombstoned its session", () => {
    const card = createWorkboardCard({
      status: "blocked",
      metadata: {
        workerProtocol: { state: "blocked", updatedAt: 2, detail: "Older blocker" },
        automation: { restartTombstone: { sessionKey: "agent:main:lost", detectedAt: 3 } },
      },
    });
    expect(getWorkboardWaitingReason(card, [card])).toEqual({
      kind: "restart",
      sessionKey: "agent:main:lost",
    });
  });

  it("names blocking parents for a blocked card without a recorded detail", () => {
    const card = withParents(createWorkboardCard({ status: "blocked" }), "parent-open");
    expect(getWorkboardWaitingReason(card, [card, openParent])).toEqual({
      kind: "blocked",
      parents: ["Design API"],
    });
  });

  it("names only unfinished parents that exist", () => {
    const card = withParents(
      createWorkboardCard({ status: "ready", agentId: "b" }),
      "parent-open",
      "parent-done",
      "parent-missing",
    );
    expect(getWorkboardWaitingReason(card, [card, openParent, doneParent])).toEqual({
      kind: "parents",
      parents: ["Design API"],
    });
  });

  it("waits for a lane slot when ready and assigned", () => {
    const card = withParents(
      createWorkboardCard({ status: "ready", agentId: " b " }),
      "parent-done",
    );
    expect(getWorkboardWaitingReason(card, [card, doneParent])).toEqual({
      kind: "lane",
      agentId: "b",
    });
  });

  it("names the lane queue when another card holds the owner slot", () => {
    const holder = createWorkboardCard({
      id: "holder",
      title: "Ship lane view",
      status: "running",
      agentId: "b",
    });
    const card = createWorkboardCard({ status: "ready", agentId: "b" });
    expect(getWorkboardWaitingReason(card, [holder, card])).toEqual({
      kind: "queued",
      queue: {
        ownerId: "b",
        holder: { id: "holder", title: "Ship lane view" },
        position: 1,
        total: 1,
        ahead: [],
      },
    });
  });

  it("has no reason once a ready card has a live or queued session", () => {
    const card = createWorkboardCard({ status: "ready", agentId: "b" });
    expect(getWorkboardWaitingReason(card, [card], "running")).toBeUndefined();
    expect(getWorkboardWaitingReason(card, [card], "queued")).toBeUndefined();
  });

  it("waits for the dispatcher when ready and unassigned", () => {
    const card = createWorkboardCard({ status: "ready" });
    expect(getWorkboardWaitingReason(card, [card])).toEqual({ kind: "dispatcher" });
  });

  it("waits for acceptance in review", () => {
    const card = createWorkboardCard({ status: "review" });
    expect(getWorkboardWaitingReason(card, [card])).toEqual({ kind: "review" });
  });

  it.each([
    ["todo", "notReleased"],
    ["backlog", "notSpecified"],
    ["triage", "notSpecified"],
  ] as const)("explains an unreleased %s card", (status, kind) => {
    const card = createWorkboardCard({ status });
    expect(getWorkboardWaitingReason(card, [card])).toEqual({ kind });
  });

  it("waits for the scheduled time", () => {
    const card = createWorkboardCard({ status: "scheduled" });
    expect(getWorkboardWaitingReason(card, [card])).toEqual({ kind: "scheduled" });
    const timed = { ...card, metadata: { automation: { scheduledAt: 5_000 } } };
    expect(getWorkboardWaitingReason(timed, [timed])).toEqual({ kind: "scheduled", at: 5_000 });
  });

  it("explains a running card only when its session went stale", () => {
    const card = createWorkboardCard({ status: "running" });
    expect(getWorkboardWaitingReason(card, [card])).toBeUndefined();
    const stale = { ...card, metadata: { stale: { detectedAt: 2, reason: "No heartbeat" } } };
    expect(getWorkboardWaitingReason(stale, [stale])).toEqual({
      kind: "stale",
      detail: "No heartbeat",
    });
  });

  it("renders no line for done cards, even with unfinished parents", () => {
    const card = withParents(createWorkboardCard({ status: "done" }), "parent-open");
    expect(getWorkboardWaitingReason(card, [card, openParent])).toBeUndefined();
  });
});

describe("decision helpers", () => {
  it("treats only blocked cards labelled decision as decision cards", () => {
    expect(
      isWorkboardDecisionCard(createWorkboardCard({ status: "blocked", labels: ["decision"] })),
    ).toBe(true);
    expect(
      isWorkboardDecisionCard(createWorkboardCard({ status: "blocked", labels: ["waiting"] })),
    ).toBe(false);
    expect(
      isWorkboardDecisionCard(createWorkboardCard({ status: "todo", labels: ["decision"] })),
    ).toBe(false);
  });

  it("reads unchecked task items from the notes as choices", () => {
    const card = createWorkboardCard({
      notes: "Which store?\n- [ ] SQLite\n* [ ]  Postgres \n- [x] Files\n- plain bullet",
    });
    expect(getWorkboardDecisionOptions(card)).toEqual(["SQLite", "Postgres"]);
    expect(getWorkboardDecisionOptions(createWorkboardCard({ notes: "No options" }))).toEqual([]);
  });
});
