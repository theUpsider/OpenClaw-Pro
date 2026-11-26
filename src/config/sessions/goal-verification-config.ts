// Adversarial goal-completion verification: config resolution and the two-way opt-in.
//
// The feature is opt-in twice over. `agents.defaults.experimental.goalCompletionVerification`
// arms it fleet-wide, and each goal carries its own `verifyCompletion` flag captured
// at creation. Either alone leaves the gate off, and a goal created without the
// flag is never opted in by a later global switch.
import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../types.openclaw.js";

export type GoalVerificationSettings = {
  /** Global switch; `true` only for a literal `true`. */
  enabled: boolean;
  /** Optional verifier model ref (`provider/model`); falls back to the agent primary. */
  verifierModel?: string;
  /** Cooldown between two verifier runs for the same goal, in milliseconds. */
  cooldownMs: number;
  /** Maximum automatic goal-continuation turns before automation stops. */
  maxContinuationTurns: number;
  /** Maximum verifier attempts per goal, including errors and timeouts. */
  maxAttempts: number;
};

export const GOAL_VERIFICATION_DEFAULT_COOLDOWN_MS = 15_000;
export const GOAL_VERIFICATION_DEFAULT_MAX_CONTINUATION_TURNS = 12;
export const GOAL_VERIFICATION_DEFAULT_MAX_ATTEMPTS = 6;

const DISABLED: GoalVerificationSettings = {
  enabled: false,
  cooldownMs: GOAL_VERIFICATION_DEFAULT_COOLDOWN_MS,
  maxContinuationTurns: GOAL_VERIFICATION_DEFAULT_MAX_CONTINUATION_TURNS,
  maxAttempts: GOAL_VERIFICATION_DEFAULT_MAX_ATTEMPTS,
};

function resolvePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Reads the opt-in global switch and its tuning. Anything invalid stays at its
 * default, and a switch that is anything but a literal `true` disables the gate
 * without further work.
 */
export function resolveGoalVerificationSettings(cfg: OpenClawConfig): GoalVerificationSettings {
  const raw = cfg.agents?.defaults?.experimental;
  if (!raw || raw.goalCompletionVerification !== true) {
    return DISABLED;
  }
  const verifierModel = raw.goalVerificationModel?.trim();
  return {
    enabled: true,
    ...(verifierModel && parseProviderModelRef(verifierModel) ? { verifierModel } : {}),
    cooldownMs: resolveNonNegativeInteger(
      raw.goalVerificationCooldownMs,
      GOAL_VERIFICATION_DEFAULT_COOLDOWN_MS,
    ),
    maxContinuationTurns: resolvePositiveInteger(
      raw.goalVerificationMaxContinuationTurns,
      GOAL_VERIFICATION_DEFAULT_MAX_CONTINUATION_TURNS,
    ),
    maxAttempts: resolvePositiveInteger(
      raw.goalVerificationMaxAttempts,
      GOAL_VERIFICATION_DEFAULT_MAX_ATTEMPTS,
    ),
  };
}

/**
 * Both opt-ins must hold. A goal without its own flag is never armed by the
 * global switch alone, so goals created before the flag keep today's behavior.
 */
export function isGoalVerificationArmed(params: {
  settings: GoalVerificationSettings;
  goalVerifyCompletion: boolean | undefined;
}): boolean {
  return params.settings.enabled && params.goalVerifyCompletion === true;
}
