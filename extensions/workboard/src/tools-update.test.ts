// Workboard tests cover workboard_update: priority, dispatch mode, and label edits on an existing card.
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function updateTool(store: WorkboardStore, agentId = "agent-b") {
  return expectDefined(
    createWorkboardTools({ store, context: { agentId } }).find(
      (tool) => tool.name === "workboard_update",
    ),
    "workboard_update",
  );
}

async function read(store: WorkboardStore, id: string) {
  return expectDefined(await store.get(id), "card");
}

describe("workboard_update", () => {
  it("sets priority and edits labels by name without touching the others", async () => {
    const store = createWorkboardSqliteTestStore();
    const tool = updateTool(store);
    const card = await store.create({ title: "Login bug", labels: ["Bug", "frontend"] });

    await tool.execute("priority", { id: card.id, priority: "urgent" });
    expect(await read(store, card.id)).toMatchObject({
      priority: "urgent",
      labels: ["Bug", "frontend"],
    });

    await tool.execute("labels", {
      id: card.id,
      labelsAdd: ["bug", " needs-qa ", "needs-qa"],
      labelsRemove: ["FRONTEND", "absent"],
    });
    expect((await read(store, card.id)).labels).toEqual(["Bug", "needs-qa"]);
  });

  it("rejects empty and invalid requests without writing", async () => {
    const store = createWorkboardSqliteTestStore();
    const tool = updateTool(store);
    const card = await store.create({ title: "Unchanged", labels: ["bug"] });

    expect(Value.Check(tool.parameters, { id: card.id, priority: "critical" })).toBe(false);
    await expect(tool.execute("empty", { id: card.id })).rejects.toThrow(
      "Pass priority, labelsAdd, labelsRemove, decisionOptions, dispatchMode, ask, or askKind.",
    );
    await expect(tool.execute("invalid", { id: card.id, priority: "critical" })).rejects.toThrow(
      "priority must be one of",
    );
    // Removing an absent label is a no-op, not a write.
    await tool.execute("noop", { id: card.id, labelsRemove: ["absent"] });

    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("sets and clears external placement through the schema-checked field", async () => {
    const store = createWorkboardSqliteTestStore();
    const tool = updateTool(store);
    const card = await store.create({ title: "Switchable card" });

    expect(Value.Check(tool.parameters, { id: card.id, dispatchMode: "remote" })).toBe(false);
    expect(Value.Check(tool.parameters, { id: card.id, dispatchMode: "external" })).toBe(true);

    await tool.execute("external", { id: card.id, dispatchMode: "external" });
    expect((await read(store, card.id)).metadata?.automation?.dispatchMode).toBe("external");

    await tool.execute("native", { id: card.id, dispatchMode: "native" });
    expect((await read(store, card.id)).metadata?.automation?.dispatchMode).toBe("native");

    // An unknown mode is refused by the store before the card is written.
    await expect(tool.execute("invalid", { id: card.id, dispatchMode: "remote" })).rejects.toThrow(
      "dispatch mode must be one of: native, external.",
    );
    expect((await read(store, card.id)).metadata?.automation?.dispatchMode).toBe("native");
  });

  it("requires claim scope for claimed cards", async () => {
    const store = createWorkboardSqliteTestStore();
    const tool = updateTool(store, "agent-b");
    const card = await store.create({ title: "Claimed card", status: "todo" });
    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    const claimed = await read(store, card.id);

    await expect(tool.execute("denied", { id: card.id, priority: "high" })).rejects.toThrow(
      "card is claimed by agent-a",
    );
    await expect(store.get(card.id)).resolves.toEqual(claimed);

    await tool.execute("allowed", { id: card.id, token: "test-auth-token", priority: "high" });
    expect((await read(store, card.id)).priority).toBe("high");
  });

  it("refuses a label list built on a card that changed after it was read", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Raced card", labels: ["bug"] });
    // A concurrent writer lands between the tool's read and its write.
    let interleaved = false;
    const racingStore = new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "update" || typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]) => {
          if (!interleaved) {
            interleaved = true;
            await store.update(card.id, { labels: ["bug", "someone-else"] });
          }
          return await (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    }) as WorkboardStore;

    await expect(
      updateTool(racingStore).execute("raced", { id: card.id, labelsAdd: ["needs-qa"] }),
    ).rejects.toThrow(/changed while you were editing/i);
    expect((await read(store, card.id)).labels).toEqual(["bug", "someone-else"]);
  });
});
