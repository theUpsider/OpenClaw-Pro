import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const laneCard = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  status: "ready" as const,
  agentId: "b",
  workspaceAccess: { unrestricted: true } as const,
  ...extra,
});

describe("Workboard lane queue in dispatch results", () => {
  it("starts the first card of a lane and reports the second as queued, never starting either twice", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create(laneCard("Lane card one", { position: 1000 }));
    const second = await store.create(laneCard("Lane card two", { position: 2000 }));
    const run = vi.fn().mockResolvedValue({ runId: "run-lane" });

    const startFirst = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { cardId: first.id, now: 10 },
    });
    expect(startFirst.started).toEqual([expect.objectContaining({ cardId: first.id })]);
    expect(startFirst.startFailures).toEqual([]);
    expect(startFirst.skipped).toEqual([]);

    const startSecond = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { cardId: second.id, now: 20 },
    });
    expect(startSecond.started).toEqual([]);
    expect(startSecond.startFailures).toEqual([]);
    expect(startSecond.skipped).toEqual([
      { cardId: second.id, title: "Lane card two", ownerId: "b", reason: "owner_busy" },
    ]);

    // A later scheduled pass neither restarts the holder nor fails the waiting card.
    const pass = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 30 },
    });
    expect(pass.started).toEqual([]);
    expect(pass.startFailures).toEqual([]);
    expect(pass.skipped).toEqual([expect.objectContaining({ cardId: second.id })]);

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({ message: expect.stringContaining(first.id) });
    await expect(store.get(first.id)).resolves.toMatchObject({ status: "running" });
    const waiting = await store.get(second.id);
    expect(waiting?.status).toBe("ready");
    expect(waiting?.metadata?.claim).toBeUndefined();
  });

  it("reports a card queued behind one this pass started", async () => {
    const store = createWorkboardSqliteTestStore();
    const urgent = await store.create(laneCard("Urgent lane work", { priority: "urgent" }));
    const later = await store.create(laneCard("Later lane work"));
    const other = await store.create(laneCard("Other lane work", { agentId: "c" }));
    const run = vi.fn().mockResolvedValue({ runId: "run-pass" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started.map((entry) => entry.cardId).toSorted()).toEqual(
      [urgent.id, other.id].toSorted(),
    );
    expect(result.skipped).toEqual([
      { cardId: later.id, title: "Later lane work", ownerId: "b", reason: "owner_busy" },
    ]);
    expect(result.startFailures).toEqual([]);
    expect(result.count).toBe(2);
  });

  it("reports nothing for free lanes, non-ready cards, or parallel cards under their ceiling", async () => {
    const store = createWorkboardSqliteTestStore();
    const parallel = { parallelizable: true, maxConcurrentPerOwner: 2 };
    await store.create(laneCard("Running parallel", { status: "running", ...parallel }));
    const sibling = await store.create(laneCard("Ready parallel", parallel));
    await store.create(laneCard("Todo behind it", { status: "todo" }));
    const free = await store.create(laneCard("Free lane", { agentId: "c" }));
    const run = vi.fn().mockResolvedValue({ runId: "run-free" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started.map((entry) => entry.cardId).toSorted()).toEqual(
      [sibling.id, free.id].toSorted(),
    );
    expect(result.skipped).toEqual([]);
  });

  it("explains an exact start behind a busy lane as a queue position", async () => {
    const { methods, registerGatewayMethod } = createGatewayMethodCapture();
    const run = vi.fn();
    const api = {
      runtime: {
        state: { openKeyedStore: vi.fn() },
        subagent: { run },
      },
      registerGatewayMethod,
    } as unknown as OpenClawPluginApi;
    const store = createWorkboardSqliteTestStore();
    await store.create({ title: "Holder", status: "running", agentId: "b" });
    const card = await store.create({
      title: "Queued exact start",
      status: "ready",
      agentId: "b",
      workspaceAccess: { unrestricted: true },
    });
    registerWorkboardGatewayMethods({ api, store });
    const respond = vi.fn();

    await methods.get("workboard.cards.start")?.handler({
      params: { id: card.id },
      context: { getRuntimeConfig: () => ({}) },
      respond,
    } as never);

    expect(run).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringMatching(/^Card is queued: b .*once that slot frees\.$/),
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });
});
