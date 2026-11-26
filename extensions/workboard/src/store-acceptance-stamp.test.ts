// Workboard tests cover the acceptance stamp on the settle write: the operator moving
// an awaiting card to `done` records the acceptance in that same write, so the card the
// operator just accepted never still reads as "New" through `workboardCardAcceptanceUnseen`.
import { describe, expect, it } from "vitest";
import { workboardCardAcceptanceUnseen } from "../browser/lib/workboard/acceptance.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

/** A card whose worker reported completion: status review, awaiting acceptance. */
async function awaitingAcceptance() {
  const store = createWorkboardSqliteTestStore();
  const card = await store.create({
    title: "Worker card",
    status: "running",
    execution: {
      id: "exec-worker",
      kind: "agent-session",
      mode: "autonomous",
      status: "running",
      sessionKey: "agent:main:worker",
      runId: "run-worker",
      startedAt: 1_000,
      updatedAt: 1_000,
    },
  });
  await store.claim(card.id, { ownerId: "main", token: "worker-token" });
  const completed = await store.complete(card.id, {
    ownerId: "main",
    token: "worker-token",
    summary: "Implemented and verified.",
  });
  return { store, card, completed };
}

describe("Workboard acceptance stamp on the settle write", () => {
  it("stamps acceptanceSeenAt when the operator settles the card to done", async () => {
    const { store, card, completed } = await awaitingAcceptance();
    expect(completed.status).toBe("review");
    expect(completed.metadata?.automation?.acceptanceSeenAt).toBeUndefined();

    const accepted = await store.update(card.id, { status: "done" });

    expect(accepted.status).toBe("done");
    expect(accepted.metadata?.automation?.acceptanceSeenAt).toEqual(expect.any(Number));
    // One write: the accepted card is seen immediately, with no second stamp.
    expect(workboardCardAcceptanceUnseen(accepted)).toBe(false);
    // The stamp lands with the settle, so it cannot predate the completion it accepts.
    expect(accepted.metadata?.automation?.acceptanceSeenAt).toBeGreaterThanOrEqual(
      completed.metadata?.automation?.autoCompletedAt ?? 0,
    );
  });

  it("does not stamp a send-back, and leaves the earlier completion unseen", async () => {
    const { store, card } = await awaitingAcceptance();

    const reopened = await store.update(card.id, { status: "todo" });

    expect(reopened.status).toBe("todo");
    expect(reopened.metadata?.automation?.acceptanceSeenAt).toBeUndefined();
  });

  it("leaves a reviewer's acceptance unstamped, so the operator still sees the result", async () => {
    const { store, card } = await awaitingAcceptance();
    await store.claim(card.id, { ownerId: "reviewer", token: "review-token" });

    const accepted = await store.complete(card.id, {
      ownerId: "reviewer",
      token: "review-token",
      summary: "Looks right.",
    });

    expect(accepted.status).toBe("done");
    expect(accepted.metadata?.automation?.awaitingAcceptance).toBeUndefined();
    // Someone else accepted it; the operator has not opened it, so it stays unseen.
    expect(accepted.metadata?.automation?.acceptanceSeenAt).toBeUndefined();
    expect(workboardCardAcceptanceUnseen(accepted)).toBe(true);
  });

  it("keeps an operator acceptance already on the card instead of restamping it", async () => {
    const { store, card, completed } = await awaitingAcceptance();
    const existingStamp = (completed.metadata?.automation?.autoCompletedAt ?? 0) + 10;
    await store.update(card.id, { acceptanceSeenAt: existingStamp });

    const accepted = await store.update(card.id, { status: "done" });

    expect(accepted.metadata?.automation?.acceptanceSeenAt).toBe(existingStamp);
  });
});
