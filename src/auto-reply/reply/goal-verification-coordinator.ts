// Turn-end coordinator for adversarial goal-completion verification.
//
// Runs after the existing goal-continuation eligibility checks in
// `enqueueGoalContinuation`. It decides whether the verifier runs, records the
// verdict on the goal, and returns what the caller must do: queue the normal
// nudge, queue a nudge carrying the missing points, or stop automation with a
// one-time visible notice.
//
// Every path is opt-in gated. With the gate off this module returns
// `{ queue: true }` without any I/O.
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  hasGoalVerificationForRevision,
  isGoalContinuationBudgetExhausted,
  isGoalVerificationAttemptBudgetExhausted,
  isGoalVerificationCoolingDown,
  isGoalVerificationCurrent,
  resolveArmedGoalVerification,
  resolveGoalVerificationGaps,
  type GoalVerificationSettings,
} from "../../config/sessions/goal-verification-gate.js";
import { resolveSessionGoalRevision } from "../../config/sessions/goals-transitions.js";
import {
  advanceSessionGoalContinuation,
  clearSessionGoalVerification,
  markSessionGoalAttention,
  recordSessionGoalVerification,
} from "../../config/sessions/goals.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionGoal, SessionGoalVerification } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  extractCompletionClaim,
  evaluateGoalClaimPrefilter,
  runGoalVerifier,
  type GoalVerificationVerdict,
} from "./goal-verification.js";

/**
 * The objective carried in a nudge or notice is the goal's own objective, whose
 * protocol bound is 16,000 characters. Anything shorter would drop criteria the
 * executor still owes, so the prompt bound matches the protocol bound exactly.
 */
const MAX_OBJECTIVE_IN_PROMPT_CHARS = 16_000;
const MAX_GAPS_IN_PROMPT = 8;

export type GoalTurnEndDecision = {
  /** False stops the automatic continuation for this turn. */
  queue: boolean;
  /** Replacement nudge prompt; when absent the caller keeps today's prompt. */
  promptOverride?: string;
  /** One-time visible notice that automation stopped and a human should decide. */
  notice?: string;
};

/** Single-flight guard: one verifier run per session goal at a time. */
type GoalVerificationRun =
  | { kind: "no-claim-signal" }
  | { kind: "approval-pending" }
  /** The verdict was refused by the store; the goal moved while it ran. */
  | { kind: "stale" }
  | { kind: "verdict"; verdict: GoalVerificationVerdict };

const inFlightVerification = new Map<string, Promise<GoalVerificationRun>>();

function inFlightKey(sessionKey: string, goalId: string): string {
  return `${sessionKey}\u0000${goalId}`;
}

/**
 * True when this session has a pending operator approval. The read is
 * best-effort: an unavailable approval store must not block verification, and
 * the verifier still fails closed on its own result.
 */
async function hasPendingOperatorApproval(sessionKey: string): Promise<boolean> {
  try {
    // Dynamic import keeps the shared-state store out of the reply turn's
    // module graph until verification is actually armed and eligible.
    const { listPendingOperatorApprovals } =
      await import("../../gateway/operator-approval-store.js");
    const pending = await listPendingOperatorApprovals({
      audienceSessionKey: sessionKey,
      limit: 1,
    });
    return pending.length > 0;
  } catch {
    return false;
  }
}

function resolveFinalAssistantText(result: EmbeddedAgentRunResult): string | undefined {
  const meta = result.meta;
  const raw = meta.finalAssistantMessageRawText ?? meta.finalAssistantVisibleText;
  if (typeof raw === "string" && raw.trim()) {
    return raw;
  }
  const fromPayloads = (result.payloads ?? [])
    .filter(
      (payload) => !payload.isError && !payload.isReasoning && typeof payload.text === "string",
    )
    .map((payload) => payload.text ?? "")
    .join("\n")
    .trim();
  return fromPayloads || undefined;
}

/**
 * Reads the goal's stored verifier record from the authoritative session row.
 * Used when this turn dropped the record: acting on a verdict the store refused
 * (or that another writer already changed) would decide the turn on state that
 * no longer exists.
 */
async function readGoalVerification(
  params: DecideGoalTurnEndParams,
): Promise<SessionGoalVerification | undefined> {
  const entry = await readSessionEntryReadOnlyInWorker(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    undefined,
  );
  return entry?.goal?.id === params.goal.id ? entry.goal.verification : undefined;
}

