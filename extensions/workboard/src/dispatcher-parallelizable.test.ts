import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import {
  DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT,
  MAX_WORKBOARD_OWNER_SLOT_LIMIT,
  workboardCardIsParallelizable,
  workboardOwnerSlotLimit,
} from "./store-constants.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard parallelizable owner slots", () => {
  it("keeps the single owner slot for cards that do not opt in", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create({
      title: "Serialized urgent worker",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Serialized follow-up worker",
      status: "ready",
      priority: "high",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-serialized" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    // (a) Default behaviour is unchanged: one owner, one worker.
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: first.id, runId: "run-serialized" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(first.id)).resolves.toMatchObject({ status: "running" });
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("starts opted-in cards of one owner in parallel up to the declared ceiling", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create({
      title: "Parallel worker A",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Parallel worker B",
      status: "ready",
      priority: "high",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const third = await store.create({
      title: "Parallel worker C",
      status: "ready",
      priority: "normal",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-parallel" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 5 },
    });

    // (b) Opt-in cards run alongside each other, capped at the declared ceiling.
    expect(result.started.map((entry) => entry.cardId)).toEqual([first.id, second.id, third.id]);
    expect(run).toHaveBeenCalledTimes(3);
    for (const card of [first, second, third]) {
      await expect(store.get(card.id)).resolves.toMatchObject({
        status: "running",
        metadata: {
          automation: { parallelizable: true, maxConcurrentPerOwner: 3 },
        },
      });
    }
  });

  it("caps parallelism at the declared ceiling and leaves the extra card ready", async () => {
    const store = createWorkboardSqliteTestStore();
    const cards = [];
    for (const [index, priority] of (["urgent", "high", "normal", "low"] as const).entries()) {
      cards.push(
        await store.create({
          title: `Parallel worker ${index + 1}`,
          status: "ready",
          priority,
          agentId: "shared-worker",
          parallelizable: true,
          maxConcurrentPerOwner: 3,
          workspaceAccess: { unrestricted: true },
        }),
      );
    }
    const run = vi.fn().mockResolvedValue({ runId: "run-capped" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 5 },
    });

    // The ceiling, not maxStarts, is what stops the fourth card.
    expect(result.started.map((entry) => entry.cardId)).toEqual([
      cards[0].id,
      cards[1].id,
      cards[2].id,
    ]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.startFailures).toEqual([]);
    await expect(store.get(cards[3].id)).resolves.toMatchObject({ status: "ready" });
  });

  it("does not over-admit when an owner is already partly full", async () => {
    const store = createWorkboardSqliteTestStore();
    const running = await store.create({
      title: "Already running parallel worker",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    // Occupy one of the two slots for that owner.
    await store.claim(running.id, { ownerId: "shared-worker", token: "running-token" });
    const first = await store.create({
      title: "Queued parallel worker A",
      status: "ready",
      priority: "high",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Queued parallel worker B",
      status: "ready",
      priority: "normal",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-partly-full" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 5 },
    });

    // One free slot: only the first queued card starts, and the second is not
    // reported as a failed start the dispatcher would otherwise retry forever.
    expect(result.started.map((entry) => entry.cardId)).toEqual([first.id]);
    expect(result.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(second.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("serializes an owner as soon as one competing card stays non-opt-in", async () => {
    const store = createWorkboardSqliteTestStore();
    const parallel = await store.create({
      title: "Parallel worker with a serial sibling",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const serial = await store.create({
      title: "Non-opt-in sibling",
      status: "ready",
      priority: "high",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-mixed" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 5 },
    });

    // (c) A non-opt-in card pins its owner back to the historical single slot.
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: parallel.id, runId: "run-mixed" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(serial.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("does not raise the ceiling for a flag without a concurrency value", async () => {
    const store = createWorkboardSqliteTestStore();
    const flagged = await store.create({
      title: "Flagged without a ceiling",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      parallelizable: true,
      workspaceAccess: { unrestricted: true },
    });
    const sibling = await store.create({
      title: "Sibling behind the default ceiling",
      status: "ready",
      agentId: "shared-worker",
      parallelizable: true,
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-default-ceiling" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 5 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: flagged.id, runId: "run-default-ceiling" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(sibling.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("honours the opt-in label from the card side table", async () => {
    const store = createWorkboardSqliteTestStore();
    const labelled = await store.create({
      title: "Labelled parallel worker",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      labels: ["parallelizable"],
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    const sibling = await store.create({
      title: "Labelled sibling worker",
      status: "ready",
      agentId: "shared-worker",
      labels: ["parallelizable"],
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-labelled" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 5 },
    });

    expect(result.started.map((entry) => entry.cardId)).toEqual([labelled.id, sibling.id]);
    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(labelled.id)).resolves.toMatchObject({
      labels: ["parallelizable"],
      status: "running",
    });
  });

  it("blocks the DB claim gate for a second non-opt-in card at the same owner", async () => {
    const store = createWorkboardSqliteTestStore();
    const active = await store.create({
      title: "Active serial worker",
      status: "running",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const queued = await store.create({
      title: "Queued serial worker",
      status: "ready",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });

    await expect(
      store.claim(queued.id, { ownerId: "shared-worker", token: "queued-token" }),
    ).rejects.toThrow("already has active Workboard work");
    await expect(store.get(queued.id)).resolves.toMatchObject({ status: "ready" });
    await expect(store.get(active.id)).resolves.toMatchObject({ status: "running" });
  });

  it("admits opted-in claims up to the ceiling and then blocks the next one", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create({
      title: "Parallel claim A",
      status: "ready",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Parallel claim B",
      status: "ready",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    const third = await store.create({
      title: "Parallel claim C",
      status: "ready",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });

    await store.claim(first.id, { ownerId: "shared-worker", token: "token-a" });
    await store.claim(second.id, { ownerId: "shared-worker", token: "token-b" });
    await expect(
      store.claim(third.id, { ownerId: "shared-worker", token: "token-c" }),
    ).rejects.toThrow("already has active Workboard work");
    await expect(store.get(third.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("blocks a non-opt-in card at the DB gate while an opt-in sibling runs", async () => {
    const store = createWorkboardSqliteTestStore();
    const parallel = await store.create({
      title: "Running opt-in worker",
      status: "ready",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const serial = await store.create({
      title: "Non-opt-in worker beside it",
      status: "ready",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });

    await store.claim(parallel.id, { ownerId: "shared-worker", token: "token-parallel" });

    // Tightest limit wins at the gate too, not just in dispatcher selection.
    await expect(
      store.claim(serial.id, { ownerId: "shared-worker", token: "token-serial" }),
    ).rejects.toThrow("already has active Workboard work");
    await expect(store.get(serial.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("blocks an opt-in card at the DB gate while a non-opt-in sibling runs", async () => {
    const store = createWorkboardSqliteTestStore();
    const serial = await store.create({
      title: "Running non-opt-in worker",
      status: "ready",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    const parallel = await store.create({
      title: "Opt-in worker beside it",
      status: "ready",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });

    await store.claim(serial.id, { ownerId: "shared-worker", token: "token-serial" });

    await expect(
      store.claim(parallel.id, { ownerId: "shared-worker", token: "token-parallel" }),
    ).rejects.toThrow("already has active Workboard work");
    await expect(store.get(parallel.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("round-trips the opt-in flag and clamps the stored ceiling", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Round-trip worker",
      status: "ready",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { automation: { parallelizable: true, maxConcurrentPerOwner: 3 } },
    });

    // A wild ceiling is stored clamped, so the UI cannot advertise more than the gates allow.
    const clamped = await store.update(card.id, { maxConcurrentPerOwner: 10_000 });
    expect(clamped.metadata?.automation?.maxConcurrentPerOwner).toBe(
      MAX_WORKBOARD_OWNER_SLOT_LIMIT,
    );

    // Turning the flag off restores the single-slot behaviour.
    const off = await store.update(card.id, { parallelizable: false });
    expect(off.metadata?.automation?.parallelizable).toBeUndefined();

    // Prove it by behaviour, not just by the absent field: a sibling can no
    // longer start beside this card even though the ceiling is still stored.
    const sibling = await store.create({
      title: "Sibling of a card that opted back out",
      status: "ready",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(card.id, { ownerId: "shared-worker", token: "token-opted-out" });
    await expect(
      store.claim(sibling.id, { ownerId: "shared-worker", token: "token-sibling" }),
    ).rejects.toThrow("already has active Workboard work");
  });

  it("treats the opt-in label case-insensitively at the DB gate", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create({
      title: "Mixed-case label worker A",
      status: "ready",
      agentId: "shared-worker",
      labels: ["Parallelizable"],
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Mixed-case label worker B",
      status: "ready",
      agentId: "shared-worker",
      labels: ["parallelizable"],
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });

    await store.claim(first.id, { ownerId: "shared-worker", token: "token-a" });
    // Both spellings must be recognised, or the second claim would be rejected.
    await expect(
      store.claim(second.id, { ownerId: "shared-worker", token: "token-b" }),
    ).resolves.toMatchObject({ card: { status: "running" } });
  });

  it("serializes an owner at the dispatcher when a non-opt-in card is already running", async () => {
    const store = createWorkboardSqliteTestStore();
    const running = await store.create({
      title: "Running non-opt-in worker",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      workspaceAccess: { unrestricted: true },
    });
    await store.claim(running.id, { ownerId: "shared-worker", token: "running-token" });
    const parallel = await store.create({
      title: "Opt-in worker behind a serial one",
      status: "ready",
      priority: "high",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "unexpected-parallel" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    // The running serial card pins the owner to one slot, so selection rejects
    // the opt-in candidate up front instead of failing it at the claim gate.
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(parallel.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("uses the tightest ceiling when competing cards declare different limits", async () => {
    const store = createWorkboardSqliteTestStore();
    const narrow = await store.create({
      title: "Narrow-ceiling worker",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 2,
      workspaceAccess: { unrestricted: true },
    });
    const wide = await store.create({
      title: "Wide-ceiling worker",
      status: "ready",
      priority: "high",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 5,
      workspaceAccess: { unrestricted: true },
    });
    const extra = await store.create({
      title: "Extra worker past the narrow ceiling",
      status: "ready",
      priority: "normal",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 5,
      workspaceAccess: { unrestricted: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-tightest" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 5 },
    });

    // 2 beats 5: the third card waits even though it declares the wider ceiling.
    expect(result.started.map((entry) => entry.cardId)).toEqual([narrow.id, wide.id]);
    expect(result.startFailures).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(extra.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("lets a fallback card take the parallel slot of a failed start", async () => {
    const store = createWorkboardSqliteTestStore();
    const failing = await store.create({
      title: "Failing parallel worker",
      status: "ready",
      priority: "urgent",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const healthy = await store.create({
      title: "Healthy parallel worker",
      status: "ready",
      priority: "high",
      agentId: "shared-worker",
      parallelizable: true,
      maxConcurrentPerOwner: 3,
      workspaceAccess: { unrestricted: true },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ runId: "run-recovered" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    // A failed start must not consume the slot its fallback needs.
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: healthy.id, runId: "run-recovered" }),
    ]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: failing.id, error: "provider unavailable" }),
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    await expect(store.get(healthy.id)).resolves.toMatchObject({ status: "running" });
  });

  it("maps the opt-in marker and ceiling with sane defaults and a guardrail", () => {
    expect(workboardCardIsParallelizable({ labels: [] })).toBe(false);
    expect(workboardCardIsParallelizable({ labels: ["Parallelizable"] })).toBe(true);
    expect(workboardCardIsParallelizable({ labels: [], metadata: {} })).toBe(false);
    expect(
      workboardCardIsParallelizable({
        labels: [],
        metadata: { automation: { parallelizable: true } },
      }),
    ).toBe(true);

    expect(workboardOwnerSlotLimit({ labels: [] })).toBe(DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT);
    expect(workboardOwnerSlotLimit({ labels: ["parallelizable"] })).toBe(
      DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT,
    );
    expect(
      workboardOwnerSlotLimit({
        labels: ["parallelizable"],
        metadata: { automation: { maxConcurrentPerOwner: 3 } },
      }),
    ).toBe(3);
    expect(
      workboardOwnerSlotLimit({
        labels: ["parallelizable"],
        metadata: { automation: { maxConcurrentPerOwner: 10_000 } },
      }),
    ).toBe(MAX_WORKBOARD_OWNER_SLOT_LIMIT);
    // A ceiling without the flag never widens the historical single slot.
    expect(
      workboardOwnerSlotLimit({
        labels: [],
        metadata: { automation: { maxConcurrentPerOwner: 3 } },
      }),
    ).toBe(DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT);
  });
});
