import { Command } from "commander";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkboardCli } from "./cli.js";
import {
  workboardCardIsExternallyDispatched,
  workboardCardIsParallelizable,
  workboardOwnerSlotLimit,
} from "./store-constants.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  isImplicitLocalGatewayTargetFromCli: vi.fn(async () => false),
}));

vi.mock(import("openclaw/plugin-sdk/gateway-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  ...gatewayRuntime,
}));

vi.mock("openclaw/plugin-sdk/cli-state-owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/cli-state-owner")>()),
  runWithLocalStateOwner: ({
    runLocal,
  }: {
    runLocal: (scope: { assertCurrent(): void }) => unknown;
  }) => runLocal({ assertCurrent() {} }),
}));

async function captureStdout(run: () => Promise<unknown>): Promise<string> {
  let output = "";
  using _ = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    output += String(chunk);
    return true;
  });
  await run();
  return output;
}

describe("registerWorkboardCli", () => {
  let store: WorkboardStore;
  let program: Command;
  const parse = (...args: string[]) => program.parseAsync(["workboard", ...args], { from: "user" });
  const captureCli = (...args: string[]) => captureStdout(() => parse(...args));

  beforeEach(() => {
    store = createWorkboardSqliteTestStore();
    program = new Command().exitOverride().configureOutput({ writeErr() {}, writeOut() {} });
    registerWorkboardCli({ program, withStore: async (action) => action(store) });
    gatewayRuntime.callGatewayFromCli.mockReset();
    gatewayRuntime.isImplicitLocalGatewayTargetFromCli.mockReset().mockResolvedValue(false);
    delete process.env.OPENCLAW_GATEWAY_URL;
  });

  it("records full-host authority on locally created cards", async () => {
    const store = createWorkboardSqliteTestStore();
    const program = createProgram(store);

    await program.parseAsync(["workboard", "create", "Host card"], { from: "user" });

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          automation: expect.objectContaining({ workspaceAccess: { unrestricted: true } }),
        }),
      }),
    ]);
  });

  it("lets the CLI opt a card into parallel owner slots", async () => {
    const store = createWorkboardSqliteTestStore();
    const program = createProgram(store);

    await program.parseAsync(
      [
        "workboard",
        "create",
        "Parallel host card",
        "--agent",
        "shared-worker",
        "--parallelizable",
        "--max-concurrent-per-owner",
        "3",
      ],
      { from: "user" },
    );

    // The flag writes the documented label AND the ceiling, so the operator
    // surface can actually reach the opt-in the docs describe.
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        labels: ["parallelizable"],
        metadata: expect.objectContaining({
          automation: expect.objectContaining({ maxConcurrentPerOwner: 3 }),
        }),
      }),
    ]);
  });

  it("keeps a CLI-created card at the single owner slot without the opt-in", async () => {
    const store = createWorkboardSqliteTestStore();
    const program = createProgram(store);

    await program.parseAsync(["workboard", "create", "Serial host card"], { from: "user" });

    const [card] = await store.list();
    expect(card.labels).toEqual([]);
    expect(card.metadata?.automation?.maxConcurrentPerOwner).toBeUndefined();
  });

  it("redacts claim tokens from card JSON output", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Claimed worker", status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });
    const program = createProgram(store);

    const listOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list", "--json"], { from: "user" });
    });
    const showOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "show", card.id, "--json"], { from: "user" });
    });

    expect(listOutput).not.toContain("secret-token");
    expect(showOutput).not.toContain("secret-token");
    expect(listOutput).toContain("[redacted]");
    expect(showOutput).toContain("[redacted]");
  });

  it("hides archived cards from text output by default and reveals them with --include-archived", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.create({ title: "Active card" });
    const archived = await store.create({ title: "Archived card" });
    await store.archive(archived.id, true);
    const program = createProgram(store);

    const defaultOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list"], { from: "user" });
    });
    const includeOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list", "--include-archived"], { from: "user" });
    });

    expect(defaultOutput).toContain("Active card");
    expect(defaultOutput).not.toContain("Archived card");
    expect(includeOutput).toContain("Active card");
    expect(includeOutput).toContain("Archived card");
    expect(includeOutput).toContain("(archived)");
    const jsonOutput = await captureStdout(async () => {
      await createProgram(store).parseAsync(["workboard", "list", "--json"], { from: "user" });
    });
    expect(jsonOutput).toContain(archived.id);
    expect(jsonOutput).toContain("archivedAt");
  });

  it("rejects invalid list status filters instead of reporting an empty board", async () => {
    const running = await store.create({ title: "Active work", status: "running" });
    await store.create({ title: "Queued work", status: "todo" });
    const output = await captureCli("list", "--status", "running", "--json");
    expect(JSON.parse(output)).toMatchObject({ cards: [{ id: running.id }] });
    await captureStdout(() =>
      expect(parse("list", "--status", "runnning", "--json")).rejects.toThrow(
        /Allowed choices are.*running/,
      ),
    );
  });

  it("requests minimum scopes unless full-host access is explicit", async () => {
    gatewayRuntime.callGatewayFromCli.mockResolvedValue({ started: [], startFailures: [] });
    for (const admin of [false, true]) {
      await parse("dispatch", ...(admin ? ["--admin"] : []));
      const [method, , input, options] = gatewayRuntime.callGatewayFromCli.mock.lastCall!;
      expect(method).toBe("workboard.cards.dispatch");
      expect(input).not.toHaveProperty("maxStarts");
      expect(options).toEqual({
        mode: "cli",
        scopes: [...(admin ? ["operator.admin"] : []), "operator.write", "operator.read"],
      });
    }
  });

  it.each([false, true])("reports each dispatch failure with JSON=%s", async (json) => {
    const result = {
      started: [{ cardId: "started-card", runId: "run-started" }],
      startFailures: [
        { cardId: "12345678-first", error: "offline" },
        { cardId: "abcdef01-second", error: "missing" },
      ],
    };
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce(result);
    const output = await captureCli("dispatch", ...(json ? ["--json"] : []));

    if (json) {
      expect(JSON.parse(output)).toEqual(result);
    } else {
      expect(output).toBe(
        "dispatch complete: started=1 failures=2\n12345678: offline\nabcdef01: missing\n",
      );
    }
  });

  it("does not fall back when an older gateway lacks max-starts dispatch", async () => {
    const card = await store.create({ title: "Bounded dispatch", status: "ready" });
    const method = "workboard.cards.dispatchWithOptions";
    gatewayRuntime.callGatewayFromCli.mockRejectedValueOnce(new Error(`unknown method: ${method}`));
    await expect(parse("dispatch", "--max-starts", "1")).rejects.toThrow(
      `unknown method: ${method}`,
    );
    const [calledMethod, , input] = gatewayRuntime.callGatewayFromCli.mock.calls[0]!;
    expect(calledMethod).toBe(method);
    expect(input).toMatchObject({ maxStarts: 1 });
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects invalid --max-starts value", async () => {
    await expect(parse("dispatch", "--max-starts", "1e3")).rejects.toThrow(
      "--max-starts must be a positive integer.",
    );
    expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("renders a claimed card through operator move and archival without leaking its token", async () => {
    await captureCli("create", "Claimed card");
    const [card] = await store.list();
    assert(card);
    expect(card.metadata?.automation?.workspaceAccess).toEqual({ unrestricted: true });
    const id = card.id;
    await store.claim(id, { ownerId: "worker", token: "secret-token" });
    for (const args of [["list"], ["show", id]]) {
      const output = await captureCli(...args, "--json");
      expect(output).not.toContain("secret-token");
      expect(output).toContain("[redacted]");
    }
    const output = await captureCli("move", id.slice(0, 8), "--status", "review", "--json");
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({ card: { id, status: "review" } });
    expect(parsed.card.metadata.claim.token).toBe("[redacted]");
    expect(output).not.toContain("secret-token");
    await store.archive(id, true);
    await store.create({ title: "Active card" });
    const defaultOutput = await captureCli("list");
    const includeOutput = await captureCli("list", "--include-archived");
    expect(defaultOutput).toContain("Active card");
    expect(defaultOutput).not.toContain("Claimed card");
    expect(includeOutput).toContain("Active card");
    expect(includeOutput).toContain("Claimed card");
    expect(includeOutput).toContain("(archived)");
    const jsonOutput = await captureCli("list", "--json");
    expect(jsonOutput).toContain(id);
    expect(jsonOutput).toContain("archivedAt");
    expect(await captureCli("show", id)).toContain("Claimed card (archived)");
  });
});

