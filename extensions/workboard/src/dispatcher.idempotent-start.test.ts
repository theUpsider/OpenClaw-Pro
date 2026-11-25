import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const options = { maxStarts: 1, workspaceAccess: { unrestricted: true } } as const;

function startedRun() {
  return vi.fn(async (input: { idempotencyKey?: string }) => ({
    runId: `run-for-${input.idempotencyKey}`,
  }));
}

describe("Workboard dispatcher starts each attempt once", () => {
  it("starts exactly one run for repeated and racing dispatch passes", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Single start",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const run = startedRun();

    const [first, racing] = await Promise.all([
      dispatchAndStartWorkboardCards({ store, subagent: { run }, options }),
      dispatchAndStartWorkboardCards({ store, subagent: { run }, options }),
    ]);
    const repeated = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { ...options, cardId: card.id },
    });

    expect(run).toHaveBeenCalledOnce();
    expect([...first.started, ...racing.started, ...repeated.started]).toHaveLength(1);
    expect(repeated.startFailures).toEqual([expect.objectContaining({ cardId: card.id })]);
    const current = await store.get(card.id);
    expect(
      current?.metadata?.attempts?.filter((attempt) => attempt.status === "running"),
    ).toHaveLength(1);
  });

  it("refuses a new attempt while the previous one is still open, even with a free slot", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Moved back while running",
      status: "ready",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const run = startedRun();
    await dispatchAndStartWorkboardCards({ store, subagent: { run }, options });
    // The operator moves the card back while its worker run is still open.
    await store.releaseClaim(card.id, { status: "ready" }, null);
    expect((await store.get(card.id))?.metadata?.attempts?.at(-1)?.status).toBe("running");

    const scheduled = await dispatchAndStartWorkboardCards({ store, subagent: { run }, options });
    const exact = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { ...options, cardId: card.id },
    });

    expect(run).toHaveBeenCalledOnce();
    // Scheduled passes skip the card quietly, as they do claimed cards.
    expect(scheduled.started).toEqual([]);
    expect(scheduled.startFailures).toEqual([]);
    expect(exact.startFailures).toEqual([
      expect.objectContaining({ cardId: card.id, error: expect.stringMatching(/running attempt/) }),
    ]);
    await expect(store.claim(card.id, { ownerId: "other-worker" })).rejects.toThrow(
      /running attempt/,
    );
  });

  it("reuses the persisted attempt identity when the same claim prepares again", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Prepared twice", status: "ready" });
    const claimed = await store.claim(card.id, { ownerId: "worker" });
    const prepare = () =>
      store.prepareExecutionLaunch(card.id, {
        requestedSessionKey: "subagent:workboard-default-prepared-twice",
        now: Date.now(),
        scope: { ownerId: "worker", token: claimed.token },
      });

    const first = await prepare();
    const again = await prepare();

    expect(again.launch).toEqual(first.launch);
    expect(again.card).toEqual(first.card);
  });
});
