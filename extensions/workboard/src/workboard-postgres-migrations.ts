import { WORKBOARD_POSTGRES_SCHEMA_SQL } from "./workboard-postgres-schema.js";

const EVENT_AGENT_COLUMN = '\n  "agent_id" text COLLATE "C",';
const CARD_INTERACTION_COLUMN = '\n  "interaction_json" text COLLATE "C",';

// Each step's fromSchema is the previous generated DDL with exactly the columns it
// adds removed. Admission verifies both sides against the stored DDL hash and the
// physical catalog, so a wrong derivation refuses the migration instead of applying it.
// The added column is last in the table, which is where ALTER TABLE ADD COLUMN puts it.
function withoutColumn(sql: string, table: string, column: string): string {
  const tableAt = sql.indexOf(`CREATE TABLE "${table}" (`);
  const columnAt = sql.indexOf(column, tableAt);
  if (tableAt < 0 || columnAt < 0 || columnAt > sql.indexOf(");", tableAt)) {
    throw new Error(`Workboard PostgreSQL schema lacks ${table}.${column.slice(3, -2)}`);
  }
  return sql.slice(0, columnAt) + sql.slice(columnAt + column.length);
}

/** Version 4 is the generated version 5 DDL without workboard_cards.interaction_json. */
const VERSION_4_SCHEMA = withoutColumn(
  WORKBOARD_POSTGRES_SCHEMA_SQL,
  "workboard_cards",
  CARD_INTERACTION_COLUMN,
);
export const WORKBOARD_POSTGRES_MIGRATIONS = [
  {
    version: 4,
    fromSchema: {
      postgres: withoutColumn(VERSION_4_SCHEMA, "workboard_card_events", EVENT_AGENT_COLUMN),
    },
    sql: 'ALTER TABLE "workboard_card_events" ADD COLUMN "agent_id" text COLLATE "C"',
    schema: { postgres: VERSION_4_SCHEMA },
  },
  {
    version: 5,
    fromSchema: { postgres: VERSION_4_SCHEMA },
    sql: 'ALTER TABLE "workboard_cards" ADD COLUMN "interaction_json" text COLLATE "C"',
    schema: { postgres: WORKBOARD_POSTGRES_SCHEMA_SQL },
  },
] as const;
