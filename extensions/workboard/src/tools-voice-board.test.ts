// Workboard voice board binding tests: the board visible at dictation time.
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import plugin from "../index.js";
import { WorkboardStore } from "./store.js";
import { startEmptySessionsBoardService } from "./test/sessions-board.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardSessionsBoardTools } from "./tools-sessions-board.js";
import { createWorkboardTools } from "./tools.js";

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("workboard voice board binding", () => {
  const bind = (boardId: string, boardKind: "cards" | "sessions") => ({
    workContext: { page: "workboard", detail: { boardId, boardKind } },
  });

  it("threads the binding through the registered Sessions board factory", async () => {
    const store = createWorkboardSqliteTestStore();
    await startEmptySessionsBoardService(store);
    await store.upsertBoard({ id: "alpha", kind: "sessions" });
    await store.upsertBoard({ id: "beta", kind: "sessions" });
    using openStore = vi.spyOn(WorkboardStore, "openSqlite");
    openStore.mockReturnValue(store);
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register(
      createTestPluginApi({
        runtimeSource: fileURLToPath(new URL("../index.ts", import.meta.url)),
        registerTool,
      }),
    );
    const [factory] = expectDefined(
      registerTool.mock.calls.find(([, registration]) =>
        registration?.names?.includes("workboard_sessions_board_update"),
      ),
      "Sessions board factory",
    );
    const updateFor = (extra: object) => {
      const context = {
        ...extra,
        assertInvocationCurrent() {
          throw new Error("Caller authority is no longer active.");
        },
      };
      const tools =
        typeof factory === "object" && "create" in factory ? factory.create(context) : undefined;
      if (!Array.isArray(tools)) {
        throw new Error("Expected Sessions board tools from the registered factory.");
      }
      return expectDefined(
        tools.find((entry) => entry.name === "workboard_sessions_board_update"),
        "update",
      );
    };
    const input = { scope: { includeArchived: true } };
    // Two Sessions boards: without a binding the board stays ambiguous.
    await expect(updateFor({}).execute("unbound", input)).rejects.toThrow(
      "boardId is required when more than one Sessions board exists",
    );
    // The binding resolves the board, so the call reaches the live authority check.
    await expect(updateFor(bind("beta", "sessions")).execute("bound", input)).rejects.toThrow(
      "Caller authority is no longer active.",
    );
  });

  it("supplies a missing Sessions board id and never overrides an explicit one", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionsBoard = await startEmptySessionsBoardService(store);
    await store.upsertBoard({ id: "alpha", kind: "sessions" });
    await store.upsertBoard({ id: "beta", kind: "sessions" });
    await store.upsertBoard({ id: "planning", kind: "cards" });
    const toolsFor = (context: object) =>
      new Map(
        createWorkboardSessionsBoardTools({
          store,
          sessionsBoard,
          caller: { assertCurrent() {} },
          ...context,
        }).map((tool) => [tool.name, tool]),
      );
    const read = (context: object, input: object) =>
      expectDefined(toolsFor(context).get("workboard_sessions_board_read"), "read").execute(
        "read",
        input,
      );
    const voiceBoard = { boardId: "beta", boardKind: "sessions" } as const;

    // Absent binding: exact pre-binding payload, no extra field.
    const unbound = readPayload(await read({}, { boardId: "alpha" }));
    expect(Object.keys(unbound)).not.toContain("voiceBoard");
    await expect(read({}, {})).rejects.toThrow(
      "boardId is required when more than one Sessions board exists",
    );

    // Binding fills only the missing id and is reported back additively.
    expect(readPayload(await read({ voiceBoard }, {}))).toMatchObject({
      board: { id: "beta" },
      voiceBoard,
    });
    expect(readPayload(await read({ voiceBoard }, {}))).toEqual({
      ...readPayload(await read({}, { boardId: "beta" })),
      voiceBoard,
    });
    // Explicit argument wins.
    expect(readPayload(await read({ voiceBoard }, { boardId: "alpha" }))).toMatchObject({
      board: { id: "alpha" },
    });
    // Unknown board or a cards-board binding keeps today's ambiguity error.
    for (const stale of [
      { boardId: "gone", boardKind: "sessions" },
      { boardId: "planning", boardKind: "cards" },
      { boardId: "planning", boardKind: "sessions" },
    ] as const) {
      await expect(read({ voiceBoard: stale }, {})).rejects.toThrow(
        "boardId is required when more than one Sessions board exists",
      );
    }

    const move = vi.spyOn(sessionsBoard, "move");
    const moveTool = expectDefined(
      toolsFor({ voiceBoard }).get("workboard_sessions_board_move"),
      "move",
    );
    await expect(
      moveTool.execute("move", { sessionKey: "agent:main:x", columnId: "working" }),
    ).rejects.toThrow("Session is not available in this board's scope.");
    expect(move).toHaveBeenCalledWith("beta", "agent:main:x", "working", expect.anything());
  });

  it("scopes a missing dispatch board to the bound cards board only", async () => {
    const dispatchWith = async (context: object, input: object) => {
      const store = createWorkboardSqliteTestStore();
      await store.upsertBoard({ id: "ops", kind: "sessions" });
      for (const boardId of ["alpha", "beta"]) {
        await store.create({ title: boardId, status: "scheduled", scheduledAt: 1, boardId });
      }
      const dispatch = expectDefined(
        createWorkboardTools({ store, context: { agentId: "main", ...context } }).find(
          (tool) => tool.name === "workboard_dispatch",
        ),
        "dispatch",
      );
      const result = readPayload(await dispatch.execute("dispatch", input));
      return (result.promoted as Array<{ title: string }>).map((card) => card.title).toSorted();
    };

    expect(await dispatchWith({}, {})).toEqual(["alpha", "beta"]);
    expect(await dispatchWith(bind("alpha", "cards"), {})).toEqual(["alpha"]);
    expect(await dispatchWith(bind("alpha", "cards"), { boardId: "beta" })).toEqual(["beta"]);
    for (const stale of [bind("gone", "cards"), bind("ops", "cards"), bind("alpha", "sessions")]) {
      expect(await dispatchWith(stale, {})).toEqual(["alpha", "beta"]);
    }
  });

  it("leaves card-addressed mutations and claim scope unchanged", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Other board", status: "todo", boardId: "beta" });
    const tools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "agent-b", ...bind("alpha", "cards") },
      }).map((tool) => [tool.name, tool]),
    );
    expect(
      readPayload(
        await tools.get("workboard_move")?.execute("move", { id: card.id, status: "ready" }),
      ).card,
    ).toMatchObject({
      id: card.id,
      status: "ready",
      metadata: { automation: { boardId: "beta" } },
    });
    await tools.get("workboard_comment")?.execute("comment", { id: card.id, body: "spoken" });
    expect((await store.get(card.id))?.metadata?.automation?.boardId).toBe("beta");

    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    await expect(
      tools.get("workboard_move")?.execute("denied", { id: card.id, status: "review" }),
    ).rejects.toThrow("card is claimed by agent-a");

    const listed = readPayload(await tools.get("workboard_list")?.execute("list", {}));
    expect(listed.voiceBoard).toEqual({ boardId: "alpha", boardKind: "cards" });
    expect(listed.cards).toEqual([expect.objectContaining({ id: card.id, boardId: "beta" })]);
    const unbound = createWorkboardTools({ store, context: { agentId: "agent-b" } });
    const plain = readPayload(
      await unbound.find((tool) => tool.name === "workboard_list")?.execute("list", {}),
    );
    expect(Object.keys(plain)).toEqual(["cards"]);
  });

  it("fills a missing card id from the bound card and never overrides an explicit one", async () => {
    const store = createWorkboardSqliteTestStore();
    const bound = await store.create({ title: "Bound", status: "todo", boardId: "alpha" });
    const other = await store.create({ title: "Other", status: "todo", boardId: "alpha" });
    const toolsFor = (cardId: string) =>
      new Map(
        createWorkboardTools({
          store,
          context: {
            agentId: "main",
            workContext: {
              page: "workboard",
              detail: { boardId: "alpha", boardKind: "cards", cardId },
            },
          },
        }).map((tool) => [tool.name, tool]),
      );
    const tools = toolsFor(bound.id);

    await tools.get("workboard_move")?.execute("move", { status: "review" });
    await tools.get("workboard_update")?.execute("update", { priority: "high", labelsAdd: ["qa"] });
    await tools.get("workboard_comment")?.execute("comment", { body: "spoken" });
    await tools.get("workboard_reassign")?.execute("reassign", { agentId: "writer" });
    expect(await store.get(bound.id)).toMatchObject({
      status: "review",
      priority: "high",
      labels: ["qa"],
      agentId: "writer",
    });
    expect((await store.get(bound.id))?.metadata?.comments?.at(-1)?.body).toBe("spoken");
    expect(readPayload(await tools.get("workboard_read")?.execute("read", {})).card).toMatchObject({
      id: bound.id,
    });

    // Explicit id wins over the binding.
    await tools.get("workboard_move")?.execute("explicit", { id: other.id, status: "done" });
    expect((await store.get(other.id))?.status).toBe("done");
    expect((await store.get(bound.id))?.status).toBe("review");
  });

  it("moves no card when the bound card is stale, foreign, or missing", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "ops", kind: "sessions" });
    // A single card on the board must not be guessed as the target either.
    const only = await store.create({ title: "Only", status: "todo", boardId: "alpha" });
    const foreign = await store.create({ title: "Foreign", status: "todo", boardId: "beta" });
    const archived = await store.create({ title: "Archived", status: "todo", boardId: "alpha" });
    await store.archive(archived.id, true);
    const before = await store.list();

    for (const detail of [
      { boardId: "alpha", boardKind: "cards" },
      { boardId: "alpha", boardKind: "cards", cardId: "gone" },
      { boardId: "alpha", boardKind: "cards", cardId: foreign.id },
      { boardId: "alpha", boardKind: "cards", cardId: archived.id },
      { boardId: "alpha", boardKind: "sessions", cardId: only.id },
    ]) {
      const tools = new Map(
        createWorkboardTools({
          store,
          context: { agentId: "main", workContext: { page: "workboard", detail } },
        }).map((tool) => [tool.name, tool]),
      );
      await expect(
        tools.get("workboard_move")?.execute("move", { status: "done" }),
      ).rejects.toThrow("id required");
      await expect(
        tools.get("workboard_update")?.execute("update", { priority: "urgent" }),
      ).rejects.toThrow("id required");
    }
    expect(await store.list()).toEqual(before);
  });

  it("keeps claim scope when the card comes from the binding", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Claimed", status: "todo", boardId: "alpha" });
    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    const claimed = await store.get(card.id);
    const move = createWorkboardTools({
      store,
      context: {
        agentId: "agent-b",
        workContext: {
          page: "workboard",
          detail: { boardId: "alpha", boardKind: "cards", cardId: card.id },
        },
      },
    }).find((tool) => tool.name === "workboard_move");
    await expect(move?.execute("move", { status: "done" })).rejects.toThrow(
      "card is claimed by agent-a",
    );
    expect(await store.get(card.id)).toEqual(claimed);
  });
});
