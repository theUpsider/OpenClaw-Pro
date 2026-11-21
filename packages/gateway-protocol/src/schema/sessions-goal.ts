import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Adversarial completion-verification state for one session goal.
 *
 * `checkedRevision` binds the outcome to the exact goal revision it judged; a
 * recorded outcome is never reused for another revision. `unverified` covers
 * errors, timeouts, and malformed verifier output and never authorizes
 * completion.
 */
export const SessionGoalVerificationSchema = closedObject({
  outcome: Type.Union([
    Type.Literal("pass"),
    Type.Literal("fail"),
    Type.Literal("unknown"),
    Type.Literal("unverified"),
  ]),
  checkedAt: Type.Number(),
  checkedRevision: NonEmptyString,
  missingPoints: Type.Array(Type.String()),
  evidence: Type.Optional(Type.Array(Type.String())),
  risks: Type.Optional(Type.Array(Type.String())),
  /** Reason an outcome is `unverified`; never a passing authorization. */
  error: Type.Optional(Type.String()),
  /** Verifier runs counted against the current attempt budget, including errors. */
  attempts: Type.Number(),
});

/** One-time "needs attention" marker recorded when automation stops on its own. */
export const SessionGoalAttentionSchema = closedObject({
  reason: Type.Union([Type.Literal("continuation-budget"), Type.Literal("verification-attempts")]),
  at: Type.Number(),
  detail: Type.Optional(Type.String()),
});

export const SessionGoalSchema = closedObject({
  schemaVersion: Type.Literal(1),
  id: NonEmptyString,
  objective: Type.String(),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("paused"),
    Type.Literal("blocked"),
    Type.Literal("usage_limited"),
    Type.Literal("budget_limited"),
    Type.Literal("complete"),
  ]),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  tokenStart: Type.Number(),
  tokenStartFresh: Type.Optional(Type.Boolean()),
  tokensUsed: Type.Number(),
  tokenBudget: Type.Optional(Type.Number()),
  continuationTurns: Type.Number(),
  /** Per-goal opt-in for adversarial completion verification; set at creation only. */
  verifyCompletion: Type.Optional(Type.Boolean()),
  /** Latest verifier outcome, or absent when verification never ran. */
  verification: Type.Optional(SessionGoalVerificationSchema),
  /** Present once automatic continuation stopped and a human should decide. */
  attention: Type.Optional(SessionGoalAttentionSchema),
  lastStatusNote: Type.Optional(Type.String()),
  pausedAt: Type.Optional(Type.Number()),
  blockedAt: Type.Optional(Type.Number()),
  completedAt: Type.Optional(Type.Number()),
  usageLimitedAt: Type.Optional(Type.Number()),
  budgetLimitedAt: Type.Optional(Type.Number()),
});

export type SessionGoal = Static<typeof SessionGoalSchema>;
export type SessionGoalVerification = Static<typeof SessionGoalVerificationSchema>;
export type SessionGoalAttention = Static<typeof SessionGoalAttentionSchema>;
export type SessionGoalStatus = SessionGoal["status"];
export type SessionGoalVerificationOutcome = SessionGoalVerification["outcome"];

const GoalOperationIdentity = {
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  goalId: NonEmptyString,
  operationId: Type.String({ minLength: 1, maxLength: 128 }),
  issuedAtMs: Type.Integer({ minimum: 0 }),
};

export const SessionsGoalUpdateParamsSchema = Type.Union([
  closedObject({
    ...GoalOperationIdentity,
    action: Type.Literal("edit"),
    objective: Type.String({ minLength: 1, maxLength: 16_000 }),
  }),
  closedObject({
    ...GoalOperationIdentity,
    action: Type.Union([
      Type.Literal("pause"),
      Type.Literal("resume"),
      Type.Literal("complete"),
      Type.Literal("block"),
    ]),
    note: Type.Optional(Type.String({ maxLength: 2_000 })),
  }),
]);
export const SessionsGoalClearParamsSchema = closedObject(GoalOperationIdentity);
export const SessionsGoalMutationResultSchema = closedObject({
  operationId: NonEmptyString,
  action: Type.Union([
    Type.Literal("start"),
    Type.Literal("edit"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("complete"),
    Type.Literal("block"),
    Type.Literal("clear"),
  ]),
  sessionId: NonEmptyString,
  goalId: NonEmptyString,
  goal: Type.Optional(SessionGoalSchema),
  runId: Type.Optional(NonEmptyString),
  replayed: Type.Optional(Type.Literal(true)),
  status: Type.Union([Type.Literal("started"), Type.Literal("updated"), Type.Literal("cleared")]),
});

export type SessionsGoalUpdateParams = Static<typeof SessionsGoalUpdateParamsSchema>;
export type SessionsGoalClearParams = Static<typeof SessionsGoalClearParamsSchema>;
export type SessionsGoalMutationResult = Static<typeof SessionsGoalMutationResultSchema>;