/** A turn that called update_goal made an explicit status request (truth-table row 7). */
function isExplicitGoalStatusRequest(result: EmbeddedAgentRunResult): boolean {
  return result.meta.toolSummary?.tools?.includes("update_goal") === true;
}

function buildMissingPointsNudge(params: {
  objective: string;
  missingPoints: string[];
  outcome: "fail" | "unknown";
}): string {
  const objective = params.objective.slice(0, MAX_OBJECTIVE_IN_PROMPT_CHARS);
  const gaps = params.missingPoints.slice(0, MAX_GAPS_IN_PROMPT);
  const heading =
    params.outcome === "fail"
      ? "An independent verifier reviewed a completion claim and found the objective is not yet complete. Keep the goal active and close the listed gaps."
      : "An independent verifier could not confirm the objective is complete from the available material. Keep the goal active and make the missing work visible.";
  return [
    "Advance the active goal; keep it active until fully achieved.",
    heading,
    "Objective (verbatim):",
    "<<<",
    objective,
    ">>>",
    ...(gaps.length
      ? ["Missing points:", ...gaps.map((gap, index) => `${index + 1}. ${gap}`)]
      : []),
    "Address these points, then verify the entire objective before marking it complete.",
  ].join("\n");
}

/** The handoff that turns a passing verdict into the executor's own `update_goal` call. */
function buildPassHandoffNudge(params: { objective: string; missingPoints: string[] }): string {
  const objective = params.objective.slice(0, MAX_OBJECTIVE_IN_PROMPT_CHARS);
  return [
    "An independent verifier reviewed this goal and passed it: on the available material the objective is met.",
    'You hold the goal state, not the verifier. Complete it now with a single `update_goal` call using status "complete".',
    "Do not restate or redo the work; do not expand the objective.",
    ...(params.missingPoints.length
      ? [
          "The verifier listed these non-blocking notes:",
          ...params.missingPoints.map((point, index) => `${index + 1}. ${point}`),
        ]
      : []),
    "Objective (verbatim):",
    "<<<",
    objective,
    ">>>",
  ].join("\n");
}

function buildAttentionNotice(params: {
  objective: string;
  reason: "continuation-budget" | "verification-attempts";
  missingPoints: string[];
  verification: SessionGoalVerification | undefined;
  maxContinuationTurns: number;
}): string {
  const objective = params.objective.slice(0, MAX_OBJECTIVE_IN_PROMPT_CHARS);
  const gaps = params.missingPoints.slice(0, MAX_GAPS_IN_PROMPT);
  const latest = params.verification
    ? params.verification.outcome === "unverified"
      ? `unverified (${params.verification.error ?? "no detail"})`
      : `${params.verification.outcome}${gaps.length ? ` — ${gaps.join("; ")}` : ""}`
    : "no verification run recorded";
  const stopped =
    params.reason === "continuation-budget"
      ? `the automatic continuation budget (${params.maxContinuationTurns} turns) is used up`
      : "the verifier attempt budget is used up";
  return [
    `⚠️ Goal automation stopped: ${stopped}.`,
    `Objective: ${objective}`,
    `Unresolved criteria / latest verdict: ${latest}`,
    "The goal stays active and incomplete. Address the gaps and resume explicitly (for example /goal resume) to continue.",
  ].join("\n");
}

export type DecideGoalTurnEndParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  goal: SessionGoal;
  result: EmbeddedAgentRunResult;
  executor?: { provider?: string; model?: string };
  /**
   * True when this turn is an automatic goal continuation. A user-originated
   * turn invalidates a stored verdict; a continuation must not, or the passing
   * handoff could never reach its `update_goal` call.
   */
  goalContinuation?: boolean;
  now?: number;
  signal?: AbortSignal;
};

/**
 * Applies the turn-end verification decision. Store writes happen here so the
 * caller only has to honor queue/prompt/notice.
 */
