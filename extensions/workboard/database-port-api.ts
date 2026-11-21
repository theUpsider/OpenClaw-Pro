import type { DatabaseSync } from "node:sqlite";
import type { WorkboardDatabasePortApi } from "@openclaw/workboard-contract";
import type { DatabaseEngineInput } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { createWorkboardDatabase } from "./src/sqlite-store-schema.js";
import { SCHEMA_VERSION } from "./src/workboard-schema.js";

class WorkboardPortSchemaError extends Error {}

/**
 * Columns the owner adds with `ensureColumn` on open (plus the board palette the
 * version-4 step added), so a source that predates any of them is a valid,
 * migratable source rather than an unknown schema. Grouped by the table that
 * gains them, and only consulted while a source is older than SCHEMA_VERSION.
 */
const MISSING_COLUMNS: Record<string, string[]> = {
  workboard_boards: ["automation_job_id", "kind", "sessions_spec", "classifications_json"],
  workboard_card_events: ["agent_id"],
  workboard_cards: ["interaction_json"],
};

/** Read-only version evidence before the owner is allowed to migrate a private copy. */
function inspectWorkboardPortSource(db: DatabaseSync) {
  admitSqliteSchema(db);
  const userVersion = getAdmittedSqliteSchemaFacts(db)?.userVersion ?? 0;
  if (userVersion > SCHEMA_VERSION) {
    throw new WorkboardPortSchemaError(
      `schema version ${userVersion}; required at most ${SCHEMA_VERSION}`,
    );
  }
  const rows = db.prepare("SELECT id FROM workboard_schema_migrations").all();
  let version = 0;
  for (const row of rows) {
    const match = typeof row.id === "string" && /^schema-([1-9][0-9]*)$/.exec(row.id);
    if (!match || Number(match[1]) > SCHEMA_VERSION) {
      throw new WorkboardPortSchemaError(
        `unknown schema migration; required workboard schema ${SCHEMA_VERSION}`,
      );
    }
    version = Math.max(version, Number(match[1]));
  }
  return {
    version,
    migrationRequired: version < SCHEMA_VERSION,
    // Columns a source older than SCHEMA_VERSION may lack; the port adds them on migrate.
    // Empty for an up-to-date source, which is expected to carry them all.
    pendingColumns: version < SCHEMA_VERSION ? MISSING_COLUMNS : { workboard_boards: [] },
  };
}

/** Only private copies/staged destinations: reuse the normal owner's migrations and admission. */
function admitWorkboardPort(dbPath: string, input?: DatabaseEngineInput): void {
  createWorkboardDatabase(dbPath, undefined, input).close();
}
export const workboardDatabasePortApi: WorkboardDatabasePortApi<DatabaseSync, DatabaseEngineInput> =
  {
    inspectWorkboardPortSource,
    admitWorkboardPort,
    WorkboardPortSchemaError,
  };