describe("workboard update parallelism", () => {
  // A fresh program per run: commander keeps option values across parses.
  async function update(store: WorkboardStore, args: string[]) {
    return await captureStdout(async () => {
      await createProgram(store).parseAsync(["workboard", "update", ...args], { from: "user" });
    });
  }

  async function read(store: WorkboardStore, id: string) {
    const card = await store.get(id);
    if (!card) {
      throw new Error(`missing card ${id}`);
    }
    return card;
  }

  it("opts an existing card into parallel owner slots and raises its ceiling", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Existing card", agentId: "shared-worker" });
    expect(workboardOwnerSlotLimit(card)).toBe(1);

    const output = await update(store, [
      card.id.slice(0, 8),
      "--parallelizable",
      "--max-concurrent-per-owner",
      "3",
      "--json",
    ]);

    const updated = await read(store, card.id);
    expect(updated.labels).toEqual(["parallelizable"]);
    expect(updated.metadata?.automation).toMatchObject({
      parallelizable: true,
      maxConcurrentPerOwner: 3,
    });
    expect(workboardOwnerSlotLimit(updated)).toBe(3);
    expect(JSON.parse(output)).toMatchObject({ card: { id: card.id, labels: ["parallelizable"] } });
  });

  it("clears the ceiling with 0 and turns parallelism off including the label", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Parallel card",
      labels: ["parallelizable", "bug"],
      parallelizable: true,
      maxConcurrentPerOwner: 4,
    });

    await update(store, [card.id, "--max-concurrent-per-owner", "0"]);
    const cleared = await read(store, card.id);
    expect(Object.hasOwn(cleared.metadata?.automation ?? {}, "maxConcurrentPerOwner")).toBe(false);
    expect(cleared.labels).toEqual(["parallelizable", "bug"]);
    expect(workboardCardIsParallelizable(cleared)).toBe(true);
    expect(workboardOwnerSlotLimit(cleared)).toBe(1);

    await update(store, [card.id, "--parallelizable=false"]);
    const off = await read(store, card.id);
    expect(off.labels).toEqual(["bug"]);
    expect(workboardCardIsParallelizable(off)).toBe(false);
  });

  it("turns off a card that was opted in by the label alone", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Label-only card",
      labels: ["Parallelizable"],
      maxConcurrentPerOwner: 4,
    });
    expect(card.metadata?.automation?.parallelizable).toBeUndefined();
    expect(workboardOwnerSlotLimit(card)).toBe(4);

    await update(store, [card.id, "--parallelizable", "no"]);

    const off = await read(store, card.id);
    expect(off.labels).toEqual([]);
    expect(workboardCardIsParallelizable(off)).toBe(false);
    expect(workboardOwnerSlotLimit(off)).toBe(1);
  });

  it("keeps unrelated labels through an on and an off write", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Labeled card", labels: ["bug", "ui"] });

    await update(store, [card.id, "--parallelizable=yes"]);
    expect((await read(store, card.id)).labels).toEqual(["bug", "ui", "parallelizable"]);

    await update(store, [card.id, "--parallelizable=0"]);
    expect((await read(store, card.id)).labels).toEqual(["bug", "ui"]);
  });

  it("leaves labels alone when they already match and normalizes case variants", async () => {
    const store = createWorkboardSqliteTestStore();
    const canonical = await store.create({ title: "Canonical", labels: ["parallelizable", "bug"] });
    const variant = await store.create({ title: "Variant", labels: ["PARALLELIZABLE", "bug"] });

    await update(store, [canonical.id, "--parallelizable"]);
    await update(store, [variant.id, "--parallelizable"]);

    expect((await read(store, canonical.id)).labels).toEqual(["parallelizable", "bug"]);
    expect((await read(store, variant.id)).labels).toEqual(["bug", "parallelizable"]);
  });

  it("changes only the ceiling when --parallelizable is absent", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Ceiling only", labels: ["bug"] });

    await update(store, [card.id, "--max-concurrent-per-owner", "16"]);

    const updated = await read(store, card.id);
    expect(updated.labels).toEqual(["bug"]);
    expect(updated.metadata?.automation?.maxConcurrentPerOwner).toBe(16);
    expect(updated.metadata?.automation?.parallelizable).toBeUndefined();
    expect(workboardOwnerSlotLimit(updated)).toBe(1);
  });

  it("clears both fields with --parallelizable=false and a 0 ceiling", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Reset card",
      labels: ["parallelizable"],
      parallelizable: true,
      maxConcurrentPerOwner: 2,
    });

    await update(store, [card.id, "--parallelizable=false", "--max-concurrent-per-owner", "0"]);

    const reset = await read(store, card.id);
    expect(reset.labels).toEqual([]);
    expect(reset.metadata?.automation?.parallelizable).toBeUndefined();
    expect(Object.hasOwn(reset.metadata?.automation ?? {}, "maxConcurrentPerOwner")).toBe(false);
    expect(workboardOwnerSlotLimit(reset)).toBe(1);
  });

  const ceilingError = /from 1 to 16, or 0 to clear it/;
  it.each([
    [["--parallelizable", "--max-concurrent-per-owner", "17"], ceilingError],
    [["--parallelizable", "--max-concurrent-per-owner=-1"], ceilingError],
    [["--parallelizable", "--max-concurrent-per-owner", "1.5"], ceilingError],
    [["--parallelizable", "--max-concurrent-per-owner", "abc"], ceilingError],
    [["--parallelizable", "--max-concurrent-per-owner="], ceilingError],
    [["--parallelizable=maybe"], /--parallelizable must be true\/1\/yes or false\/0\/no/],
  ])("rejects %j without writing", async (flags, message) => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Untouched", labels: ["bug"] });

    await expect(update(store, [card.id, ...flags])).rejects.toThrow(message);

    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("rejects a card that changed after it was read instead of overwriting the newer labels", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Raced card", labels: ["bug"] });
    // Simulate a concurrent writer landing between the command's read and its
    // write. The command pins expectedUpdatedAt from the card it read, so the
    // stale label list must be refused instead of clobbering the newer labels.
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

    await expect(update(racingStore, [card.id, "--parallelizable"])).rejects.toThrow(
      /changed while you were editing/i,
    );

    const after = await read(store, card.id);
    expect(after.labels).toEqual(["bug", "someone-else"]);
    expect(after.metadata?.automation?.parallelizable).toBeUndefined();
    expect(workboardOwnerSlotLimit(after)).toBe(1);
  });

  it("requires at least one flag", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "No flags" });

    await expect(update(store, [card.id])).rejects.toThrow(
      "Pass --labels-add, --labels-remove, --parallelizable, --max-concurrent-per-owner, or --dispatch-mode.",
    );

    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("rejects unknown and ambiguous card ids without writing", async () => {
    const store = createWorkboardSqliteTestStore();
    const prefix = await createAmbiguousPrefix(store);
    const before = await store.list();

    await expect(update(store, [prefix, "--parallelizable"])).rejects.toThrow(
      "Ambiguous card id prefix",
    );
    await expect(update(store, ["no-such-card", "--parallelizable"])).rejects.toThrow(
      "Card not found: no-such-card",
    );

    await expect(store.list()).resolves.toEqual(before);
  });
});

