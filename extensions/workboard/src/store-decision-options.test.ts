// Workboard tests cover decision picker options: normalization bounds, the store
// round trip through metadata.automation, and the agent tools that write them.
import { expectDefined } from "@openclaw/normalization-core";
import { WORKBOARD_DECISION_OPTION_LIMITS } from "@openclaw/workboard-contract";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeDecisionOptions } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

const { labelMax, descriptionMax } = WORKBOARD_DECISION_OPTION_LIMITS;
const options = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ label: `Option ${index + 1}` }));

describe("normalizeDecisionOptions", () => {
  it("keeps a valid list in order, trimmed, with its descriptions and one recommendation", () => {
    expect(
      normalizeDecisionOptions([
        { label: " SQLite ", description: " One file. " },
        { label: "Postgres", description: "Needs a host.", recommended: true },
        { label: "JSON files", recommended: false },
      ]),
    ).toEqual([
      { label: "SQLite", description: "One file." },
      { label: "Postgres", description: "Needs a host.", recommended: true },
      { label: "JSON files" },
    ]);
  });

  it("drops lists outside 2 to 6 options and non-arrays; [] is undefined", () => {
    expect(normalizeDecisionOptions(options(1))).toBeUndefined();
    expect(normalizeDecisionOptions(options(2))).toHaveLength(2);
    expect(normalizeDecisionOptions(options(6))).toHaveLength(6);
    expect(normalizeDecisionOptions(options(7))).toBeUndefined();
    expect(normalizeDecisionOptions([])).toBeUndefined();
    expect(normalizeDecisionOptions("SQLite, Postgres")).toBeUndefined();
    expect(normalizeDecisionOptions({ label: "SQLite" })).toBeUndefined();
  });

  it("drops entries with an empty, too long, repeated, or non-string label", () => {
    expect(
      normalizeDecisionOptions([
        { label: "A" },
        { label: "   " },
        { label: "x".repeat(labelMax + 1) },
        { label: 42 },
        "B",
        null,
        { label: "A" },
        { label: "x".repeat(labelMax) },
      ]),
    ).toEqual([{ label: "A" }, { label: "x".repeat(labelMax) }]);
    // Two dropped entries leave one, which is below the minimum.
    expect(normalizeDecisionOptions([{ label: "A" }, { label: "" }])).toBeUndefined();
  });

  it("drops a too long or non-string description and a non-boolean recommended, keeping the entry", () => {
    expect(
      normalizeDecisionOptions([
        { label: "A", description: "x".repeat(descriptionMax + 1) },
        { label: "B", description: 7, recommended: "yes" },
        { label: "C", description: "x".repeat(descriptionMax) },
      ]),
    ).toEqual([
      { label: "A" },
      { label: "B" },
      { label: "C", description: "x".repeat(descriptionMax) },
    ]);
  });

  it("keeps only the first recommended option", () => {
    expect(
      normalizeDecisionOptions([
        { label: "A" },
        { label: "B", recommended: true },
        { label: "C", recommended: true },
      ]),
    ).toEqual([{ label: "A" }, { label: "B", recommended: true }, { label: "C" }]);
  });

  it("throws in strict mode where the default mode drops", () => {
    const strict = (value: unknown) => () => normalizeDecisionOptions(value, { strict: true });
    expect(strict(options(1))).toThrow("decisionOptions needs 2 to 6 options (got 1).");
    expect(strict(options(7))).toThrow("decisionOptions needs 2 to 6 options (got 7).");
    expect(strict([{ label: "" }, { label: "B" }])).toThrow("labels must be 1 to 64 characters.");
    expect(strict([{ label: "A" }, { label: "A" }])).toThrow(
      'labels must be unique (repeated "A").',
    );
    expect(strict([{ label: "A", description: 1 }, { label: "B" }])).toThrow(
      "descriptions must be strings of at most 240 characters.",
    );
    expect(strict([{ label: "A", recommended: 1 }, { label: "B" }])).toThrow(
      "recommended must be a boolean.",
    );
    expect(strict("A")).toThrow("decisionOptions must be an array.");
    expect(normalizeDecisionOptions([], { strict: true })).toBeUndefined();
    expect(
      normalizeDecisionOptions(
        [
          { label: "A", recommended: true },
          { label: "B", recommended: true },
        ],
        { strict: true },
      ),
    ).toEqual([{ label: "A", recommended: true }, { label: "B" }]);
  });
});

