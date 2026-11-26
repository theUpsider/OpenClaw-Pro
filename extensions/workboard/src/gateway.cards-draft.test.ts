import { describe, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import type { WorkboardStore } from "./store.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const context = {
  getRuntimeConfig: () => ({
    agents: { entries: { main: { name: "D" }, c: { name: "C" } } },
  }),
};

function captureDraft(store: WorkboardStore, answer: string | (() => Promise<never>)) {
  const { api, methods } = createGatewayMethodCapture();
  const complete = vi.fn(async () =>
    typeof answer === "string" ? { text: answer } : await answer(),
  );
  Object.assign(api.runtime, { llm: { complete } });
  registerWorkboardGatewayMethods({ api, store });
  return {
    complete,
    async draft(params: Record<string, unknown>) {
      const respond = vi.fn();
      await methods.get("workboard.cards.draft")!.handler({ params, context, respond } as never);
      expect(respond).toHaveBeenCalledOnce();
      return respond.mock.calls[0] as [boolean, unknown, { message?: string } | undefined];
    },
  };
}

async function storeWithPalette() {
  const store = createWorkboardSqliteTestStore();
  // A labelled card seeds the board palette with "Frontend" and "Infra".
  await store.create({ title: "Seed", labels: ["Frontend", "Infra"] });
  return store;
}

describe("workboard.cards.draft", () => {
  it("drafts form fields in the board's own spelling without a model or agent override", async () => {
    const store = await storeWithPalette();
    const { draft, complete } = captureDraft(
      store,
      '```json\n{"title":"Fix the login bug","notes":"Safari only.","priority":"Urgent","status":"todo","labels":["frontend"],"agent":"c"}\n```',
    );

    const [ok, result] = await draft({ voiceText: "  fix the login bug, urgent, frontend  " });

    expect(ok).toBe(true);
    expect(result).toEqual({
      draft: {
        title: "Fix the login bug",
        notes: "Safari only.",
        status: "todo",
        priority: "urgent",
        labels: ["Frontend"],
        agentId: "c",
      },
      hints: [],
    });
    const request = complete.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      purpose: "workboard.cards.draft",
      messages: [{ role: "user", content: "fix the login bug, urgent, frontend" }],
    });
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("agentId");
    expect(request.systemPrompt).toContain("This board's labels: Frontend, Infra.");
    expect(request.systemPrompt).toContain("c (C)");
  });

  it("drops unknown labels, statuses, priorities and agents with a hint instead of guessing", async () => {
    const store = await storeWithPalette();
    const { draft } = captureDraft(
      store,
      '{"title":"Ship it","labels":["INFRA","backend"],"status":"someday","priority":"asap","agent":"ghost"}',
    );

    const [ok, result] = await draft({ voiceText: "ship it" });

    expect(ok).toBe(true);
    expect(result).toEqual({
      draft: { title: "Ship it", labels: ["Infra"] },
      hints: [
        'Status "someday" is not a Workboard status; left out.',
        'Priority "asap" is not a Workboard priority; left out.',
        'Label "backend" is not one of this board\'s labels; left out.',
        'Agent "ghost" is not an assignable agent; left out.',
      ],
    });
  });

  it("sets no labels on a board without a palette and says so", async () => {
    const store = await storeWithPalette();
    const { draft } = captureDraft(store, '{"title":"Plan","labels":["Frontend"]}');

    const [ok, result] = await draft({ voiceText: "plan, label frontend", boardId: "fresh" });

    expect(ok).toBe(true);
    expect(result).toEqual({
      draft: { title: "Plan" },
      hints: ["This board has no labels yet, so no labels were set (heard: Frontend)."],
    });
    // Reading the palette must not seed it.
    await expect(store.readClassifications("fresh")).resolves.toEqual([]);
  });

  it("shortens title and notes to the card limits", async () => {
    const store = createWorkboardSqliteTestStore();
    const { draft } = captureDraft(
      store,
      JSON.stringify({ title: "t".repeat(200), notes: "n".repeat(4100) }),
    );

    const [ok, result] = await draft({ voiceText: "a long one" });

    expect(ok).toBe(true);
    const { draft: fields, hints } = result as {
      draft: { title: string; notes: string };
      hints: string[];
    };
    expect(fields.title).toHaveLength(180);
    expect(fields.notes).toHaveLength(4000);
    expect(hints).toEqual([
      "Title shortened to 180 characters.",
      "Notes shortened to 4000 characters.",
    ]);
  });

  it.each([
    ["prose", "Sure! Here is the card: title Fix login"],
    ["an array", '["Fix login"]'],
    ["a wrongly typed field", '{"title":"Fix login","labels":"frontend"}'],
  ])("fails without a partial draft when the answer is %s", async (_kind, answer) => {
    const store = await storeWithPalette();
    const { draft } = captureDraft(store, answer);

    const [ok, result, error] = await draft({ voiceText: "fix login" });

    expect(ok).toBe(false);
    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/^The model's draft answer /);
  });

  it.each([
    ["a missing voiceText", {}, "voiceText is required."],
    ["an empty voiceText", { voiceText: "   " }, "voiceText is required."],
    [
      "an oversized voiceText",
      { voiceText: "x".repeat(2001) },
      "voiceText must be 2000 characters or fewer.",
    ],
    [
      "a model override",
      { voiceText: "fix login", model: "openai/gpt" },
      "Unknown card draft field: model.",
    ],
    [
      "an agent override",
      { voiceText: "fix login", agentId: "c" },
      "Unknown card draft field: agentId.",
    ],
  ])("rejects %s before calling the model", async (_kind, params, message) => {
    const store = createWorkboardSqliteTestStore();
    const { draft, complete } = captureDraft(store, '{"title":"unused"}');

    const [ok, , error] = await draft(params);

    expect(ok).toBe(false);
    expect(error?.message).toBe(message);
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns the completion failure as a Gateway error", async () => {
    const store = createWorkboardSqliteTestStore();
    const { draft } = captureDraft(store, async () => {
      throw new Error("Plugin LLM completion denied: capability denied");
    });

    const [ok, , error] = await draft({ voiceText: "fix login" });

    expect(ok).toBe(false);
    expect(error?.message).toBe("Plugin LLM completion denied: capability denied");
  });

  it("writes nothing: cards, events, boards and the list revision stay identical", async () => {
    const store = await storeWithPalette();
    const before = {
      cards: await store.list(),
      boards: await store.listBoards(),
      revision: (await store.listCards(undefined)).revision,
    };
    const { draft } = captureDraft(
      store,
      '{"title":"Fix login","labels":["Frontend","backend"],"status":"ready","agent":"c"}',
    );

    const [ok] = await draft({ voiceText: "fix login, frontend, ready, for c" });
    await draft({ voiceText: "and one more", boardId: "fresh" });

    expect(ok).toBe(true);
    const after = await store.list();
    expect(after).toHaveLength(before.cards.length);
    expect(after.flatMap((card) => card.events ?? [])).toHaveLength(
      before.cards.flatMap((card) => card.events ?? []).length,
    );
    expect(after).toEqual(before.cards);
    expect(await store.listBoards()).toEqual(before.boards);
    expect((await store.listCards(undefined)).revision).toEqual(before.revision);
  });
});