describe("workboard update labels", () => {
  async function update(store: WorkboardStore, args: string[]) {
    return await captureStdout(async () => {
      await createProgram(store).parseAsync(["workboard", "update", ...args], { from: "user" });
    });
  }

  async function read(store: WorkboardStore, id: string) {
    const card = await store.get(id);
    if (!card) {
      throw new Error(`missing card ${id}`);
    }
    return card;
  }

  const NAMES = [
    "bug",
    "feature",
    "docs",
    "chore",
    "research",
    "ops",
    "design",
    "test",
    "infra",
    "ux",
  ];

  async function fillPalette(store: WorkboardStore) {
    for (const name of NAMES) {
      await store.create({ title: `Card ${name}`, labels: [name] });
    }
  }

  it("adds and removes labels by name without disturbing the others", async () => {
    const store = createWorkboardSqliteTestStore();
    // Seed the palette so added names reuse existing classifications.
    await store.create({ title: "Seed", labels: ["bug", "ui"] });
    const card = await store.create({ title: "Target", labels: ["bug"] });

    const output = await update(store, [
      card.id.slice(0, 8),
      "--labels-add",
      "ui, docs",
      "--labels-remove",
      "bug",
      "--json",
    ]);

    const updated = await read(store, card.id);
    expect(updated.labels).toEqual(["ui", "docs"]);
    expect(JSON.parse(output)).toMatchObject({
      card: { id: card.id, labels: ["ui", "docs"] },
    });
  });

  it("leaves the card unchanged when a removal matches nothing", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Stable", labels: ["bug"] });

    await update(store, [card.id, "--labels-remove", "nope"]);

    await expect(read(store, card.id)).resolves.toEqual(card);
  });

  it("refuses an 11th classification on a full palette and overwrites one with --replaces", async () => {
    const store = createWorkboardSqliteTestStore();
    await fillPalette(store);
    const card = await store.create({ title: "Plain", labels: [] });

    await expect(update(store, [card.id, "--labels-add", "security"])).rejects.toThrow(
      /already has 10 classifications: bug \(red\), feature \(blue\).*Reuse one of them for "security", or pass replaces/,
    );
    expect((await read(store, card.id)).labels).toEqual([]);
    expect((await store.readClassifications("default")).map((entry) => entry.name)).toEqual(NAMES);

    await update(store, [card.id, "--labels-add", "security", "--replaces", "chore"]);
    expect((await read(store, card.id)).labels).toEqual(["security"]);
    expect((await store.readClassifications("default")).map((entry) => entry.name)).toEqual([
      "bug",
      "feature",
      "docs",
      "security",
      "research",
      "ops",
      "design",
      "test",
      "infra",
      "ux",
    ]);
  });

  it("rejects --replaces without --labels-add before touching the card", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "No adds", labels: ["bug"] });

    await expect(update(store, [card.id, "--replaces", "bug"])).rejects.toThrow(
      "--replaces only applies when --labels-add introduces a new label.",
    );

    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("combines a label edit with the parallel opt-in in one write", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Sync", labels: ["bug"] });

    await update(store, [
      card.id,
      "--labels-add",
      "docs",
      "--parallelizable",
      "--max-concurrent-per-owner",
      "2",
    ]);

    const updated = await read(store, card.id);
    expect(updated.labels).toEqual(["bug", "docs", "parallelizable"]);
    expect(updated.metadata?.automation).toMatchObject({
      parallelizable: true,
      maxConcurrentPerOwner: 2,
    });
  });
});

