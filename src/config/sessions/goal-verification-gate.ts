// Pure completion-verification gate logic shared by both enforcement points.
//
// Nothing here performs I/O. The turn-end coordinator owns verifier runs and
// store writes; the `update_goal` tool only needs the currency and refusal
// rules, so its import stays cheap and side-effect free.
import type {
  SessionGoal,
  SessionGoalVerification,
} from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  isGoalVerificationArmed,
  resolveGoalVerificationSettings,
  type GoalVerificationSettings,
} from "./goal-verification-config.js";
import { resolveSessionGoalRevision } from "./goals-transitions.js";

/**
 * True when the global verification switch is on. Used to decide whether the
 * optional `create_goal` opt-in parameter is offered at all: with the gate off
 * the tool surface stays as it was, instead of advertising an inert parameter.
 */
export function isGoalVerificationEnabled(cfg: OpenClawConfig): boolean {
  return resolveGoalVerificationSettings(cfg).enabled;
}

/** Resolves whether this goal is armed; a goal created without the flag never becomes armed. */
export function resolveArmedGoalVerification(params: {
  cfg: OpenClawConfig;
  goal: SessionGoal | undefined;
}): { settings: GoalVerificationSettings; armed: boolean } {
  const settings = resolveGoalVerificationSettings(params.cfg);
  return {
    settings,
    armed:
      params.goal !== undefined &&
      isGoalVerificationArmed({
        settings,
        goalVerifyCompletion: params.goal.verifyCompletion,
      }),
  };
}

/**
 * True when the recorded verdict judged the current goal revision *and* passed.
 * A verdict is never reused across revisions: any objective edit or status
 * transition moves the revision and forces a fresh check.
 */
export function isGoalVerificationCurrent(params: {
  goal: SessionGoal;
  verification: SessionGoalVerification | undefined;
}): boolean {
  const verification = params.verification;
  return Boolean(
    verification &&
    verification.outcome === "pass" &&
    verification.checkedRevision === resolveSessionGoalRevision(params.goal),
  );
}

/** Reports whether the recorded check already covered this exact revision, whatever it found. */
export function hasGoalVerificationForRevision(params: {
  goal: SessionGoal;
  verification: SessionGoalVerification | undefined;
}): boolean {
  return params.verification?.checkedRevision === resolveSessionGoalRevision(params.goal);
}

/**
 * True while a fresh check would repeat work with nothing changed since the
 * last one. The cooldown only suppresses repeats of the *same* revision; a new
 * revision is always eligible.
 */
export function isGoalVerificationCoolingDown(params: {
  goal: SessionGoal;
  verification: SessionGoalVerification | undefined;
  cooldownMs: number;
  now: number;
}): boolean {
  const verification = params.verification;
  if (!verification || params.cooldownMs <= 0) {
    return false;
  }
  if (verification.checkedRevision !== resolveSessionGoalRevision(params.goal)) {
    return false;
  }
  return params.now - verification.checkedAt < params.cooldownMs;
}

/** Counts verifier attempts against the goal's budget, including errors. */
export function resolveGoalVerificationAttempts(
  verification: SessionGoalVerification | undefined,
): number {
  return verification?.attempts ?? 0;
}

export function isGoalVerificationAttemptBudgetExhausted(params: {
  verification: SessionGoalVerification | undefined;
  maxAttempts: number;
}): boolean {
  return resolveGoalVerificationAttempts(params.verification) >= params.maxAttempts;
}

/**
 * Whether the continuation budget still allows another automatic goal turn.
 * Exhaustion never completes the goal and never implies `blocked`.
 */
export function isGoalContinuationBudgetExhausted(params: {
  goal: SessionGoal;
  maxContinuationTurns: number;
}): boolean {
  return params.goal.continuationTurns >= params.maxContinuationTurns;
}

/** The criterion list a human or executor should see; empty when a pass has no gaps. */
export function resolveGoalVerificationGaps(
  verification: SessionGoalVerification | undefined,
): string[] {
  return verification?.missingPoints ?? [];
}

export type { GoalVerificationSettings };

export type GoalCompletionRefusal = {
  outcome: "no-verdict" | "fail" | "unknown" | "unverified";
  missingPoints: string[];
  message: string;
};

/**
 * Applies the `update_goal` truth-table column: with the gate armed, `complete`
 * is refused unless a passing verdict exists for the goal's current revision.
 * `blocked` never reaches this function because it is not gate-controlled.
 */
export function resolveGoalCompletionGate(params: {
  cfg: OpenClawConfig;
  goal: SessionGoal | undefined;
}): { required: boolean; refusal?: GoalCompletionRefusal } {
  const goal = params.goal;
  if (!goal) {
    return { required: false };
  }
  const { armed } = resolveArmedGoalVerification({ cfg: params.cfg, goal });
  if (!armed) {
    return { required: false };
  }
  const verification = goal.verification;
  if (isGoalVerificationCurrent({ goal, verification })) {
    return { required: true };
  }
  if (!verification || !hasGoalVerificationForRevision({ goal, verification })) {
    return {
      required: true,
      refusal: {
        outcome: "no-verdict",
        missingPoints: [],
        message:
          "Completion verification is required for this goal, but no verifier verdict exists for its current state. Keep working, then state completion so the verifier can run.",
      },
    };
  }
  if (verification.outcome === "unverified") {
    return {
      required: true,
      refusal: {
        outcome: "unverified",
        missingPoints: verification.missingPoints,
        message: `Completion is not authorized: the verifier could not decide (${verification.error ?? "no detail"}). Keep working and state completion again later.`,
      },
    };
  }
  return {
    required: true,
    refusal: {
      outcome: verification.outcome === "fail" ? "fail" : "unknown",
      missingPoints: verification.missingPoints,
      message:
        verification.outcome === "fail"
          ? "Completion is refused: an independent verifier found the objective unmet."
          : "Completion is refused: an independent verifier could not confirm the objective from the available material.",
    },
  };
}
