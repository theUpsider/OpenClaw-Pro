import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  recordSessionGoalChanged,
  type SessionStateActorType,
} from "../../sessions/session-state-events.js";
import { formatTokenCount } from "../../utils/token-format.js";
import {
  accountSessionGoalUsage,
  buildCreatedSessionGoal,
  buildUpdatedSessionGoalObjective,
  buildUpdatedSessionGoalStatus,
  resolveSessionGoalRevision,
} from "./goals-transitions.js";
import { patchSessionEntryCore } from "./session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import type {
  SessionEntry,
  SessionGoal,
  SessionGoalAttention,
  SessionGoalStatus,
  SessionGoalVerification,
} from "./types.js";

type SessionGoalSnapshot = {
  status: "missing" | "found";
  goal?: SessionGoal;
};

type SessionGoalStoreOptions = {
  sessionKey: string;
  storePath?: string;
  now?: number;
  fallbackEntry?: SessionEntry;
  persist?: boolean;
  actor?: { type: SessionStateActorType; id?: string };
  agentId?: string;
};

type CreateSessionGoalOptions = SessionGoalStoreOptions & {
  objective: string;
  tokenBudget?: number;
  /** Per-goal opt-in for adversarial completion verification; captured at creation. */
  verifyCompletion?: boolean;
};

type UpdateSessionGoalStatusOptions = SessionGoalStoreOptions & {
  status: Extract<SessionGoalStatus, "active" | "paused" | "blocked" | "complete">;
  note?: string;
};

export const MODEL_UPDATABLE_SESSION_GOAL_STATUSES = ["complete", "blocked"] as const;

const goalLog = createSubsystemLogger("sessions/goal");

function nowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function recordGoalChange(
  options: SessionGoalStoreOptions,
  entry: SessionEntry,
  summary: string,
): Promise<void> {
  return recordSessionGoalChanged({
    sessionKey: options.sessionKey,
    entry,
    actor: options.actor,
    agentId: options.agentId,
    summary,
  });
}

export function resolveSessionGoalDisplayState(
  entry: Pick<SessionEntry, "goal" | "totalTokens" | "totalTokensFresh" | "totalTokensVersion">,
  now?: number,
  options?: { adoptFreshBaseline?: boolean },
): SessionGoal | undefined {
  return accountSessionGoalUsage(entry, nowMs(now), options);
}

export function formatSessionGoalStatus(goal: SessionGoal | undefined): string {
  if (!goal) {
    return "No goal for this session.\nStart one with /goal start <objective>.";
  }
  const budget =
    goal.tokenBudget === undefined
      ? ""
      : `Token budget: ${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
  const note = goal.lastStatusNote ? `Note: ${goal.lastStatusNote}` : "";
  // Automation can stop at a cap without the executor completing the goal. The
  // status is the durable surface for that stop: the one-shot notice may be
  // lost to a delivery failure, so the marker is also readable here.
  const attention = goal.attention
    ? `Needs attention: goal automation stopped (${goal.attention.reason}); /goal resume to continue.`
    : "";
  const commands = resolveGoalCommandHint(goal.status);
  return [
    "Goal",
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Tokens used: ${formatTokenCount(goal.tokensUsed)}`,
    ...(budget ? [budget] : []),
    ...(note ? [note] : []),
    ...(attention ? [attention] : []),
    "",
    `Commands: ${commands}`,
  ].join("\n");
}

function resolveGoalCommandHint(status: SessionGoalStatus): string {
  switch (status) {
    case "active":
      return "/goal edit <objective>, /goal pause, /goal complete, /goal clear";
    case "paused":
    case "blocked":
    case "usage_limited":
    case "budget_limited":
      return "/goal resume, /goal edit <objective>, /goal clear";
    case "complete":
      return "/goal resume, /goal clear";
  }
  return "/goal";
}

