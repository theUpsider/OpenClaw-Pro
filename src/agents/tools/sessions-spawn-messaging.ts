import { Type } from "typebox";
import { SESSIONS_SPAWN_ALLOW_MESSAGING_DESCRIPTION } from "../tool-description-presets.js";
import { ToolInputError } from "./common.js";

export const ALLOW_MESSAGING_SCHEMA = Type.Optional(
  Type.Boolean({ description: SESSIONS_SPAWN_ALLOW_MESSAGING_DESCRIPTION }),
);

/**
 * Reads the per-child `message` opt-in before the visible/ACP branches run. Only hidden native
 * launch requests carry it, so other runtimes reject it like `lightContext`; collector refusal
 * belongs to spawnSubagentDirect, which also applies the config default for omitted values.
 */
export function readAllowMessaging(
  raw: Record<string, unknown>,
  runtime: "subagent" | "acp",
): boolean | undefined {
  const value = typeof raw.allowMessaging === "boolean" ? raw.allowMessaging : undefined;
  if (value && (runtime === "acp" || raw.visible === true)) {
    throw new ToolInputError(
      'sessions_spawn allowMessaging=true requires a hidden runtime="subagent" child (not ACP or visible).',
    );
  }
  return value;
}