describe("workboard dispatch mode", () => {
  async function update(store: WorkboardStore, args: string[]) {
    return await captureStdout(async () => {
      await createProgram(store).parseAsync(["workboard", "update", ...args], { from: "user" });
    });
  }

  async function read(store: WorkboardStore, id: string) {
    const card = await store.get(id);
    if (!card) {
      throw new Error(`missing card ${id}`);
    }
    return card;
  }

  it("creates an external card and keeps native as the default", async () => {
    const store = createWorkboardSqliteTestStore();

    await createProgram(store).parseAsync(
      ["workboard", "create", "Remote mission", "--dispatch-mode", "external"],
      { from: "user" },
    );
    await createProgram(store).parseAsync(["workboard", "create", "Local card"], { from: "user" });

    const byTitle = new Map((await store.list()).map((card) => [card.title, card]));
    expect(workboardCardIsExternallyDispatched(byTitle.get("Remote mission")!)).toBe(true);
    const local = byTitle.get("Local card")!;
    expect(Object.hasOwn(local.metadata?.automation ?? {}, "dispatchMode")).toBe(false);
    expect(workboardCardIsExternallyDispatched(local)).toBe(false);
  });

  it("moves an existing card between external and native placement", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Switchable card" });
    expect(workboardCardIsExternallyDispatched(card)).toBe(false);

    await update(store, [card.id, "--dispatch-mode", "external"]);
    expect(workboardCardIsExternallyDispatched(await read(store, card.id))).toBe(true);

    await update(store, [card.id, "--dispatch-mode", "native"]);
    expect(workboardCardIsExternallyDispatched(await read(store, card.id))).toBe(false);
  });

  it("rejects an unknown mode before touching the card", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Unchanged card" });

    await expect(update(store, [card.id, "--dispatch-mode", "remote"])).rejects.toThrow(
      "--dispatch-mode must be native or external.",
    );
    await expect(
      createProgram(store).parseAsync(
        ["workboard", "create", "Bad mode", "--dispatch-mode", "remote"],
        { from: "user" },
      ),
    ).rejects.toThrow("--dispatch-mode must be native or external.");

    await expect(store.get(card.id)).resolves.toEqual(card);
    await expect(store.list()).resolves.toHaveLength(1);
  });
});
