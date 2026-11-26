import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

describe("Workboard orchestration dispatch modes", () => {
  it("accepts only declared modes in the public specify schema and persists the choice", async () => {
    const store = createWorkboardSqliteTestStore();
    const tool = expectDefined(
      createWorkboardTools({ store }).find((candidate) => candidate.name === "workboard_specify"),
      "specify",
    );
    const card = await store.create({ title: "Rough card", status: "backlog" });
    const input = { id: card.id, dispatchMode: "external" };
    expect(Value.Check(tool.parameters, input)).toBe(true);
    expect(Value.Check(tool.parameters, { ...input, dispatchMode: "remote" })).toBe(false);
    await tool.execute("specify", input);
    expect(await store.get(card.id)).toMatchObject({
      status: "todo",
      metadata: { automation: { dispatchMode: "external" } },
    });
  });

  it("inherits external placement before the first child write and honors explicit native children", async () => {
    const writes: Array<{ title: string; mode?: string }> = [];
    const store = createWorkboardSqliteTestStore({
      beforeCardWrite: (_key, { card }) => {
        writes.push({ title: card.title, mode: card.metadata?.automation?.dispatchMode });
      },
    });
    const tool = expectDefined(
      createWorkboardTools({ store }).find((candidate) => candidate.name === "workboard_decompose"),
      "decompose",
    );
    const parent = await store.create({ title: "Remote parent", dispatchMode: "external" });
    const input = {
      id: parent.id,
      children: [
        { title: "Inherited remote" },
        { title: "Explicit remote", dispatchMode: "external" },
        { title: "Explicit native", dispatchMode: "native" },
      ],
    };
    expect(Value.Check(tool.parameters, input)).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        ...input,
        children: [{ title: "Invalid", dispatchMode: "remote" }],
      }),
    ).toBe(false);
    await tool.execute("decompose", input);
    for (const title of ["Inherited remote", "Explicit remote"]) {
      const childWrites = writes.filter((write) => write.title === title);
      expect(childWrites.length).toBeGreaterThan(0);
      expect(childWrites.every((write) => write.mode === "external")).toBe(true);
    }
    const run = vi.fn().mockResolvedValue({ runId: "local-child" });
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 3, workspaceAccess: { unrestricted: true } },
    });
    expect(result.started.map((entry) => entry.title)).toEqual(["Explicit native"]);
    const cards = await store.list();
    expect(cards.filter((card) => card.title.endsWith("remote"))).toEqual([
      expect.objectContaining({
        status: "ready",
        metadata: expect.objectContaining({
          automation: expect.objectContaining({ dispatchMode: "external" }),
        }),
      }),
      expect.objectContaining({
        status: "ready",
        metadata: expect.objectContaining({
          automation: expect.objectContaining({ dispatchMode: "external" }),
        }),
      }),
    ]);
  });
});
