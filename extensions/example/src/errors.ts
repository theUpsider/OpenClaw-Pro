import type { ProviderDecisionOutcome, ProviderFailureReason } from "openclaw/plugin-sdk/decisions";

export class EvaluationError extends Error {
  constructor(
    message: string,
    readonly reason: ProviderFailureReason,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EvaluationError";
  }
}

/**
 * The host closed admission for this evaluation mid-flight. Terminal for the
 * call, never a provider outage: it rejects so the host fences it.
 */
export class DecisionAdmissionError extends Error {
  constructor() {
    super("Example decision is no longer admitted.");
    this.name = "DecisionAdmissionError";
  }
}

/** Only fixed plugin diagnostics cross the provider boundary; raw causes stay discarded. */
export function evaluationError(error: unknown, aborted: boolean): EvaluationError {
  if (aborted) {
    return new EvaluationError("Example evaluation cancelled.", "transport");
  }
  if (error instanceof EvaluationError) {
    return error;
  }
  return new EvaluationError(
    "Example evaluation failed or returned an invalid response.",
    "invalid-response",
  );
}

/** Unexpected failures reject without retaining raw diagnostics, submitted state, or responses. */
export function decisionFailure(error: unknown): ProviderDecisionOutcome {
  if (error instanceof EvaluationError) {
    return {
      status: "unavailable",
      reason: error.reason,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  if (error instanceof DecisionAdmissionError) {
    throw error;
  }
  throw new Error("Example decision adapter contract failure.");
}
