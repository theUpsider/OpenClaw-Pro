// Workboard event attribution: a card write from an agent turn records that agent on its event.
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function toolsFor(store: WorkboardStore, context: OpenClawPluginToolContext) {
  const tools = new Map(createWorkboardTools({ store, context }).map((tool) => [tool.name, tool]));
  return (name: string, params: Record<string, unknown>) => tools.get(name)!.execute(name, params);
}

async function lastEvent(store: WorkboardStore, id: string) {
  return (await store.get(id))?.events?.at(-1);
}

describe("workboard event attribution", () => {
  it("records the tool context agent on every card write a voice turn reaches", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Login bug", status: "todo", boardId: "alpha" });
    const run = toolsFor(store, {
      agentId: "main",
      sessionKey: "agent:main:voice",
      workContext: {
        page: "workboard",
        detail: { boardId: "alpha", boardKind: "cards", cardId: card.id },
      },
    });

    // The bound card fills the omitted id, as on a spoken card turn.
    for (const [name, params] of [
      ["workboard_move", { status: "review" }],
      ["workboard_update", { priority: "high", labelsAdd: ["qa"] }],
      ["workboard_comment", { body: "spoken" }],
      ["workboard_reassign", { agentId: "writer" }],
    ] as const) {
      const before = (await store.get(card.id))?.events ?? [];
      await run(name, params);
      const events = (await store.get(card.id))?.events ?? [];
      expect(events, name).toHaveLength(before.length + 1);
      expect(events.at(-1), name).toMatchObject({ agentId: "main" });
    }
    expect(await store.get(card.id)).toMatchObject({ status: "review", agentId: "writer" });

    const { token } = await store.claim(card.id, { ownerId: "main" });
    await run("workboard_block", { token, reason: "needs a decision" });
    expect(await lastEvent(store, card.id)).toMatchObject({ toStatus: "blocked", agentId: "main" });

    // A worker's own completion is a pending report, not acceptance: the card lands
    // in `review` awaiting acceptance, and the event still names the acting agent.
    const done = await store.create({ title: "Ship", status: "todo", boardId: "alpha" });
    const claimed = await store.claim(done.id, { ownerId: "main" });
    await run("workboard_complete", { id: done.id, token: claimed.token, summary: "shipped" });
    expect(await lastEvent(store, done.id)).toMatchObject({ toStatus: "review", agentId: "main" });
    expect(await store.get(done.id)).toMatchObject({
      status: "review",
      metadata: { automation: { awaitingAcceptance: true, autoCompletedBy: "main" } },
    });
  });

  it("leaves the agent out when the server knows none, and for operator writes", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Anonymous", status: "todo" });

    // The claim owner falls back to the session key; attribution does not.
    await toolsFor(store, { sessionKey: "agent:main:voice" })("workboard_move", {
      id: card.id,
      status: "review",
    });
    expect(await lastEvent(store, card.id)).toMatchObject({ kind: "moved", toStatus: "review" });
    expect(await lastEvent(store, card.id)).not.toHaveProperty("agentId");

    await store.move(card.id, "done", undefined);
    expect(await lastEvent(store, card.id)).not.toHaveProperty("agentId");
  });
});