export async function getSessionGoal(
  options: SessionGoalStoreOptions,
): Promise<SessionGoalSnapshot> {
  const now = nowMs(options.now);
  if (options.persist === false) {
    // Status rendering should not write incidental budget/baseline adoption unless callers opt in.
    return withSessionEntryReadOnlyInWorker(
      { sessionKey: options.sessionKey, storePath: options.storePath },
      () => {},
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        const entry = read.value ?? options.fallbackEntry;
        const goal = entry
          ? resolveSessionGoalDisplayState(entry, now, { adoptFreshBaseline: false })
          : undefined;
        return goal ? { status: "found", goal } : { status: "missing" };
      },
    );
  }
  let goal: SessionGoal | undefined;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const accounted = accountSessionGoalUsage(entry, now);
      goal = accounted ? { ...accounted } : undefined;
      if (!accounted || JSON.stringify(accounted) === JSON.stringify(entry.goal)) {
        return null;
      }
      return { goal: accounted };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!result || !goal) {
    return { status: "missing" };
  }
  return { status: "found", goal };
}

export async function createSessionGoal(options: CreateSessionGoalOptions): Promise<SessionGoal> {
  const objective = options.objective.trim();
  if (!objective) {
    throw new Error("objective required");
  }
  const now = nowMs(options.now);
  let created: SessionGoal | undefined;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      created = buildCreatedSessionGoal(
        entry,
        {
          objective,
          tokenBudget: options.tokenBudget,
          ...(options.verifyCompletion === true ? { verifyCompletion: true } : {}),
        },
        now,
      );
      return { goal: created };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!result || !created) {
    throw new Error("session not found");
  }
  await recordGoalChange(options, result, "goal created");
  return { ...created };
}

export async function updateSessionGoalStatus(
  options: UpdateSessionGoalStatusOptions,
): Promise<SessionGoal> {
  return updateSessionGoal(
    options,
    (entry, now) => buildUpdatedSessionGoalStatus(entry, options, now),
    (goal) => `goal status changed to ${goal.status}`,
  );
}

export async function updateSessionGoalObjective(
  options: SessionGoalStoreOptions & { objective: string },
): Promise<SessionGoal> {
  const objective = options.objective.trim();
  if (!objective) {
    throw new Error("objective required");
  }
  return updateSessionGoal(
    options,
    (entry, now) => buildUpdatedSessionGoalObjective(entry, objective, now),
    () => "goal objective changed",
  );
}

async function updateSessionGoal(
  options: SessionGoalStoreOptions,
  update: (entry: SessionEntry, now: number) => SessionGoal,
  summarize: (goal: SessionGoal) => string,
): Promise<SessionGoal> {
  const now = nowMs(options.now);
  let updated: SessionGoal | undefined;
  let foundSession = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      foundSession = true;
      updated = update(entry, now);
      return { goal: updated };
    },
  );
  if (!result || !updated) {
    throw new Error(foundSession ? "goal not found" : "session not found");
  }
  await recordGoalChange(options, result, summarize(updated));
  return { ...updated };
}

type GoalVerificationRecordInput = Omit<SessionGoalVerification, "attempts"> & {
  attempts?: number;
};

type SessionGoalConditionalPatchOptions = SessionGoalStoreOptions & {
  goalId: string;
};

/**
 * Records one verifier verdict on the goal. Refuses (and reports `false`) when
 * the goal was replaced, cleared, or moved to another revision while the
 * verifier ran, so a stale verdict never authorizes completion.
 *
 * The write is bookkeeping: it preserves the goal's `updatedAt`, so the
 * revision the verdict names stays current until real work moves the pursuit.
 */
export async function recordSessionGoalVerification(
  options: SessionGoalConditionalPatchOptions & {
    revision: string;
    verification: GoalVerificationRecordInput;
  },
): Promise<{ recorded: boolean }> {
  let recorded = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const goal = entry.goal;
      if (!goal || goal.id !== options.goalId) {
        return null;
      }
      if (resolveSessionGoalRevision(goal) !== options.revision) {
        return null;
      }
      recorded = true;
      return {
        goal: {
          ...goal,
          verification: {
            ...options.verification,
            attempts: Math.max(0, options.verification.attempts ?? 0),
          },
        },
      };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  return { recorded: Boolean(result && recorded) };
}

/**
 * Drops the stored verifier record (verdict and attempt count). Called when an
 * ordinary user-originated turn ends: the verdict judged an earlier state of the
 * session's work, and the design requires the next claim to be re-verified
 * rather than reusing a pass that later work may have undone. An automatic goal
 * continuation never drops its own verdict — the passing handoff needs it.
 */
