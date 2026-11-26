// Workboard tests cover opting existing cards in and out of parallel owner slots.
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { workboardCardIsParallelizable, workboardOwnerSlotLimit } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("workboard_set_parallelism", () => {
  function parallelismTool(store: WorkboardStore, agentId = "agent-b") {
    return expectDefined(
      createWorkboardTools({ store, context: { agentId } }).find(
        (tool) => tool.name === "workboard_set_parallelism",
      ),
      "workboard_set_parallelism",
    );
  }

  async function read(store: WorkboardStore, id: string) {
    return expectDefined(await store.get(id), "card");
  }

  it("sets and clears parallelism on an existing card", async () => {
    const store = createWorkboardSqliteTestStore();
    const tool = parallelismTool(store);
    const card = await store.create({ title: "Existing card", labels: ["bug"] });

    const set = readPayload(
      await tool.execute("set", { id: card.id, parallelizable: true, maxConcurrentPerOwner: 2 }),
    );
    expect(set.card).toMatchObject({ labels: ["bug", "parallelizable"] });
    const opted = await read(store, card.id);
    expect(opted.metadata?.automation).toMatchObject({
      parallelizable: true,
      maxConcurrentPerOwner: 2,
    });
    expect(workboardOwnerSlotLimit(opted)).toBe(2);

    await tool.execute("clear-ceiling", { id: card.id, maxConcurrentPerOwner: null });
    const cleared = await read(store, card.id);
    expect(Object.hasOwn(cleared.metadata?.automation ?? {}, "maxConcurrentPerOwner")).toBe(false);
    expect(cleared.labels).toEqual(["bug", "parallelizable"]);
    expect(workboardOwnerSlotLimit(cleared)).toBe(1);

    await tool.execute("off", { id: card.id, parallelizable: false });
    const off = await read(store, card.id);
    expect(off.labels).toEqual(["bug"]);
    expect(workboardCardIsParallelizable(off)).toBe(false);
  });

  it("rejects out-of-range ceilings and empty requests without writing", async () => {
    const store = createWorkboardSqliteTestStore();
    const tool = parallelismTool(store);
    const card = await store.create({ title: "Bounded card" });

    for (const value of [0, 17, 1.5, "3"]) {
      expect(Value.Check(tool.parameters, { id: card.id, maxConcurrentPerOwner: value })).toBe(
        false,
      );
    }
    for (const value of [1, 16, null]) {
      expect(Value.Check(tool.parameters, { id: card.id, maxConcurrentPerOwner: value })).toBe(
        true,
      );
    }
    await expect(
      tool.execute("too-high", { id: card.id, parallelizable: true, maxConcurrentPerOwner: 17 }),
    ).rejects.toThrow("maxConcurrentPerOwner must be an integer from 1 to 16");
    await expect(tool.execute("empty", { id: card.id })).rejects.toThrow(
      "Set parallelizable, maxConcurrentPerOwner, or both.",
    );

    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("requires claim scope for claimed cards", async () => {
    const store = createWorkboardSqliteTestStore();
    const tool = parallelismTool(store, "agent-b");
    const card = await store.create({ title: "Claimed card", status: "todo" });
    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    const claimed = await read(store, card.id);

    await expect(
      tool.execute("denied", { id: card.id, parallelizable: true, maxConcurrentPerOwner: 2 }),
    ).rejects.toThrow("card is claimed by agent-a");
    await expect(store.get(card.id)).resolves.toEqual(claimed);

    await tool.execute("allowed", {
      id: card.id,
      token: "test-auth-token",
      parallelizable: true,
      maxConcurrentPerOwner: 2,
    });
    expect(workboardOwnerSlotLimit(await read(store, card.id))).toBe(2);
  });

  it("lets the dispatcher start two cards of one owner after opting them in", async () => {
    async function dispatchTwoReadyCards(optIn: boolean) {
      const store = createWorkboardSqliteTestStore();
      const tool = parallelismTool(store);
      const cards = [];
      for (const priority of ["urgent", "high"] as const) {
        const card = await store.create({
          title: `Shared owner ${priority}`,
          status: "ready",
          priority,
          agentId: "shared-worker",
          workspaceAccess: { unrestricted: true },
        });
        if (optIn) {
          await tool.execute(`opt-in-${priority}`, {
            id: card.id,
            parallelizable: true,
            maxConcurrentPerOwner: 2,
          });
        }
        cards.push(card);
      }
      const run = vi.fn().mockResolvedValue({ runId: "run-shared" });
      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: { now: 10, maxStarts: 3 },
      });
      return result.started.map((entry) => entry.cardId).length;
    }

    expect(await dispatchTwoReadyCards(false)).toBe(1);
    expect(await dispatchTwoReadyCards(true)).toBe(2);
  });
});
