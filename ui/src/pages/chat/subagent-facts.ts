import type { GatewaySessionRow, SessionRunStatus } from "../../api/types.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

const ROLE_LABELS = {
  orchestrator: "chat.subagentsPanel.roleOrchestrator",
  leaf: "chat.subagentsPanel.roleLeaf",
} as const satisfies Record<NonNullable<GatewaySessionRow["subagentRole"]>, string>;

const STATUS_LABELS = {
  queued: "sessionsView.statusQueued",
  running: "sessionsView.statusRunning",
  done: "sessionsView.statusDone",
  failed: "sessionsView.statusFailed",
  interrupted: "sessionsView.statusInterrupted",
  killed: "sessionsView.statusKilled",
  timeout: "sessionsView.statusTimeout",
} as const satisfies Record<SessionRunStatus, string>;

/** Run identity of a subagent. Absent model or thinking stays unknown; never a guessed default. */
export type SubagentFacts = {
  agentId: string | undefined;
  model: string | undefined;
  provider: string | undefined;
  thinking: string | undefined;
  badge: { kind: "role" | "status"; labelKey: string } | undefined;
};

function text(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function resolveSubagentFacts(row: GatewaySessionRow): SubagentFacts {
  const activeModel = text(row.activeModel);
  const model = activeModel ?? text(row.model);
  return {
    agentId: text(row.agentId) ?? parseAgentSessionKey(row.key)?.agentId,
    model,
    // The provider must describe the same model the chip names, and a provider
    // without a model describes nothing — the chip reads "unknown" either way, so
    // a lone provider would only leak a claim the row cannot support.
    provider: model
      ? activeModel
        ? text(row.activeModelProvider)
        : text(row.modelProvider)
      : undefined,
    thinking: text(row.thinkingLevel),
    badge: row.subagentRole
      ? { kind: "role", labelKey: ROLE_LABELS[row.subagentRole] }
      : row.status
        ? { kind: "status", labelKey: STATUS_LABELS[row.status] }
        : undefined,
  };
}

/** Tooltip/detail text for the model chip: `provider · model`. */
export function formatSubagentModel(facts: SubagentFacts): string | undefined {
  return facts.model && facts.provider ? `${facts.provider} · ${facts.model}` : facts.model;
}
