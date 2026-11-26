// Workboard tests cover the operator-ask owner: the pure predicate the Control UI
// reads, the single-line `ask` bound, the blocker kind enum, and the shared normalizer
// guard that every write path reaches.
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { workboardAttentionReasons } from "../browser/lib/workboard/operator-attention.js";
import { normalizeAutomation, normalizeMetadata } from "./store-normalizers.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import {
  isWorkboardAskText,
  normalizeWorkboardAsk,
  normalizeWorkboardAskKind,
  WORKBOARD_ASK_MAX_LENGTH,
  WORKBOARD_OPERATOR_ASK_KINDS,
  workboardOperatorAskKind,
} from "./workboard-operator-ask.js";

function automationOf(metadata: unknown) {
  return (metadata as { automation?: Record<string, unknown> } | undefined)?.automation;
}

describe("normalizeWorkboardAsk", () => {
  it("trims a short single line and clears on empty or absent input", () => {
    expect(normalizeWorkboardAsk("  Which tenant?  ")).toBe("Which tenant?");
    expect(normalizeWorkboardAsk("")).toBeUndefined();
    expect(normalizeWorkboardAsk("   ")).toBeUndefined();
    expect(normalizeWorkboardAsk(null)).toBeUndefined();
    expect(normalizeWorkboardAsk(undefined)).toBeUndefined();
    expect(normalizeWorkboardAsk("x".repeat(WORKBOARD_ASK_MAX_LENGTH))).toHaveLength(
      WORKBOARD_ASK_MAX_LENGTH,
    );
  });

  it("refuses over-long text naming the limit instead of truncating it", () => {
    const tooLong = "x".repeat(WORKBOARD_ASK_MAX_LENGTH + 1);
    expect(() => normalizeWorkboardAsk(tooLong)).toThrow(
      `ask must be ${WORKBOARD_ASK_MAX_LENGTH} characters or fewer (got ${WORKBOARD_ASK_MAX_LENGTH + 1}).`,
    );
    // A non-string is the same class of refusal, never a silent drop.
    expect(() => normalizeWorkboardAsk(42)).toThrow("ask must be a single line");
  });

  it("refuses line breaks in both spellings", () => {
    expect(() => normalizeWorkboardAsk("first\nsecond")).toThrow(
      `ask must be a single line without line breaks (at most ${WORKBOARD_ASK_MAX_LENGTH} characters).`,
    );
    expect(() => normalizeWorkboardAsk("first\r\nsecond")).toThrow("without line breaks");
  });

  it("keeps isWorkboardAskText and the normalizer in step", () => {
    expect(isWorkboardAskText("Which tenant?")).toBe(true);
    expect(isWorkboardAskText("")).toBe(false);
    expect(isWorkboardAskText("a\nb")).toBe(false);
    expect(isWorkboardAskText("x".repeat(WORKBOARD_ASK_MAX_LENGTH + 1))).toBe(false);
    expect(isWorkboardAskText(7)).toBe(false);
  });
});

describe("normalizeWorkboardAskKind", () => {
  it("accepts only the two declared kinds and treats empty as a clear", () => {
    for (const kind of WORKBOARD_OPERATOR_ASK_KINDS) {
      expect(normalizeWorkboardAskKind(kind)).toBe(kind);
    }
    expect(normalizeWorkboardAskKind("")).toBeUndefined();
    expect(normalizeWorkboardAskKind(undefined)).toBeUndefined();
    // The `decision` label stays the single owner of a multiple-choice call.
    expect(() => normalizeWorkboardAskKind("decision")).toThrow(
      `askKind must be one of: ${WORKBOARD_OPERATOR_ASK_KINDS.join(", ")}.`,
    );
    expect(() => normalizeWorkboardAskKind("blocked")).toThrow("askKind must be one of");
    expect(() => normalizeWorkboardAskKind(1)).toThrow("askKind must be one of");
  });
});

describe("the shared normalizer guard", () => {
  it("stores a valid ask and kind, and refuses bad input from raw metadata", () => {
    expect(
      automationOf(normalizeMetadata({ automation: { ask: " Ship it? ", askKind: "input" } })),
    ).toMatchObject({ ask: "Ship it?", askKind: "input" });

    expect(() => normalizeAutomation({ ask: "x".repeat(WORKBOARD_ASK_MAX_LENGTH + 1) })).toThrow(
      `ask must be ${WORKBOARD_ASK_MAX_LENGTH} characters or fewer`,
    );
    expect(() => normalizeAutomation({ ask: "a\nb" })).toThrow("without line breaks");
    expect(() => normalizeAutomation({ askKind: "decision" })).toThrow("askKind must be one of");
  });

  it("clears a stored ask with an empty string and keeps it through an unrelated patch", () => {
    const withAsk = normalizeAutomation({ ask: "Ship it?", askKind: "external" });
    expect(withAsk).toMatchObject({ ask: "Ship it?", askKind: "external" });
    // Absent means leave unchanged: the fallback carries the stored value.
    expect(normalizeAutomation({ boardId: "ops" }, withAsk)).toMatchObject({
      ask: "Ship it?",
      askKind: "external",
      boardId: "ops",
    });
    expect(normalizeAutomation({ ask: "" }, withAsk)).not.toHaveProperty("ask");
  });
});

