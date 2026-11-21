// Workboard card interaction link: a card-bound turn records which session is editing.
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function toolsFor(store: WorkboardStore, context: OpenClawPluginToolContext) {
  const tools = new Map(createWorkboardTools({ store, context }).map((tool) => [tool.name, tool]));
  return (name: string, params: Record<string, unknown>) => tools.get(name)!.execute(name, params);
}

const cardBound = (cardId: string) => ({
  page: "workboard" as const,
  detail: { boardId: "alpha", boardKind: "cards" as const, cardId },
});

function interactionOf(card: WorkboardCard | undefined, name: string) {
  return { name, interaction: card?.metadata?.interaction };
}

describe("workboard card interaction link", () => {
  it("records the caller session on every card-bound write and nothing else changes", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Dictated",
      status: "todo",
      boardId: "alpha",
      sessionKey: "agent:main:exec",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        mode: "autonomous",
        status: "running",
        sessionKey: "agent:main:exec",
        startedAt: 1,
        updatedAt: 2,
      },
    });
    const baseline = await store.get(card.id);
    const run = toolsFor(store, {
      agentId: "main",
      sessionKey: "agent:main:voice",
      workContext: cardBound(card.id),
    });

    const touched: Array<[string, Record<string, unknown>]> = [
      ["workboard_move", { status: "review" }],
      ["workboard_update", { priority: "high", labelsAdd: ["qa"] }],
      ["workboard_comment", { body: "spoken" }],
      ["workboard_reassign", { agentId: "writer" }],
      ["workboard_set_parallelism", { parallelizable: true, maxConcurrentPerOwner: 2 }],
    ];
    for (const [name, params] of touched) {
      await run(name, params);
      const current = await store.get(card.id);
      expect(interactionOf(current, name).interaction).toMatchObject({
        sessionKey: "agent:main:voice",
        agentId: "main",
        surface: "plugin-dock",
      });
      expect(current?.metadata?.interaction?.startedAt).toBeGreaterThan(0);
      expect(current?.metadata?.interaction?.updatedAt).toBeGreaterThanOrEqual(
        current?.metadata?.interaction?.startedAt ?? 0,
      );
      // The interaction link never becomes an execution link.
      expect(current?.sessionKey).toBe(baseline?.sessionKey);
      expect(current?.execution).toEqual(baseline?.execution);
    }

    // The first turn keeps `startedAt`; a later turn only moves `updatedAt`.
    const started = (await store.get(card.id))?.metadata?.interaction?.startedAt;
    await run("workboard_comment", { body: "second turn" });
    const after = (await store.get(card.id))?.metadata?.interaction;
    expect(after?.startedAt).toBe(started);
    expect(after?.updatedAt).toBeGreaterThanOrEqual(started ?? 0);
  });

  it("records nothing on a board-level turn, an unbound turn, or an explicit id", async () => {
    const store = createWorkboardSqliteTestStore();
    const bound = await store.create({ title: "Bound", status: "todo", boardId: "alpha" });
    const other = await store.create({ title: "Other", status: "todo", boardId: "alpha" });
    const boardLevel = { page: "workboard" as const, detail: { boardId: "alpha" } };

    // Board-level voice turn: the card comes from an explicit id, so no card binding.
    const unbound = toolsFor(store, {
      agentId: "main",
      sessionKey: "agent:main:voice",
      workContext: boardLevel,
    });
    await unbound("workboard_comment", { id: bound.id, body: "board level" });
    expect((await store.get(bound.id))?.metadata?.interaction).toBeUndefined();

    // No work context at all: a plain agent edit.
    const plain = toolsFor(store, { agentId: "main", sessionKey: "agent:main:voice" });
    await plain("workboard_comment", { id: bound.id, body: "plain" });
    expect((await store.get(bound.id))?.metadata?.interaction).toBeUndefined();

    // A card-bound turn still names the session that ran the write, even when the
    // model passes the id explicitly: the link describes who is editing the card.
    const pointing = toolsFor(store, {
      agentId: "main",
      sessionKey: "agent:main:voice",
      workContext: cardBound(bound.id),
    });
    await pointing("workboard_comment", { id: other.id, body: "explicit" });
    expect((await store.get(other.id))?.metadata?.interaction).toMatchObject({
      sessionKey: "agent:main:voice",
    });
    expect((await store.get(bound.id))?.metadata?.interaction).toBeUndefined();
  });

  // The link is host-resolved provenance, so a caller-supplied patch may not mint it.
  // `store.update` is the operator/Gateway path (bulk edit, CLI); it must not be able to
  // forge an interaction, while a stamped card keeps the value the owner recorded.
  it("never mints the link from a caller-supplied patch", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Forged", status: "todo", boardId: "alpha" });

    await store.update(card.id, {
      metadata: {
        interaction: {
          sessionKey: "agent:attacker:forged",
          agentId: "attacker",
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    expect((await store.get(card.id))?.metadata?.interaction).toBeUndefined();

    // A stamped card survives an unrelated operator patch with its owner value intact.
    const bound = await store.create({ title: "Stamped", status: "todo", boardId: "alpha" });
    await toolsFor(store, {
      agentId: "main",
      sessionKey: "agent:main:voice",
      workContext: cardBound(bound.id),
    })("workboard_comment", { body: "spoken" });
    const stamped = (await store.get(bound.id))?.metadata?.interaction;
    expect(stamped).toMatchObject({ sessionKey: "agent:main:voice" });

    await store.update(bound.id, { priority: "high" });
    await store.update(bound.id, {
      metadata: {
        interaction: { sessionKey: "agent:attacker:forged", startedAt: 1, updatedAt: 1 },
      },
    });
    expect((await store.get(bound.id))?.metadata?.interaction).toMatchObject({
      sessionKey: "agent:main:voice",
    });
  });

  it("records nothing when the server resolves no session key", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Anonymous", status: "todo", boardId: "alpha" });
    // A card binding without a session key has nothing to link; absent, not empty.
    const run = toolsFor(store, {
      agentId: "main",
      workContext: cardBound(card.id),
    });
    await run("workboard_comment", { body: "no session" });
    expect((await store.get(card.id))?.metadata?.interaction).toBeUndefined();
  });
});