export async function decideGoalTurnEndContinuation(
  params: DecideGoalTurnEndParams,
): Promise<GoalTurnEndDecision> {
  const now = params.now ?? Date.now();
  const { settings, armed } = resolveArmedGoalVerification({ cfg: params.cfg, goal: params.goal });
  if (!armed) {
    return { queue: true };
  }
  const storedVerification = params.goal.verification;

  // A user-originated turn ends the stretch of work the last verdict judged, so
  // the verdict is dropped and the next claim re-verifies. Ordinary user turns
  // and tool work do not move the goal revision, so without this a pass could be
  // reused — including after work that undid the verified result. Automatic
  // continuations keep their verdict: the passing handoff and the advance turn
  // both still need it.
  const dropsStoredVerdict = !params.goalContinuation && storedVerification !== undefined;
  if (dropsStoredVerdict) {
    // Bookkeeping about the verdict, not a decision from it: a rejected drop
    // only leaves the record in place, and the read below stays authoritative.
    await clearSessionGoalVerification({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      goalId: params.goal.id,
    });
  }

  // The row this decision acts on. After a drop the authoritative row is re-read,
  // so a rejected write (F3) falls back to the *current* goal state instead of
  // acting on the verdict the store refused.
  const verification = dropsStoredVerdict ? await readGoalVerification(params) : storedVerification;
  const gaps = resolveGoalVerificationGaps(verification);

  // Automation already stopped for this goal; an operator decision is pending.
  if (params.goal.attention) {
    return { queue: false };
  }

  if (
    isGoalVerificationAttemptBudgetExhausted({ verification, maxAttempts: settings.maxAttempts })
  ) {
    return await stopAutomation({
      params,
      settings,
      reason: "verification-attempts",
      gaps,
      verification,
    });
  }
  if (
    isGoalContinuationBudgetExhausted({
      goal: params.goal,
      maxContinuationTurns: settings.maxContinuationTurns,
    })
  ) {
    return await stopAutomation({
      params,
      settings,
      reason: "continuation-budget",
      gaps,
      verification,
    });
  }

  /** Shared tail: count the automatic turn and queue unless that trips the cap. */
  const queueAsToday = async (): Promise<GoalTurnEndDecision> => {
    const advance = await advanceSessionGoalContinuation({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      goalId: params.goal.id,
      maxTurns: settings.maxContinuationTurns,
      now,
    });
    if (advance.status === "stale") {
      // The goal moved under us; the next turn re-evaluates against fresh state.
      return { queue: false };
    }
    if (advance.status === "capped") {
      return {
        queue: false,
        ...(advance.attentionRecorded
          ? {
              notice: buildAttentionNotice({
                objective: params.goal.objective,
                reason: "continuation-budget",
                missingPoints: gaps,
                verification,
                maxContinuationTurns: settings.maxContinuationTurns,
              }),
            }
          : {}),
      };
    }
    return { queue: true };
  };

  /**
   * Re-queues the pass handoff for a continuation turn that still has a current
   * pass. Mirrors the pass path below, but the verdict comes from the store
   * rather than from this turn's run.
   */
  async function queueStoredPassHandoff(
    stored: SessionGoalVerification,
  ): Promise<GoalTurnEndDecision> {
    return queueAdvanceForVerdict(
      {
        missingPoints: stored.missingPoints,
        prompt: buildPassHandoffNudge({
          objective: params.goal.objective,
          missingPoints: stored.missingPoints,
        }),
        rebindPass: true,
      },
      {
        verdict: {
          outcome: "pass",
          missingPoints: stored.missingPoints,
          evidence: stored.evidence ?? [],
          risks: stored.risks ?? [],
          reason: "recorded-pass",
        },
        revision: stored.checkedRevision,
      },
    );
  }

  const claim = extractCompletionClaim(resolveFinalAssistantText(params.result));
  // An explicit status request goes through the tool gate and never triggers a
  // turn-end verifier run; the continuation keeps today's behavior.
  if (!claim || isExplicitGoalStatusRequest(params.result)) {
    return await queueAsToday();
  }

  const revision = resolveSessionGoalRevision(params.goal);
  if (isGoalVerificationCurrent({ goal: params.goal, verification }) && verification) {
    // A current pass authorizes completion, but the executor still has to make
    // that call. A continuation turn that claims completion without calling
    // `update_goal` must not stop automation silently: re-queue the handoff so
    // the continuation budget — and its visible stop notice — owns the bound.
    // A user-originated turn never reaches here with a stored pass (it was
    // dropped above), so this cannot spin on the user's own turn.
    if (params.goalContinuation) {
      return await queueStoredPassHandoff(verification);
    }
    return { queue: false };
  }

  /** One shared run per goal: the pre-check and the verifier are the expensive part. */
  const runOwnedVerification = async (): Promise<GoalVerificationRun> => {
    const prefilter = await evaluateGoalClaimPrefilter({
      cfg: params.cfg,
      agentId: params.agentId,
      objective: params.goal.objective,
      claim,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    // A classified `false` is the negative control: the turn does not claim
    // completion, so no verifier runs. `undefined` means the decision model was
    // unavailable (error, timeout, malformed answer); that is a missing
    // optimization, not a verdict, so verification still runs — fail open
    // toward verification, never toward completion.
    if (prefilter.claimsCompletion === false) {
      return { kind: "no-claim-signal" };
    }
    if (await hasPendingOperatorApproval(params.sessionKey)) {
      // A human is mid-approval on this session; do not run another model call.
      return { kind: "approval-pending" };
    }
    params.signal?.throwIfAborted();
    const verdict = await runGoalVerifier({
      cfg: params.cfg,
      agentId: params.agentId,
      objective: params.goal.objective,
      claim,
      ...(params.executor ? { executor: params.executor } : {}),
      settings,
      ...(params.signal ? { abortSignal: params.signal } : {}),
    });
    const recorded = await recordSessionGoalVerification({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      goalId: params.goal.id,
      revision,
      verification: {
        outcome: verdict.outcome,
        checkedAt: now,
        checkedRevision: revision,
        missingPoints: verdict.missingPoints,
        ...(verdict.evidence.length ? { evidence: verdict.evidence } : {}),
        ...(verdict.risks.length ? { risks: verdict.risks } : {}),
        ...(verdict.outcome === "unverified" ? { error: verdict.reason } : {}),
        attempts: Math.max(0, params.goal.verification?.attempts ?? 0) + 1,
      },
      now,
    });
    // A rejected write (the goal moved or was replaced while the verifier ran)
    // means the verdict judged a goal state that no longer exists. It must not
    // drive the turn: no completion authorization, and no stop either.
    if (!recorded.recorded) {
      return { kind: "stale" };
    }
    return { kind: "verdict", verdict };
  };

  let outcome: GoalVerificationRun;
  if (
    hasGoalVerificationForRevision({ goal: params.goal, verification }) &&
    isGoalVerificationCoolingDown({
      goal: params.goal,
      verification,
      cooldownMs: settings.cooldownMs,
      now,
    }) &&
    verification
  ) {
    // This revision was just checked; reuse the stored outcome instead of
    // paying for a second call. Cooldown never converts a failure into a pass.
    outcome = {
      kind: "verdict",
      verdict: {
        outcome: verification.outcome,
        missingPoints: verification.missingPoints,
        evidence: verification.evidence ?? [],
        risks: verification.risks ?? [],
        reason: `recorded-${verification.outcome}`,
      },
    };
  } else {
    // Check-and-set stay in one synchronous step: concurrent claims for the same
    // goal share a single in-flight run instead of starting a second one.
    const key = inFlightKey(params.sessionKey, params.goal.id);
    const existing = inFlightVerification.get(key);
    if (existing) {
      outcome = await existing;
    } else {
      const pending = runOwnedVerification();
      inFlightVerification.set(key, pending);
      try {
        outcome = await pending;
      } finally {
        inFlightVerification.delete(key);
      }
    }
  }

  if (outcome.kind !== "verdict") {
    // Nothing authorizes a judgment yet (no claim signal, a pending approval, or
    // a verdict the store refused because the goal moved). Keep today's nudge
    // behavior; a refused verdict must never stand in for a decision.
    return await queueAsToday();
  }
  const verdict = outcome.verdict;

  /**
   * Shared tail for a verdict that authorizes one more automatic turn: spend the
   * continuation budget, then queue the verdict-specific prompt — or stop at the
   * cap. A stale advance (the goal moved) queues nothing and authorizes nothing.
   * The verdict and the revision it was judged at are passed in, so a caller that
   * acts on a stored verdict binds the same fields as one acting on a fresh run.
   */
  async function queueAdvanceForVerdict(
    advanceParams: {
      missingPoints: string[];
      prompt: string;
      /** Binds the verdict to the revision the queued turn will actually run at. */
      rebindPass?: boolean;
    },
    judged: { verdict: GoalVerificationVerdict; revision: string },
  ): Promise<GoalTurnEndDecision> {
    const judgedVerdict = judged.verdict;
    const judgedRevision = judged.revision;
    const advance = await advanceSessionGoalContinuation({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      goalId: params.goal.id,
      maxTurns: settings.maxContinuationTurns,
      now,
    });
    if (advance.status === "stale") {
      // The goal moved under us; the next turn re-evaluates against fresh state.
      return { queue: false };
    }
    if (advance.status === "capped") {
      return {
        queue: false,
        ...(advance.attentionRecorded
          ? {
              notice: buildAttentionNotice({
                objective: params.goal.objective,
                reason: "continuation-budget",
                missingPoints: advanceParams.missingPoints,
                verification: verdictAsRecord(
                  judgedVerdict,
                  judgedRevision,
                  now,
                  attemptsFor(params.goal),
                ),
                maxContinuationTurns: settings.maxContinuationTurns,
              }),
            }
          : {}),
      };
    }
    if (advanceParams.rebindPass && advance.goal) {
      // Advancing the counter is part of the goal revision, so the verdict that
      // justified this turn must be re-bound to the revision the queued turn
      // runs at. Otherwise `update_goal` would refuse the handoff for having no
      // verdict on the *current* revision, and the goal would strand with a pass.
      const turnRevision = resolveSessionGoalRevision(advance.goal);
      const rebound = await recordSessionGoalVerification({
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        goalId: params.goal.id,
        revision: turnRevision,
        verification: verdictAsRecord(judgedVerdict, turnRevision, now, attemptsFor(params.goal)),
        now,
      });
      if (!rebound.recorded) {
        // The store refused the rebind; a queued handoff would be refused by the
        // tool gate, so the goal keeps today's nudge instead.
        return { queue: true };
      }
    }
    return { queue: true, promptOverride: advanceParams.prompt };
  }

  if (verdict.outcome === "pass") {
    // A pass opens completion, but the verifier never completes the goal itself:
    // only the executor's `update_goal` path may. Queue exactly one bounded
    // handoff turn that tells the executor the verdict is in and what to do with
    // it. The handoff is a normal goal continuation, so it consumes the same
    // continuation budget and the loop ends when the goal becomes `complete`.
    return await queueAdvanceForVerdict(
      {
        missingPoints: [],
        prompt: buildPassHandoffNudge({
          objective: params.goal.objective,
          missingPoints: verdict.missingPoints,
        }),
        rebindPass: true,
      },
      { verdict, revision },
    );
  }
  if (verdict.outcome === "fail" || verdict.outcome === "unknown") {
    return await queueAdvanceForVerdict(
      {
        missingPoints: verdict.missingPoints.length > 0 ? verdict.missingPoints : gaps,
        prompt: buildMissingPointsNudge({
          objective: params.goal.objective,
          missingPoints: verdict.missingPoints,
          outcome: verdict.outcome,
        }),
      },
      { verdict, revision },
    );
  }
  // `unverified` (error, timeout, malformed output): the turn ends normally and
  // the loop keeps today's nudge. Completion stays closed.
  return await queueAsToday();
}

function attemptsFor(goal: SessionGoal): number {
  return Math.max(0, goal.verification?.attempts ?? 0) + 1;
}

function verdictAsRecord(
  verdict: GoalVerificationVerdict,
  revision: string,
  now: number,
  attempts: number,
): SessionGoalVerification {
  return {
    outcome: verdict.outcome,
    checkedAt: now,
    checkedRevision: revision,
    missingPoints: verdict.missingPoints,
    ...(verdict.evidence.length ? { evidence: verdict.evidence } : {}),
    ...(verdict.risks.length ? { risks: verdict.risks } : {}),
    ...(verdict.outcome === "unverified" ? { error: verdict.reason } : {}),
    attempts,
  };
}

async function stopAutomation(params: {
  params: DecideGoalTurnEndParams;
  settings: GoalVerificationSettings;
  reason: "continuation-budget" | "verification-attempts";
  gaps: string[];
  verification: SessionGoalVerification | undefined;
}): Promise<GoalTurnEndDecision> {
  const record = await markSessionGoalAttention({
    sessionKey: params.params.sessionKey,
    storePath: params.params.storePath,
    goalId: params.params.goal.id,
    reason: params.reason,
    now: params.params.now ?? Date.now(),
    summary: `goal automation stopped: ${params.reason}`,
  });
  if (!record.recorded) {
    return { queue: false };
  }
  return {
    queue: false,
    notice: buildAttentionNotice({
      objective: params.params.goal.objective,
      reason: params.reason,
      missingPoints: params.gaps,
      verification: params.verification,
      maxContinuationTurns: params.settings.maxContinuationTurns,
    }),
  };
}
