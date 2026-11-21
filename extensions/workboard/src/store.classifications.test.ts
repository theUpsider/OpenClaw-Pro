// Workboard tests cover the board classification palette through its tools and store write paths.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCardClassification } from "../browser/lib/workboard/classification.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { sqliteOnly } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { SCHEMA_VERSION } from "./workboard-schema.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

function tool(store: WorkboardStore, name: string) {
  return expectDefined(
    createWorkboardTools({ store, context: { agentId: "agent-a" } }).find(
      (entry) => entry.name === name,
    ),
    name,
  );
}

function payload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

async function fillPalette(store: WorkboardStore): Promise<Record<string, unknown>> {
  const create = tool(store, "workboard_create");
  let result: Record<string, unknown> = {};
  for (const name of NAMES) {
    result = payload(await create.execute(name, { title: `Card ${name}`, labels: [name] }));
  }
  return result;
}

describe("Workboard classification palette", () => {
  it("refuses an 11th classification without replaces and overwrites a slot with it", async () => {
    const store = createWorkboardSqliteTestStore();
    const create = tool(store, "workboard_create");
    const filled = await fillPalette(store);
    expect(filled.classifications).toHaveLength(10);
    expect(filled.classificationsAdded).toEqual(["ux"]);
    const before = await store.list();

    await expect(
      create.execute("eleventh", { title: "Security review", labels: ["security"] }),
    ).rejects.toThrow(
      /already has 10 classifications: bug \(red\), feature \(blue\).*ux \(blue\)\. Reuse one of them for "security", or pass replaces/,
    );
    expect(await store.list()).toHaveLength(before.length);
    expect((await store.readClassifications("default")).map((entry) => entry.name)).toEqual(NAMES);

    const replaced = payload(
      await create.execute("eleventh-replaces", {
        title: "Security review",
        labels: ["security"],
        replaces: "chore",
      }),
    );
    expect((replaced.card as WorkboardCard).labels).toEqual(["security"]);
    expect(replaced.classificationReplaced).toEqual({ name: "chore", by: "security" });
    const palette = await store.readClassifications("default");
    expect(replaced.classifications).toEqual(palette);
    expect(palette[3]).toEqual({ name: "security", color: "yellow" });
    expect(palette.map((entry) => entry.name)).not.toContain("chore");
    // The card that carried the replaced name keeps it; it now renders as a plain chip.
    const choreCard = expectDefined(
      before.find((card) => card.title === "Card chore"),
      "chore card",
    );
    expect(expectDefined(await store.get(choreCard.id), "chore card").labels).toEqual(["chore"]);
  });

  it("enforces the palette on workboard_update and on the generic update path", async () => {
    const store = createWorkboardSqliteTestStore();
    await fillPalette(store);
    const card = await store.create({ title: "Target", labels: ["bug"] });
    const update = tool(store, "workboard_update");

    await expect(update.execute("add", { id: card.id, labelsAdd: ["perf"] })).rejects.toThrow(
      "pass replaces",
    );
    // A status write that also changes labels takes the same gate.
    await expect(
      store.update(card.id, { status: "done", labels: ["bug", "perf"] }),
    ).rejects.toThrow("already has 10 classifications");
    await expect(
      store.bulkUpdate({ ids: [card.id], patch: { labels: ["perf"], replaces: "ux" } }),
    ).rejects.toThrow("Bulk updates cannot replace classifications");
    expect(expectDefined(await store.get(card.id), "card")).toMatchObject({
      status: card.status,
      labels: ["bug"],
    });

    const replaced = payload(
      await update.execute("replace", { id: card.id, labelsAdd: ["perf"], replaces: "UX" }),
    );
    expect((replaced.card as WorkboardCard).labels).toEqual(["bug", "perf"]);
    expect(replaced.classificationReplaced).toEqual({ name: "ux", by: "perf" });
    expect((replaced.classifications as unknown[])[9]).toEqual({ name: "perf", color: "blue" });

    const priorityOnly = payload(
      await update.execute("priority", { id: card.id, priority: "high" }),
    );
    expect(priorityOnly.classifications).toEqual(await store.readClassifications("default"));
    // Status and metadata writes never consult the palette.
    await store.update(card.id, { status: "done" });
  });

  it("exempts system labels and keeps the palette across board metadata upserts", async () => {
    const store = createWorkboardSqliteTestStore();
    await fillPalette(store);
    const card = await store.create({ title: "Parallel", labels: ["Parallelizable", "bug"] });
    expect(card.labels).toEqual(["Parallelizable", "bug"]);

    await store.upsertBoard({ id: "default", name: "Default board" });
    const { boards } = await store.listBoards();
    const palette = await store.readClassifications("default");
    expect(palette).toHaveLength(10);
    expect(boards.find((board) => board.id === "default")).toMatchObject({
      name: "Default board",
      classifications: palette,
    });
  });

  it("seeds an unseeded board from its existing cards on the first card write", async () => {
    const store = createWorkboardSqliteTestStore();
    const first = await store.create({ title: "Seed", boardId: "ops", labels: ["infra"] });
    expect(await store.readClassifications("ops")).toEqual([{ name: "infra", color: "red" }]);
    const second = await store.create({ title: "Reuse", boardId: "ops", labels: ["INFRA", "db"] });
    expect(second.labels).toEqual(["infra", "db"]);
    expect(await store.readClassifications("ops")).toEqual([
      { name: "infra", color: "red" },
      { name: "db", color: "blue" },
    ]);
    expect(await store.readClassifications("default")).toEqual([]);
    expect(first.labels).toEqual(["infra"]);
  });
});

