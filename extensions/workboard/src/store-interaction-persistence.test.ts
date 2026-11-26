// Workboard interaction persistence: the card-bound link survives a store reopen.
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect } from "vitest";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { SCHEMA_VERSION } from "./workboard-schema.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);

/** Stamps one card-bound turn, the way dictation about that card does. */
async function stampBoundTurn(
  store: Parameters<typeof createWorkboardTools>[0]["store"],
  cardId: string,
  sessionKey: string,
) {
  const tools = new Map(
    createWorkboardTools({
      store,
      context: {
        agentId: "main",
        sessionKey,
        workContext: {
          page: "workboard",
          detail: { boardId: "alpha", boardKind: "cards", cardId },
        },
      },
    }).map((tool) => [tool.name, tool]),
  );
  await tools.get("workboard_comment")?.execute("comment", { body: "spoken" });
}

describe("Workboard interaction persistence", () => {
  test("round-trips the interaction link across a store close and reopen", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const created = await harness.store.create({ title: "Persisted", boardId: "alpha" });
    await stampBoundTurn(harness.store, created.id, "agent:main:voice");
    const stamped = (await harness.store.get(created.id))?.metadata?.interaction;
    expect(stamped).toMatchObject({ sessionKey: "agent:main:voice", agentId: "main" });
    await harness.store.close();

    // The physical column carries the JSON, not just the in-memory card.
    const raw = new DatabaseSync(harness.dbPath, { readOnly: true });
    try {
      const row = raw
        .prepare("SELECT interaction_json FROM workboard_cards WHERE id = ?")
        .get(created.id) as { interaction_json?: unknown } | undefined;
      expect(JSON.parse(String(row?.interaction_json))).toMatchObject({
        sessionKey: "agent:main:voice",
      });
    } finally {
      raw.close();
    }

    const reopened = createWorkboardSqliteStores({ dbPath: harness.dbPath, workerModuleUrl });
    try {
      expect(await reopened.cards.lookup(created.id)).toMatchObject({
        card: { metadata: { interaction: { sessionKey: "agent:main:voice", agentId: "main" } } },
      });
    } finally {
      await reopened.close();
    }
  });

  // No backfill: a row written before the column existed reads back without it.
  test("reads an old row without the field as undefined and adds the column on open", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const legacy = await harness.store.create({ title: "Legacy", boardId: "alpha" });
    await harness.store.close();

    // Downgrade the file to the schema-4 shape: no column, no version-5 row.
    const downgrade = new DatabaseSync(harness.dbPath);
    try {
      downgrade.exec("ALTER TABLE workboard_cards DROP COLUMN interaction_json");
      downgrade.exec(
        `DELETE FROM workboard_schema_migrations WHERE id = 'schema-${SCHEMA_VERSION}'`,
      );
    } finally {
      downgrade.close();
    }

    const reopened = createWorkboardSqliteStores({ dbPath: harness.dbPath, workerModuleUrl });
    try {
      const card = await reopened.cards.lookup(legacy.id);
      expect(card?.card.title).toBe("Legacy");
      expect(card?.card.metadata?.interaction).toBeUndefined();
    } finally {
      await reopened.close();
    }

    const verified = new DatabaseSync(harness.dbPath, { readOnly: true });
    try {
      expect(
        verified
          .prepare("SELECT name FROM pragma_table_info('workboard_cards') WHERE name = ?")
          .get("interaction_json"),
      ).toEqual({ name: "interaction_json" });
      expect(
        verified
          .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = ?")
          .get(`schema-${SCHEMA_VERSION}`),
      ).toEqual({ found: 1 });
    } finally {
      verified.close();
    }
  });
});