describe("workboardOperatorAskKind", () => {
  const card = (over: Record<string, unknown>) =>
    ({ status: "blocked", labels: [], ...over }) as never;

  it("answers from the stored kind on a kind-bearing card", () => {
    expect(
      workboardOperatorAskKind(card({ metadata: { automation: { askKind: "external" } } })),
    ).toBe("external");
    expect(workboardOperatorAskKind(card({ metadata: { automation: { askKind: "input" } } }))).toBe(
      "input",
    );
    expect(workboardOperatorAskKind(card({ metadata: {} }))).toBeUndefined();
    expect(workboardOperatorAskKind(undefined)).toBeUndefined();
  });

  it("still answers decision from the label, and the label wins over a stored kind", () => {
    expect(workboardOperatorAskKind(card({ labels: [" Decision "] }))).toBe("decision");
    expect(
      workboardOperatorAskKind(
        card({ labels: ["decision"], metadata: { automation: { askKind: "input" } } }),
      ),
    ).toBe("decision");
    // The label means something only together with `blocked`, exactly as before.
    expect(
      workboardOperatorAskKind(card({ status: "todo", labels: ["decision"] })),
    ).toBeUndefined();
  });

  it("reads a bare metadata object and ignores malformed stored kinds", () => {
    expect(workboardOperatorAskKind({ automation: { askKind: "external" } })).toBe("external");
    expect(
      workboardOperatorAskKind({ automation: { askKind: "decision" as never } }),
    ).toBeUndefined();
    expect(workboardOperatorAskKind({})).toBeUndefined();
  });
});

describe("ask and blocker kind through the store", () => {
  it("round-trips through metadata.automation and clears with an empty ask", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Waits on the operator",
      ask: "Which tenant should this land in?",
      askKind: "input",
    });
    expect(card.metadata?.automation).toMatchObject({
      ask: "Which tenant should this land in?",
      askKind: "input",
    });

    const cleared = await store.update(card.id, { ask: "" });
    expect(cleared.metadata?.automation ?? {}).not.toHaveProperty("ask");
    expect(cleared.metadata?.automation).toMatchObject({ askKind: "input" });

    const kindCleared = await store.update(card.id, { askKind: "" });
    // Clearing the last automation field drops the now-empty object, like its neighbours.
    expect(kindCleared.metadata?.automation ?? {}).not.toHaveProperty("askKind");
  });

  it("refuses bad input on create and update without writing anything", async () => {
    const store = createWorkboardSqliteTestStore();
    await expect(
      store.create({ title: "Long ask", ask: "x".repeat(WORKBOARD_ASK_MAX_LENGTH + 1) }),
    ).rejects.toThrow(`ask must be ${WORKBOARD_ASK_MAX_LENGTH} characters or fewer`);
    await expect(store.create({ title: "Multiline", ask: "a\nb" })).rejects.toThrow(
      "without line breaks",
    );
    await expect(store.create({ title: "Bad kind", askKind: "decision" })).rejects.toThrow(
      "askKind must be one of",
    );
    expect(await store.list()).toEqual([]);

    const card = await store.create({ title: "Stable", ask: "Keep me", askKind: "external" });
    await expect(store.update(card.id, { askKind: "blocked" })).rejects.toThrow(
      "askKind must be one of",
    );
    await expect(
      store.update(card.id, { metadata: { automation: { ask: "x".repeat(200) } } }),
    ).rejects.toThrow("ask must be 120 characters or fewer");
    expect(await store.get(card.id)).toEqual(card);
  });

  it("keeps a live ask when the card moves between statuses that may carry one", async () => {
    const store = createWorkboardSqliteTestStore();
    // `triage`, `backlog` and `todo` are asking statuses, so a move between them is not an
    // answer: the agent's question must survive it. Only LEAVING `blocked` retires the ask.
    const todo = await store.create({
      title: "Ask on a todo card",
      status: "todo",
      ask: "Which scope?",
      askKind: "input",
    });
    expect(todo.metadata?.automation).toMatchObject({ ask: "Which scope?", askKind: "input" });

    const moved = await store.move(todo.id, "backlog", undefined);

    expect(moved.status).toBe("backlog");
    expect(moved.metadata?.automation).toMatchObject({ ask: "Which scope?", askKind: "input" });
    expect(workboardAttentionReasons(moved as never)).toContain("input");
  });

  it("retires the ask and its kind in the same write that settles the card out of blocked", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Waits on the operator",
      status: "blocked",
      labels: ["decision"],
      ask: "Which tenant?",
      askKind: "input",
    });
    expect(card.metadata?.automation).toMatchObject({ ask: "Which tenant?", askKind: "input" });

    const settled = await store.move(card.id, "ready", undefined);

    // The reason described this block, so the block's settlement retires it: `ready` is a card an
    // agent picks up now, and a stored kind would keep reading as a live ask there. Same shape as
    // the sibling tombstone/dangling markers: the field is cleared, not the whole automation.
    expect(settled.status).toBe("ready");
    expect(settled.metadata?.automation?.ask).toBeUndefined();
    expect(settled.metadata?.automation?.askKind).toBeUndefined();
    expect(workboardOperatorAskKind(settled)).toBeUndefined();
    // At rest the field is gone, not stored as null: the store serializes the card.
    expect(JSON.stringify(settled.metadata?.automation ?? {})).not.toContain("ask");
    // The real path end to end: the card the store returns is what the lens reads, and it no
    // longer carries the reason the operator answered.
    expect(workboardAttentionReasons(settled as never)).not.toContain("input");

    // A card that merely adds a note (no status change) keeps its live question.
    const blocked = await store.create({
      title: "Still blocked",
      status: "blocked",
      ask: "Still waiting?",
      askKind: "external",
    });
    const noted = await store.addComment(blocked.id, { body: "A note." });
    expect(noted.metadata?.automation).toMatchObject({
      ask: "Still waiting?",
      askKind: "external",
    });
  });
});