function legacyCard(
  id: string,
  createdAt: number,
  labels: string[],
  metadata?: WorkboardCard["metadata"],
) {
  return {
    version: 1 as const,
    card: {
      id,
      title: id,
      status: "todo" as const,
      priority: "normal" as const,
      labels,
      position: createdAt,
      createdAt,
      updatedAt: createdAt + 1,
      ...(metadata ? { metadata } : {}),
    },
  };
}

type LabelRow = { card_id: string; ordinal: number; label: string };

function readRows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      labels: db
        .prepare(
          "SELECT card_id, ordinal, label FROM workboard_card_labels ORDER BY card_id, ordinal",
        )
        .all() as LabelRow[],
      cards: db.prepare("SELECT id, updated_at FROM workboard_cards ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

describe("Workboard classification seed migration", () => {
  // Builds a schema-3 database file and reopens it through SQLite admission.
  sqliteOnly("seeds legacy boards once without touching card label rows", async () => {
    const dir = tempDirs.make("openclaw-workboard-classification-seed-");
    const legacyPath = path.join(dir, "legacy.sqlite");
    const legacy = createWorkboardSqliteStores({ dbPath: legacyPath, workerModuleUrl });
    await legacy.ready;
    const twelve = Array.from({ length: 12 }, (_, index) => `label-${index}`);
    // Raw persistence writes: the legacy store had no palette gate.
    await legacy.cards.register("a", legacyCard("a", 100, twelve));
    await legacy.cards.register(
      "b",
      legacyCard("b", 200, ["label-11", "Label-3", "parallelizable"]),
    );
    await legacy.cards.register("c", legacyCard("c", 300, ["archived-only"], { archivedAt: 301 }));
    await legacy.boards.register("empty", {
      version: 1,
      board: { id: "empty", createdAt: 1, updatedAt: 1 },
    });
    await legacy.cards.register(
      "d",
      legacyCard("d", 400, [], { automation: { boardId: "empty" } }),
    );
    await legacy.close();
    const downgrade = new DatabaseSync(legacyPath);
    try {
      downgrade.exec("ALTER TABLE workboard_boards DROP COLUMN classifications_json");
      downgrade.exec(
        `DELETE FROM workboard_schema_migrations WHERE id = 'schema-${SCHEMA_VERSION}'`,
      );
    } finally {
      downgrade.close();
    }
    const legacyRows = readRows(legacyPath);

    const seedCopy = async (name: string) => {
      // A fresh physical file per run, so SQLite admission migrates it from schema 3.
      const dbPath = path.join(dir, name);
      fs.copyFileSync(legacyPath, dbPath);
      const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
      const store = new WorkboardStore(stores.cards, stores);
      try {
        const first = await store.seedClassifications("default");
        const second = await store.seedClassifications("default");
        expect(second).toEqual(first);
        const empty = await store.seedClassifications("empty");
        const card = expectDefined(await store.get("a"), "legacy card");
        return { first, empty, card, boards: await store.listBoards() };
      } finally {
        await store.close();
      }
    };
    const run = await seedCopy("run-1.sqlite");
    const rerun = await seedCopy("run-2.sqlite");

    // label-3 and label-11 sit on two cards; the rest follow card a's order.
    expect(run.first.map((entry) => entry.name)).toEqual([
      "label-3",
      "label-11",
      "label-0",
      "label-1",
      "label-2",
      "label-4",
      "label-5",
      "label-6",
      "label-7",
      "label-8",
    ]);
    expect(run.first.map((entry) => entry.color)).toEqual([
      "red",
      "blue",
      "green",
      "yellow",
      "purple",
      "orange",
      "pink",
      "cyan",
      "red",
      "blue",
    ]);
    expect(rerun.first).toEqual(run.first);
    expect(run.empty).toEqual([]);
    expect(run.boards.boards.find((board) => board.id === "empty")?.classifications).toEqual([]);

    for (const name of ["run-1.sqlite", "run-2.sqlite"]) {
      expect(readRows(path.join(dir, name))).toEqual(legacyRows);
    }
    expect(run.card.labels).toEqual(twelve);
    // label-9 and label-10 have no slot and stay plain chips, as before the palette.
    const resolved = resolveCardClassification(run.card.labels, run.first, (color) => color);
    expect([...resolved.colors.keys()].toSorted()).toEqual(
      twelve.filter((label) => label !== "label-9" && label !== "label-10").toSorted(),
    );
    expect(resolved.orderedLabels).toEqual(expect.arrayContaining(["label-9", "label-10"]));
    expect(resolved.orderedLabels).toHaveLength(12);
  });

  it("replaces a cards board's whole palette and refuses an invalid or Sessions board", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.create({ title: "Seed", labels: ["bug", "docs"] });

    await store.setClassifications("default", [
      { name: "defect", color: "red" },
      { name: "feature", color: "blue" },
    ]);
    expect((await store.readClassifications("default")).map((entry) => entry.name)).toEqual([
      "defect",
      "feature",
    ]);

    // The list is replaced whole, and invalid entries are refused without a write.
    await expect(
      store.setClassifications("default", [
        { name: "defect", color: "red" },
        { name: "Defect", color: "blue" },
      ]),
    ).rejects.toThrow(/listed twice/);
    await expect(
      store.setClassifications("default", [{ name: "parallelizable", color: "red" }]),
    ).rejects.toThrow(/system label/);
    expect((await store.readClassifications("default")).map((entry) => entry.name)).toEqual([
      "defect",
      "feature",
    ]);

    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    await expect(
      store.setClassifications("sessions", [{ name: "defect", color: "red" }]),
    ).rejects.toThrow(/Sessions board/);
  });
});
