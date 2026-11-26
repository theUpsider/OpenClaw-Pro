import { describe, expect, it } from "vitest";
import { getWorkboardLaneQueue } from "./lane-queue.ts";
import { createWorkboardCard } from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";

const NOW = 1_000_000;

function card(id: string, overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  return createWorkboardCard({ id, title: `Card ${id}`, agentId: "b", ...overrides });
}

const holder = card("holder", { status: "running", title: "Ship lane view" });

describe("getWorkboardLaneQueue", () => {
  it("names the slot holder, this card's place and the cards ahead", () => {
    const first = card("first", { status: "ready", position: 1000 });
    const second = card("second", { status: "ready", position: 2000 });
    const third = card("third", { status: "todo", position: 500 });
    const cards = [third, second, holder, first];

    expect(getWorkboardLaneQueue(second, cards, NOW)).toEqual({
      ownerId: "b",
      holder: { id: "holder", title: "Ship lane view" },
      position: 2,
      total: 3,
      ahead: [{ id: "first", title: "Card first" }],
    });
    // Ready cards start first, so a lower-position Todo card still waits behind them.
    expect(getWorkboardLaneQueue(third, cards, NOW)).toMatchObject({ position: 3, total: 3 });
    expect(getWorkboardLaneQueue(first, cards, NOW)).toMatchObject({ position: 1, ahead: [] });
  });

  it("orders Ready cards like the dispatcher: priority, then position, then age", () => {
    const urgent = card("urgent", { status: "ready", priority: "urgent", position: 9000 });
    const older = card("older", { status: "ready", position: 1000, createdAt: 1 });
    const newer = card("newer", { status: "ready", position: 1000, createdAt: 2 });
    const cards = [newer, older, urgent, holder];

    expect(getWorkboardLaneQueue(newer, cards, NOW)?.ahead.map((entry) => entry.id)).toEqual([
      "urgent",
      "older",
    ]);
  });

  it("bounds the named cards ahead but keeps the full position", () => {
    const waiting = Array.from({ length: 5 }, (_, index) =>
      card(`w${index}`, { status: "ready", position: (index + 1) * 1000 }),
    );
    const last = waiting[4]!;
    const queue = getWorkboardLaneQueue(last, [holder, ...waiting], NOW);
    expect(queue).toMatchObject({ position: 5, total: 5 });
    expect(queue?.ahead.map((entry) => entry.id)).toEqual(["w0", "w1", "w2"]);
  });

  it("finds the holder by its live claim owner, the same rule the claim gate uses", () => {
    const claimed = card("claimed", {
      status: "ready",
      agentId: "someone-else",
      metadata: {
        claim: {
          ownerId: "b",
          token: "t",
          claimedAt: NOW - 10,
          lastHeartbeatAt: NOW - 10,
          expiresAt: NOW + 60_000,
        },
      },
    });
    const waiting = card("waiting", { status: "ready" });
    const otherLane = card("other", { status: "ready", agentId: "someone-else" });

    expect(getWorkboardLaneQueue(waiting, [claimed, waiting, otherLane], NOW)).toMatchObject({
      ownerId: "b",
      holder: { id: "claimed" },
    });
    // The claim moved the slot to b, so someone-else's lane is free.
    expect(getWorkboardLaneQueue(otherLane, [claimed, waiting, otherLane], NOW)).toBeUndefined();
  });

  it("uses the card's agent, not an expired claim owner, for a waiting card", () => {
    const stale = card("stale", {
      status: "ready",
      agentId: "c",
      metadata: {
        claim: {
          ownerId: "b",
          token: "t",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: NOW - 1,
        },
      },
    });
    expect(getWorkboardLaneQueue(stale, [holder, stale], NOW)).toBeUndefined();
  });

  it("queues unassigned cards behind the default dispatcher owner", () => {
    const running = createWorkboardCard({ id: "running", status: "running" });
    const waiting = createWorkboardCard({ id: "waiting", status: "ready" });
    expect(getWorkboardLaneQueue(waiting, [running, waiting], NOW)).toMatchObject({
      ownerId: "workboard-dispatcher",
      holder: { id: "running" },
    });
  });

  it("reports no queue while the owner slot is free", () => {
    const waiting = card("waiting", { status: "ready" });
    const finished = card("finished", { status: "done" });
    const reviewing = card("reviewing", { status: "review" });
    expect(getWorkboardLaneQueue(waiting, [waiting, finished, reviewing], NOW)).toBeUndefined();
  });

  it("reports no queue while a parallel-slot owner still has room", () => {
    const parallel = { automation: { parallelizable: true, maxConcurrentPerOwner: 2 } };
    const running = card("running", { status: "running", metadata: parallel });
    const waiting = card("waiting", { status: "ready", metadata: parallel });
    expect(getWorkboardLaneQueue(waiting, [running, waiting], NOW)).toBeUndefined();
    const full = card("full", { status: "running", metadata: parallel });
    expect(getWorkboardLaneQueue(waiting, [running, full, waiting], NOW)).toMatchObject({
      position: 1,
    });
  });

  it("only queues cards that are genuinely waiting for the slot", () => {
    const waiting = card("waiting", { status: "ready", position: 5000 });
    const others = [
      card("review", { status: "review", position: 1 }),
      card("done", { status: "done", position: 2 }),
      card("blocked", { status: "blocked", position: 3 }),
      card("archived", { status: "ready", position: 4, metadata: { archivedAt: 1 } }),
      card("other-lane", { status: "ready", agentId: "c", position: 5 }),
    ];
    expect(getWorkboardLaneQueue(waiting, [holder, ...others, waiting], NOW)).toMatchObject({
      position: 1,
      total: 1,
      ahead: [],
    });
    expect(getWorkboardLaneQueue(holder, [holder, waiting], NOW)).toBeUndefined();
    expect(getWorkboardLaneQueue(others[2]!, [holder, ...others], NOW)).toBeUndefined();
  });
});
