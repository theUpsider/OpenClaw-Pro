import { describe, expect, it } from "vitest";
import {
  readVoiceBoardBinding,
  resolveBoundBoardId,
  resolveBoundCardId,
} from "./voice-board-binding.js";

describe("readVoiceBoardBinding", () => {
  it("reads the board the Control UI captured into the run work context", () => {
    expect(
      readVoiceBoardBinding({
        workContext: { page: "workboard", detail: { boardId: " planning ", boardKind: "cards" } },
      }),
    ).toEqual({ boardId: "planning", boardKind: "cards" });
    expect(
      readVoiceBoardBinding({
        workContext: { page: "workboard", detail: { boardId: "ops", boardKind: "sessions" } },
      }),
    ).toEqual({ boardId: "ops", boardKind: "sessions" });
  });

  it("reads the card a card detail view captured, ignoring a blank one", () => {
    const bind = (cardId: unknown) => ({
      workContext: {
        page: "workboard",
        detail: { boardId: "planning", boardKind: "cards", cardId },
      },
    });
    expect(readVoiceBoardBinding(bind(" card-1 "))).toEqual({
      boardId: "planning",
      boardKind: "cards",
      cardId: "card-1",
    });
    for (const cardId of [undefined, "", "  ", 7]) {
      expect(readVoiceBoardBinding(bind(cardId as never))).toEqual({
        boardId: "planning",
        boardKind: "cards",
      });
    }
    // A card without its board is not a binding.
    expect(
      readVoiceBoardBinding({ workContext: { page: "workboard", detail: { cardId: "card-1" } } }),
    ).toBeUndefined();
  });

  it.each([
    ["no context", undefined],
    ["null context", null],
    ["no work context", {}],
    [
      "another page",
      { workContext: { page: "chat", detail: { boardId: "x", boardKind: "cards" } } },
    ],
    ["no detail", { workContext: { page: "workboard" } }],
    ["empty detail", { workContext: { page: "workboard", detail: {} } }],
    [
      "empty boardId",
      { workContext: { page: "workboard", detail: { boardId: "", boardKind: "cards" } } },
    ],
    [
      "blank boardId",
      { workContext: { page: "workboard", detail: { boardId: "  ", boardKind: "cards" } } },
    ],
    ["missing kind", { workContext: { page: "workboard", detail: { boardId: "x" } } }],
    [
      "wrong kind",
      { workContext: { page: "workboard", detail: { boardId: "x", boardKind: "Cards" } } },
    ],
    ["empty object", { workContext: {} }],
    ["null work context", { workContext: null }],
  ])("returns undefined without throwing for %s", (_label, ctx) => {
    expect(() => readVoiceBoardBinding(ctx as never)).not.toThrow();
    expect(readVoiceBoardBinding(ctx as never)).toBeUndefined();
  });
});

describe("resolveBoundBoardId", () => {
  const boards = [
    { id: "default" },
    { id: "planning", kind: "cards" as const },
    { id: "ops", kind: "sessions" as const },
  ];

  it("supplies only an existing board of the requested kind", () => {
    expect(resolveBoundBoardId({ boardId: "planning", boardKind: "cards" }, "cards", boards)).toBe(
      "planning",
    );
    // Boards without persisted metadata are cards boards.
    expect(resolveBoundBoardId({ boardId: "default", boardKind: "cards" }, "cards", boards)).toBe(
      "default",
    );
    expect(resolveBoundBoardId({ boardId: "ops", boardKind: "sessions" }, "sessions", boards)).toBe(
      "ops",
    );
  });

  it("falls back for absent, unknown, or mismatched bindings", () => {
    expect(resolveBoundBoardId(undefined, "cards", boards)).toBeUndefined();
    expect(
      resolveBoundBoardId({ boardId: "gone", boardKind: "cards" }, "cards", boards),
    ).toBeUndefined();
    expect(
      resolveBoundBoardId({ boardId: "planning", boardKind: "cards" }, "sessions", boards),
    ).toBeUndefined();
    // A binding that lies about the kind cannot redirect to a board of the other kind.
    expect(
      resolveBoundBoardId({ boardId: "ops", boardKind: "cards" }, "cards", boards),
    ).toBeUndefined();
  });
});

describe("resolveBoundCardId", () => {
  const card = (id: string, boardId?: string, archivedAt?: number) => ({
    id,
    metadata: { ...(boardId ? { automation: { boardId } } : {}), archivedAt },
  });
  const cards = [card("login", "planning"), card("plain"), card("old", "planning", 1)];

  it("supplies only a live card of the bound cards board", () => {
    expect(
      resolveBoundCardId({ boardId: "planning", boardKind: "cards", cardId: "login" }, cards),
    ).toBe("login");
    // Cards without a board id live on the default board.
    expect(
      resolveBoundCardId({ boardId: "default", boardKind: "cards", cardId: "plain" }, cards),
    ).toBe("plain");
  });

  it("never resolves a stale, foreign, or archived card", () => {
    for (const binding of [
      undefined,
      { boardId: "planning", boardKind: "cards" as const },
      { boardId: "planning", boardKind: "cards" as const, cardId: "gone" },
      // The card exists, but on another board than the one bound.
      { boardId: "release", boardKind: "cards" as const, cardId: "login" },
      { boardId: "planning", boardKind: "sessions" as const, cardId: "login" },
      { boardId: "planning", boardKind: "cards" as const, cardId: "old" },
    ]) {
      expect(resolveBoundCardId(binding, cards)).toBeUndefined();
    }
  });
});
