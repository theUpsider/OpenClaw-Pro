import { setImmediate as nextTurn } from "node:timers/promises";
import { MAIN_THREAD_STALL_ATTRIBUTION_MS } from "./main-thread-stall.js";

/**
 * Synchronous work one event-loop turn may spend before cooperative work steps back.
 * Same order as the WS request-start budget: timers, sockets, and request starts then wait
 * at most about one slice behind a long multi-step run instead of for the whole run.
 */
export const DEFAULT_YIELD_BUDGET_MS = 12;

/**
 * Per-run step facts. The budget is a target: a single step is never split, so one
 * expensive step still holds the loop for its whole duration. These facts name it.
 */
export type YieldBudgetStepStats = {
  /** Steps that ran at or above the outlier threshold. */
  outliers: number;
  maxStepMs: number;
  /** Value the longest step yielded at its end; undefined for the final step. */
  maxStepLabel: string | undefined;
};

export function createYieldBudgetStepStats(): YieldBudgetStepStats {
  return { outliers: 0, maxStepMs: 0, maxStepLabel: undefined };
}

export type YieldBudgetOptions = {
  budgetMs?: number;
  /** Monotonic milliseconds; defaults to `performance.now()`. */
  now?: () => number;
  /** Defaults to the main-thread stall owner's attribution threshold. */
  outlierMs?: number;
  /** Caller-owned sink; the driver only updates counters, it never logs. */
  stats?: YieldBudgetStepStats;
};

/**
 * Drives a step generator to completion. Each `yield` marks a boundary where the run may
 * return to the event loop; it does so only once the current turn has spent its budget, so
 * cheap steps share a turn. A single step is never interrupted: it owns its own boundaries.
 * A step may yield a label so its duration can be attributed when it is an outlier.
 */
export async function runStepsWithYieldBudget<T>(
  steps: Generator<string | void, T>,
  options: YieldBudgetOptions = {},
): Promise<T> {
  const budgetMs = options.budgetMs ?? DEFAULT_YIELD_BUDGET_MS;
  const outlierMs = options.outlierMs ?? MAIN_THREAD_STALL_ATTRIBUTION_MS;
  const now = options.now ?? (() => performance.now());
  const stats = options.stats ?? createYieldBudgetStepStats();
  let turnStartedAt = now();
  let stepStartedAt = turnStartedAt;
  let step = steps.next();
  for (;;) {
    // One clock read both times the finished step and checks the turn budget.
    const at = now();
    const stepMs = at - stepStartedAt;
    if (stepMs >= outlierMs) {
      stats.outliers++;
    }
    if (stepMs > stats.maxStepMs) {
      stats.maxStepMs = stepMs;
      stats.maxStepLabel = step.done ? undefined : (step.value ?? undefined);
    }
    if (step.done) {
      return step.value;
    }
    stepStartedAt = at;
    if (at - turnStartedAt >= budgetMs) {
      await nextTurn();
      turnStartedAt = stepStartedAt = now();
    }
    step = steps.next();
  }
}