describe("decision options in the store", () => {
  const picker = [
    { label: "SQLite", description: "One file." },
    { label: "Postgres", recommended: true },
  ];

  async function automation(store: WorkboardStore, id: string) {
    return expectDefined(await store.get(id), "card").metadata?.automation;
  }

  it("creates with options and keeps them through a patch that does not name automation", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Pick a store", decisionOptions: picker });
    expect(card.metadata?.automation?.decisionOptions).toEqual(picker);

    await store.update(card.id, { title: "Pick a store, please", labels: ["decision"] });
    await store.update(card.id, { maxRetries: 2 });
    await store.update(card.id, { metadata: { comments: [] } });
    expect(await automation(store, card.id)).toMatchObject({
      maxRetries: 2,
      decisionOptions: picker,
    });
  });

  it("clears options with an empty list and replaces them with a new one", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Pick a store", decisionOptions: picker });

    await store.update(card.id, { decisionOptions: [{ label: "A" }, { label: "B" }] });
    expect((await automation(store, card.id))?.decisionOptions).toEqual([
      { label: "A" },
      { label: "B" },
    ]);

    await store.update(card.id, { decisionOptions: [] });
    expect(Object.hasOwn((await automation(store, card.id)) ?? {}, "decisionOptions")).toBe(false);
  });

  it("drops invalid options from raw metadata instead of failing the write", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Raw metadata" });
    const updated = await store.update(card.id, {
      metadata: { automation: { decisionOptions: [{ label: "Only one" }] } },
    });
    expect(updated.metadata?.automation?.decisionOptions).toBeUndefined();
  });

  it("writes options when a claimed card is blocked", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Needs a call", status: "todo" });
    await store.claim(card.id, { ownerId: "worker", token: "test-auth-token" });
    const blocked = await store.block(
      card.id,
      { reason: "Which store?", decisionOptions: picker },
      { ownerId: "worker", token: "test-auth-token" },
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.metadata?.automation?.decisionOptions).toEqual(picker);
    expect(blocked.metadata?.comments?.at(-1)?.body).toBe("Which store?");
  });
});

describe("decision options through the agent tools", () => {
  function tool(store: WorkboardStore, name: string) {
    return expectDefined(
      createWorkboardTools({ store, context: { agentId: "worker" } }).find(
        (entry) => entry.name === name,
      ),
      name,
    );
  }

  function payload(result: unknown) {
    return (result as { details?: { card?: { metadata?: { automation?: unknown } } } }).details;
  }

  it("workboard_create stores the options and returns them", async () => {
    const store = createWorkboardSqliteTestStore();
    const result = await tool(store, "workboard_create").execute("create", {
      title: "Pick a store",
      decisionOptions: [
        { label: "SQLite" },
        { label: "Postgres", description: "Needs a host.", recommended: true },
      ],
    });
    expect(payload(result)?.card?.metadata?.automation).toMatchObject({
      decisionOptions: [
        { label: "SQLite" },
        { label: "Postgres", description: "Needs a host.", recommended: true },
      ],
    });
  });

  it("rejects invalid options with a reason and writes nothing", async () => {
    const store = createWorkboardSqliteTestStore();
    const create = tool(store, "workboard_create");
    expect(
      Value.Check(create.parameters, { title: "X", decisionOptions: [{ label: "A", extra: 1 }] }),
    ).toBe(false);
    expect(Value.Check(create.parameters, { title: "X", decisionOptions: options(7) })).toBe(false);
    await expect(
      create.execute("one", { title: "One option", decisionOptions: [{ label: "Only" }] }),
    ).rejects.toThrow("decisionOptions needs 2 to 6 options (got 1).");
    await expect(
      create.execute("long", {
        title: "Long label",
        decisionOptions: [{ label: "x".repeat(labelMax + 1) }, { label: "B" }],
      }),
    ).rejects.toThrow("decisionOptions labels must be 1 to 64 characters.");
    expect(await store.list()).toEqual([]);
  });

  it("workboard_update replaces, keeps when omitted, and clears with []", async () => {
    const store = createWorkboardSqliteTestStore();
    const update = tool(store, "workboard_update");
    const card = await store.create({
      title: "Pick a store",
      decisionOptions: [{ label: "A" }, { label: "B" }],
    });

    await update.execute("labels", { id: card.id, labelsAdd: ["decision"] });
    expect(expectDefined(await store.get(card.id), "card").metadata?.automation).toMatchObject({
      decisionOptions: [{ label: "A" }, { label: "B" }],
    });

    await update.execute("replace", {
      id: card.id,
      decisionOptions: [{ label: "C" }, { label: "D", recommended: true }],
    });
    expect(
      expectDefined(await store.get(card.id), "card").metadata?.automation?.decisionOptions,
    ).toEqual([{ label: "C" }, { label: "D", recommended: true }]);

    await expect(
      update.execute("invalid", { id: card.id, decisionOptions: [{ label: "E" }] }),
    ).rejects.toThrow("decisionOptions needs 2 to 6 options (got 1).");

    await update.execute("clear", { id: card.id, decisionOptions: [] });
    expect(
      expectDefined(await store.get(card.id), "card").metadata?.automation?.decisionOptions,
    ).toBeUndefined();
  });

  it("workboard_block writes the options with the reason", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Needs a call", status: "todo" });
    await store.claim(card.id, { ownerId: "worker", token: "test-auth-token" });
    const result = await tool(store, "workboard_block").execute("block", {
      id: card.id,
      token: "test-auth-token",
      reason: "Which store?",
      decisionOptions: [{ label: "SQLite", recommended: true }, { label: "Postgres" }],
    });
    expect(payload(result)?.card?.metadata?.automation).toMatchObject({
      decisionOptions: [{ label: "SQLite", recommended: true }, { label: "Postgres" }],
    });
  });
});
