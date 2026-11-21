import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";

export type MainSessionRecoverySkipReason =
  | "stopped"
  | "not_main_session"
  | "archived"
  | "work_start_blocked"
  | "work_start_pending"
  | "dispatch_target_unavailable"
  | "live_owner"
  | "already_handled"
  | "state_changed"
  | "inactive"
  | "blocked"
  | "tombstoned"
  | "exhausted"
  | "message_action_authority_unavailable"
  | "observation_only"
  | "pending_delivery"
  | "invalid_harness_completion"
  | "delegated_authority_unavailable"
  | "dispatch_skipped";

export type MainSessionRecoveryDecision = {
  decision: "started" | "settled" | "deferred" | "blocked";
  reason: string;
  nextOwner: string;
};

export function skippedMainSessionRecoveryDecision(
  reason: MainSessionRecoverySkipReason,
): MainSessionRecoveryDecision {
  switch (reason) {
    case "exhausted":
    case "tombstoned":
    case "message_action_authority_unavailable":
    case "delegated_authority_unavailable":
    case "work_start_blocked":
    case "dispatch_target_unavailable":
      return { decision: "blocked", reason, nextOwner: "operator" };
    case "work_start_pending":
      return { decision: "deferred", reason, nextOwner: "session-preparation" };
    case "pending_delivery":
      return { decision: "deferred", reason, nextOwner: "outbound-delivery" };
    case "archived":
      return { decision: "deferred", reason, nextOwner: "none" };
    case "live_owner":
    case "blocked":
    case "already_handled":
    case "inactive":
      return { decision: "deferred", reason, nextOwner: "session-owner" };
    case "invalid_harness_completion":
      return { decision: "settled", reason, nextOwner: "none" };
    case "stopped":
      return { decision: "deferred", reason, nextOwner: "next-startup" };
    default:
      return { decision: "deferred", reason, nextOwner: "main-session-recovery" };
  }
}

export type RestartRecoveryStoreTarget = Pick<
  MainSessionRecoveryStoreTarget,
  "agentId" | "storePath"
>;

/** Persisted reason for a delegated turn whose sender authority did not survive restart. */
export const DELEGATED_RECOVERY_SENDER_UNAVAILABLE_REASON =
  "delegated recovery sender authority is unavailable";

type StartupRecoveryTombstone = {
  agentId: string;
  sessionKey: string;
  reason: string;
  delegated: boolean;
  /** No successor session, archive, or operator-visible notice handles this session. */
  unattended: boolean;
};

let failureGeneration: string | undefined;
const failures = new Map<string, string>();
const tombstones = new Map<string, StartupRecoveryTombstone>();

export function restartRecoveryStoreTargetKey(target: RestartRecoveryStoreTarget): string {
  return JSON.stringify([target.agentId, target.storePath]);
}

function rotateDiagnosticsGeneration(): void {
  const generation = getAgentRunLifecycleGeneration();
  if (failureGeneration !== generation) {
    failures.clear();
    tombstones.clear();
    failureGeneration = generation;
  }
}

function currentFailures(): Map<string, string> {
  rotateDiagnosticsGeneration();
  return failures;
}

function currentTombstones(): Map<string, StartupRecoveryTombstone> {
  rotateDiagnosticsGeneration();
  return tombstones;
}

function safeDiagnosticText(value: string, maxLength: number): string {
  return truncateWithMarker(
    sanitizeTerminalText(redactSensitiveText(value, { mode: "tools" })),
    maxLength,
    { marker: "…", reserve: 1, trimEnd: true },
  );
}

/**
 * Record a main session that restart recovery will not resume. Startup scans report
 * persisted tombstones; recovery reports the tombstones and delegated drops it creates.
 * Records are never removed by a later read; they describe this lifecycle generation.
 */
export function recordStartupRecoveryTombstone(params: {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  reason: string;
  unattended: boolean;
  lifecycleGeneration?: string;
}): void {
  if (
    params.lifecycleGeneration !== undefined &&
    params.lifecycleGeneration !== getAgentRunLifecycleGeneration()
  ) {
    return;
  }
  const reason =
    params.reason.trim() || "main-session restart recovery is tombstoned for this session";
  currentTombstones().set(JSON.stringify([params.storePath, params.sessionKey]), {
    agentId: safeDiagnosticText(params.agentId ?? "session store", 128),
    sessionKey: safeDiagnosticText(params.sessionKey, 256),
    reason: safeDiagnosticText(reason, 300),
    delegated: reason === DELEGATED_RECOVERY_SENDER_UNAVAILABLE_REASON,
    unattended: params.unattended,
  });
}

/** Startup report for main sessions that will not resume until an operator replaces them. */
export function readStartupRecoveryTombstoneWarning(includeSensitive = true): string | undefined {
  const all = [...currentTombstones().values()];
  const unattended = all.filter((tombstone) => tombstone.unattended);
  if (unattended.length === 0) {
    return undefined;
  }
  const delegated = unattended.filter((tombstone) => tombstone.delegated).length;
  const handled = all.length - unattended.length;
  const summary =
    `Restart recovery will not resume ${unattended.length} main session(s).` +
    (delegated > 0
      ? ` ${delegated} lost delegated sender authority across the restart; their interrupted turn was dropped without notifying an operator channel.`
      : "") +
    (handled > 0 ? ` ${handled} other tombstoned session(s) already have a replacement.` : "");
  const hint =
    "Inspect the interrupted turn, then send a new message or use /new or /reset to replace the session; run openclaw doctor for stored tombstones.";
  const details = includeSensitive
    ? `\n${truncateWithMarker(
        unattended
          .toSorted(
            (a, b) =>
              Number(b.delegated) - Number(a.delegated) || a.sessionKey.localeCompare(b.sessionKey),
          )
          .map(
            (tombstone) => `- ${tombstone.agentId}: ${tombstone.sessionKey} (${tombstone.reason})`,
          )
          .join("\n"),
        2000,
        { marker: "… (see openclaw doctor)", reserve: 24, trimEnd: true },
      )}`
    : "";
  return `${summary}${details}\n${hint}`;
}

/** The marker records its outcome; diagnostics never infer successful recovery from a reread. */
export function recordStartupRecoveryStoreResult(params: {
  target: RestartRecoveryStoreTarget;
  lifecycleGeneration: string;
  outcome: { ok: true } | { ok: false; error: unknown };
}): void {
  if (params.lifecycleGeneration !== getAgentRunLifecycleGeneration()) {
    return;
  }
  const pending = currentFailures();
  const key = restartRecoveryStoreTargetKey(params.target);
  if (params.outcome.ok) {
    pending.delete(key);
  } else {
    pending.set(
      key,
      truncateWithMarker(
        sanitizeTerminalText(
          redactSensitiveText(
            `${params.target.agentId ?? "session store"}: ${String(params.outcome.error)}`,
            { mode: "tools" },
          ),
        ),
        2000,
        { marker: "… (see recovery log)", reserve: 22, trimEnd: true },
      ),
    );
  }
}

export function readStartupRecoveryWarning(includeSensitive = true): string | undefined {
  const pending = currentFailures();
  if (pending.size === 0) {
    return undefined;
  }
  const summary = `Startup session recovery is incomplete for ${pending.size} session store(s).`;
  const hint =
    "Inspect the Gateway recovery logs and retry the affected session after repairing its store.";
  const details = includeSensitive
    ? `\n${truncateWithMarker([...pending.values()].map((failure) => `- ${failure}`).join("\n"), 2000, { marker: "… (see recovery log)", reserve: 22, trimEnd: true })}`
    : "";
  return `${summary}${details}\n${hint}`;
}