export async function clearSessionGoalVerification(
  options: SessionGoalConditionalPatchOptions,
): Promise<{ cleared: boolean }> {
  let cleared = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const goal = entry.goal;
      if (!goal || goal.id !== options.goalId || !goal.verification) {
        return null;
      }
      cleared = true;
      const { verification: _dropped, ...rest } = goal;
      return { goal: rest };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  return { cleared: Boolean(result && cleared) };
}

/**
 * Increments the automatic-continuation budget. Reports `capped` without
 * queueing more work once the budget is spent, and `stale` when the goal moved
 * on. The cap stamps the one-time attention marker in the same write so the
 * stop notice can be emitted exactly once.
 */
export async function advanceSessionGoalContinuation(
  options: SessionGoalConditionalPatchOptions & { maxTurns: number },
): Promise<{
  status: "advanced" | "capped" | "stale";
  attentionRecorded?: boolean;
  goal?: SessionGoal;
}> {
  // An object holder keeps the union type readable after the patch callback;
  // a plain `let` would be narrowed to its initializer across the closure.
  const outcome: {
    status: "advanced" | "capped" | "stale";
    attentionRecorded: boolean;
    goal?: SessionGoal;
  } = { status: "stale", attentionRecorded: false };
  let patchApplied = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const goal = entry.goal;
      if (!goal || goal.id !== options.goalId || goal.status !== "active") {
        return null;
      }
      if (goal.continuationTurns >= options.maxTurns) {
        outcome.status = "capped";
        if (goal.attention) {
          return null;
        }
        outcome.attentionRecorded = true;
        patchApplied = true;
        return {
          goal: {
            ...goal,
            attention: {
              reason: "continuation-budget" as const,
              at: nowMs(options.now),
            },
          },
        };
      }
      outcome.status = "advanced";
      patchApplied = true;
      const next: SessionGoal = {
        ...goal,
        // Budget bookkeeping only: the pursuit itself did not change here, but
        // the counter is part of the revision, so the advanced row is reported
        // back to callers that must bind state to the turn this queue creates.
        continuationTurns: goal.continuationTurns + 1,
      };
      outcome.goal = next;
      return { goal: next };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (!patchApplied) {
    // Either the goal moved on, or the marker was already stamped by an
    // earlier caller: both mean this call changed nothing.
    return { status: result ? "capped" : "stale", attentionRecorded: false };
  }
  return outcome.status === "capped"
    ? { status: outcome.status, attentionRecorded: outcome.attentionRecorded }
    : { status: outcome.status, ...(outcome.goal ? { goal: outcome.goal } : {}) };
}

/**
 * Stamps the one-time "needs attention" marker that stops automatic turns.
 * Only the first caller writes, so the visible message is emitted once.
 */
export async function markSessionGoalAttention(
  options: SessionGoalConditionalPatchOptions & {
    reason: SessionGoalAttention["reason"];
    detail?: string;
    summary: string;
  },
): Promise<{ recorded: boolean }> {
  let recorded = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      const goal = entry.goal;
      if (!goal || goal.id !== options.goalId || goal.status !== "active") {
        return null;
      }
      if (goal.attention) {
        return null;
      }
      recorded = true;
      return {
        goal: {
          ...goal,
          attention: {
            reason: options.reason,
            at: nowMs(options.now),
            ...(options.detail ? { detail: options.detail } : {}),
          },
        },
      };
    },
    { fallbackEntry: options.fallbackEntry },
  );
  if (result && recorded) {
    // The marker is already durable, so a failed change record would otherwise
    // leave automation stopped with no visible notice and no trace. Record the
    // failure; the goal state itself stays exactly as written above.
    try {
      await recordGoalChange(options, result, options.summary);
    } catch (error) {
      goalLog.warn("goal attention notice could not be recorded", {
        sessionKey: options.sessionKey,
        goalId: options.goalId,
        reason: options.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { recorded: Boolean(result && recorded) };
}

export async function clearSessionGoal(options: SessionGoalStoreOptions): Promise<boolean> {
  let removed = false;
  const result = await patchSessionEntryCore(
    { sessionKey: options.sessionKey, storePath: options.storePath },
    (entry) => {
      if (!entry.goal) {
        return null;
      }
      removed = true;
      return { goal: undefined };
    },
  );
  if (result && removed) {
    await recordGoalChange(options, result, "goal cleared");
  }
  return Boolean(result && removed);
}
