import { describe, expect, it } from "vitest";
import { MAIN_THREAD_STALL_ATTRIBUTION_MS } from "./main-thread-stall.js";
import { createYieldBudgetStepStats, runStepsWithYieldBudget } from "./yield-budget.js";

function* recordSteps(events: string[], count: number, cost: (step: number) => void) {
  for (let step = 0; step < count; step++) {
    events.push(`step ${step}`);
    cost(step);
    yield;
  }
  return "done";
}

describe("runStepsWithYieldBudget", () => {
  it("returns to the event loop at a step boundary once the turn budget is spent", async () => {
    let clock = 0;
    const events: string[] = [];
    setImmediate(() => events.push("immediate"));
    const result = await runStepsWithYieldBudget(
      recordSteps(events, 4, () => {
        clock += 7;
      }),
      { budgetMs: 12, now: () => clock },
    );
    expect(result).toBe("done");
    // 7 ms steps: the second step exhausts the 12 ms budget, so the queued callback runs
    // before the third step instead of after the whole run.
    expect(events).toEqual(["step 0", "step 1", "immediate", "step 2", "step 3"]);
  });

  it("keeps cheap steps in one turn", async () => {
    const events: string[] = [];
    setImmediate(() => events.push("immediate"));
    await runStepsWithYieldBudget(
      recordSteps(events, 3, () => {}),
      { budgetMs: 12, now: () => 0 },
    );
    events.push("settled");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["step 0", "step 1", "step 2", "settled", "immediate"]);
  });

  it("propagates a step failure without running later steps", async () => {
    let clock = 0;
    const events: string[] = [];
    const steps = recordSteps(events, 3, (step) => {
      clock += 20;
      if (step === 1) {
        throw new Error("step failed");
      }
    });
    await expect(runStepsWithYieldBudget(steps, { now: () => clock })).rejects.toThrow(
      "step failed",
    );
    expect(events).toEqual(["step 0", "step 1"]);
  });
});

describe("runStepsWithYieldBudget step stats", () => {
  function* labeledSteps(advance: (ms: number) => void, costs: Record<string, number>) {
    for (const [label, cost] of Object.entries(costs)) {
      advance(cost);
      yield label;
    }
    advance(1);
    return "done";
  }

  it("reports no outlier for steps that stay under the attribution threshold", async () => {
    let clock = 0;
    const stats = createYieldBudgetStepStats();
    const result = await runStepsWithYieldBudget(
      labeledSteps((ms) => (clock += ms), { first: 3, second: 20, third: 5 }),
      { now: () => clock, stats },
    );
    expect(result).toBe("done");
    expect(stats).toEqual({ outliers: 0, maxStepMs: 20, maxStepLabel: "second" });
  });

  it("surfaces every step at or above the stall owner's 500 ms attribution threshold", async () => {
    let clock = 0;
    const stats = createYieldBudgetStepStats();
    await runStepsWithYieldBudget(
      labeledSteps((ms) => (clock += ms), { cheap: 2, edge: 499, slow: 500, slowest: 812 }),
      { now: () => clock, stats },
    );
    expect(MAIN_THREAD_STALL_ATTRIBUTION_MS).toBe(500);
    expect(stats).toEqual({ outliers: 2, maxStepMs: 812, maxStepLabel: "slowest" });
  });

  it("does not attribute work that ran while the driver yielded to the next step", async () => {
    let clock = 0;
    const stats = createYieldBudgetStepStats();
    const events: string[] = [];
    // Another task holds the loop for 900 ms while the run is parked between turns.
    setImmediate(() => {
      events.push("other task");
      clock += 900;
    });
    await runStepsWithYieldBudget(
      labeledSteps(
        (ms) => {
          events.push(`step ${ms}`);
          clock += ms;
        },
        { first: 7, second: 7, third: 7 },
      ),
      { budgetMs: 12, now: () => clock, stats },
    );
    expect(events).toEqual(["step 7", "step 7", "other task", "step 7", "step 1"]);
    expect(stats).toEqual({ outliers: 0, maxStepMs: 7, maxStepLabel: "first" });
  });
});