describe("ask and blocker kind through the agent tools", () => {
  function tool(store: ReturnType<typeof createWorkboardSqliteTestStore>, name: string) {
    return expectDefined(
      createWorkboardTools({ store, context: { agentId: "worker" } }).find(
        (entry) => entry.name === name,
      ),
      name,
    );
  }

  function cardOf(result: unknown) {
    return (
      result as { details?: { card?: { metadata?: { automation?: Record<string, unknown> } } } }
    ).details?.card;
  }

  it("workboard_create stores the ask and kind and exposes them on the schema", async () => {
    const store = createWorkboardSqliteTestStore();
    const create = tool(store, "workboard_create");
    const result = await create.execute("create", {
      title: "Needs an answer",
      ask: "  Which tenant?  ",
      askKind: "input",
    });
    expect(cardOf(result)?.metadata?.automation).toMatchObject({
      ask: "Which tenant?",
      askKind: "input",
    });
    // The schema is the discovery path: a declared ask passes, an over-long one, a
    // line break, and an unknown kind are all refused before any write.
    expect(
      Value.Check(create.parameters, { title: "X", ask: "Which tenant?", askKind: "input" }),
    ).toBe(true);
    expect(
      Value.Check(create.parameters, { title: "X", ask: "x".repeat(WORKBOARD_ASK_MAX_LENGTH + 1) }),
    ).toBe(false);
    expect(Value.Check(create.parameters, { title: "X", ask: "a\nb" })).toBe(false);
    expect(Value.Check(create.parameters, { title: "X", askKind: "decision" })).toBe(false);
  });

  it("workboard_block carries the ask with the reason on a claimed card", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Needs a call", status: "todo" });
    await store.claim(card.id, { ownerId: "worker", token: "test-auth-token" });
    const result = await tool(store, "workboard_block").execute("block", {
      id: card.id,
      token: "test-auth-token",
      reason: "Waiting on the vendor.",
      ask: "Has the vendor replied?",
      askKind: "external",
    });
    expect(cardOf(result)?.metadata?.automation).toMatchObject({
      ask: "Has the vendor replied?",
      askKind: "external",
    });
  });

  it("workboard_update sets and clears the ask through the schema-checked fields", async () => {
    const store = createWorkboardSqliteTestStore();
    const update = tool(store, "workboard_update");
    const card = await store.create({ title: "Ask later" });

    await update.execute("set", { id: card.id, ask: "Approve the plan?", askKind: "input" });
    expect(expectDefined(await store.get(card.id), "card").metadata?.automation).toMatchObject({
      ask: "Approve the plan?",
      askKind: "input",
    });

    await update.execute("clear", { id: card.id, ask: "" });
    expect(
      expectDefined(await store.get(card.id), "card").metadata?.automation ?? {},
    ).not.toHaveProperty("ask");
  });

  it("workboard_specify refuses a bad kind and keeps the schema closed", async () => {
    const store = createWorkboardSqliteTestStore();
    const specify = tool(store, "workboard_specify");
    const card = await store.create({ title: "Rough", status: "backlog" });

    await expect(specify.execute("bad-kind", { id: card.id, askKind: "decision" })).rejects.toThrow(
      "askKind must be one of",
    );
    await expect(
      specify.execute("long-ask", { id: card.id, ask: "x".repeat(WORKBOARD_ASK_MAX_LENGTH + 1) }),
    ).rejects.toThrow(`ask must be ${WORKBOARD_ASK_MAX_LENGTH} characters or fewer`);
    await expect(specify.execute("newline", { id: card.id, ask: "a\nb" })).rejects.toThrow(
      "without line breaks",
    );
    // The card is untouched and still in backlog, never half-specified.
    expect(await store.get(card.id)).toMatchObject({ status: "backlog" });

    await specify.execute("good", { id: card.id, ask: "Which scope?", askKind: "input" });
    expect(await store.get(card.id)).toMatchObject({
      status: "todo",
      metadata: { automation: { ask: "Which scope?", askKind: "input" } },
    });
  });
});
