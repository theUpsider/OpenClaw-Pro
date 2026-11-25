// Truth-table and negative-control coverage for the turn-end verification gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionGoal } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../config/zod-schema.agent-defaults-base.js";
import type { evaluateDecisionInRegistry } from "../../decisions/runtime.js";
import type { DecisionOutcome } from "../../decisions/types.js";
import { decideGoalTurnEndContinuation } from "./goal-verification-coordinator.js";
import type { GoalVerificationVerdict } from "./goal-verification.js";
import { GOAL_CLAIM_QUESTION_ID } from "./goal-verification.js";

const mocks = vi.hoisted(() => ({
  evaluate: vi.fn<typeof evaluateDecisionInRegistry>(),
}));
vi.mock("../../decisions/runtime.js", () => ({ evaluateDecisionInRegistry: mocks.evaluate }));
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: () => null,
}));

const verifier = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./goal-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./goal-verification.js")>()),
  runGoalVerifier: verifier.run,
}));

const approvals = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../gateway/operator-approval-store.js", () => ({
  listPendingOperatorApprovals: approvals.list,
}));

const store = vi.hoisted(() => ({
  record: vi.fn(),
  clear: vi.fn(),
  advance: vi.fn(),
  attention: vi.fn(),
}));
vi.mock("../../config/sessions/goals.js", () => ({
  recordSessionGoalVerification: store.record,
  clearSessionGoalVerification: store.clear,
  advanceSessionGoalContinuation: store.advance,
  markSessionGoalAttention: store.attention,
}));

// mock-isolation: The coordinator's post-drop re-read is supplied without a real session store.
const readEntry = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: readEntry.current,
}));

const arr: [] = [];
void arr;

const armedConfig: OpenClawConfig = {
  agents: {
    defaults: AgentDefaultsBaseSchema.parse({
      model: "test/executor",
      experimental: { decisionAssistance: true, goalCompletionVerification: true },
      decisionModel: "fixture/decision",
    }),
  },
};

function goal(over: Partial<SessionGoal> = {}): SessionGoal {
  return {
    schemaVersion: 1,
    id: "goal-1",
    objective: "Ship the verified fix",
    status: "active",
    createdAt: 1,
    updatedAt: 100,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
    verifyCompletion: true,
    ...over,
  };
}

function turn(over: Partial<EmbeddedAgentRunResult["meta"]> = {}): EmbeddedAgentRunResult {
  return {
    meta: {
      durationMs: 0,
      stopReason: "end_turn",
      finalAssistantMessageRawText: "Done — the fix is shipped and verified.",
      ...over,
    },
    payloads: [{ text: "Done — the fix is shipped and verified." }],
  };
}

const verdict = (outcome: GoalVerificationVerdict["outcome"]): GoalVerificationVerdict => ({
  outcome,
  missingPoints: outcome === "pass" ? [] : ["integration test not run"],
  evidence: [],
  risks: [],
  reason: `verifier-${outcome}`,
});

function decide(over: Partial<Parameters<typeof decideGoalTurnEndContinuation>[0]> = {}) {
  return decideGoalTurnEndContinuation({
    cfg: armedConfig,
    agentId: "main",
    sessionKey: "agent:main:goal",
    storePath: "/fixture/sessions.json",
    goal: goal(),
    result: turn(),
    executor: { provider: "test", model: "executor" },
    ...over,
  });
}

beforeEach(() => {
  setRuntimeConfigSnapshot(armedConfig);
  mocks.evaluate.mockReset().mockResolvedValue({
    status: "ok",
    provenance: { providerId: "fixture", rubricVersion: "1", runtimeGeneration: "test" },
    result: {
      model: "m",
      answers: { [GOAL_CLAIM_QUESTION_ID]: { type: "boolean", probabilityTrue: 1 } },
    },
  } as DecisionOutcome);
  verifier.run.mockReset().mockResolvedValue(verdict("pass"));
  approvals.list.mockReset().mockResolvedValue([]);
  store.record.mockReset().mockResolvedValue({ recorded: true });
  store.clear.mockReset().mockResolvedValue({ cleared: true });
  store.advance.mockReset().mockResolvedValue({ status: "advanced" });
  store.attention.mockReset().mockResolvedValue({ recorded: true });
  readEntry.current.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("goal verification turn-end gate", () => {
  it("performs no verification work while the gate is off", async () => {
    const decision = await decide({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
    });
    expect(decision).toEqual({ queue: true });
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(verifier.run).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
    expect(store.advance).not.toHaveBeenCalled();
  });
  it("stays off for a goal created without the per-goal opt-in", async () => {
    const decision = await decide({ goal: goal({ verifyCompletion: undefined }) });
    expect(decision).toEqual({ queue: true });
    expect(verifier.run).not.toHaveBeenCalled();
  });
  it("runs no verifier for a below-threshold claim", async () => {
    mocks.evaluate.mockResolvedValue({
      status: "ok",
      provenance: { providerId: "fixture", rubricVersion: "1", runtimeGeneration: "test" },
      result: {
        model: "m",
        answers: { [GOAL_CLAIM_QUESTION_ID]: { type: "boolean", probabilityTrue: 0.05 } },
      },
    } as DecisionOutcome);
    const decision = await decide();
    expect(verifier.run).not.toHaveBeenCalled();
    expect(decision).toEqual({ queue: true });
    expect(store.advance).toHaveBeenCalledTimes(1);
  });
  it("queues exactly one bounded handoff that tells the executor to complete the goal", async () => {
    store.advance.mockResolvedValue({
      status: "advanced",
      goal: goal({ continuationTurns: 1 }),
    });
    const decision = await decide();
    expect(verifier.run).toHaveBeenCalledTimes(1);
    // A pass opens completion, but the verifier never completes the goal itself.
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toContain("update_goal");
    expect(decision.promptOverride).toContain('status "complete"');
    expect(decision.promptOverride).toContain("Ship the verified fix");
    expect(store.advance).toHaveBeenCalledTimes(1);
    expect(store.record).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: expect.stringContaining("goal-1:100:0"),
        verification: expect.objectContaining({ outcome: "pass" }),
      }),
    );
    // The handoff turn runs at the advanced revision (the counter moved), so the
    // pass is re-bound to it; otherwise update_goal would refuse the handoff.
    expect(store.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: "goal-1:100:1",
        verification: expect.objectContaining({ outcome: "pass", checkedRevision: "goal-1:100:1" }),
      }),
    );
  });
  it("keeps today's nudge when the store refuses to re-bind the pass", async () => {
    store.advance.mockResolvedValue({
      status: "advanced",
      goal: goal({ continuationTurns: 1 }),
    });
    store.record.mockResolvedValueOnce({ recorded: true }).mockResolvedValueOnce({
      recorded: false,
    });
    const decision = await decide();
    // A handoff the tool gate would refuse must not be queued as if it would work.
    expect(decision.promptOverride).toBeUndefined();
    expect(decision.queue).toBe(true);
  });
  it("hands off nothing when the goal stopped being active before the pass", async () => {
    // The executor completed (or the operator paused) the goal while the verifier
    // ran: the handoff must not resurrect a goal that is no longer active, which
    // is what bounds the loop to a single continuation.
    store.advance.mockResolvedValue({ status: "stale" });
    const decision = await decide();
    expect(decision.queue).toBe(false);
    expect(decision.promptOverride).toBeUndefined();
  });
  it("hands off nothing once the continuation budget is spent", async () => {
    store.advance.mockResolvedValue({ status: "capped", attentionRecorded: true });
    const decision = await decide();
    expect(decision.queue).toBe(false);
    expect(decision.promptOverride).toBeUndefined();
    expect(decision.notice).toContain("Goal automation stopped");
  });
  it("keeps the goal open and carries the missing points on a fail", async () => {
    verifier.run.mockResolvedValue(verdict("fail"));
    const decision = await decide();
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toContain("Ship the verified fix");
    expect(decision.promptOverride).toContain("integration test not run");
    expect(decision.promptOverride).toContain("Missing points:");
    expect(store.advance).toHaveBeenCalledTimes(1);
  });
  it("keeps the goal open and carries the missing points on unknown", async () => {
    verifier.run.mockResolvedValue(verdict("unknown"));
    const decision = await decide();
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toContain("Ship the verified fix");
  });
  it("keeps today's nudge and ends the turn normally when unverified", async () => {
    verifier.run.mockResolvedValue({
      outcome: "unverified",
      missingPoints: [],
      evidence: [],
      risks: [],
      reason: "timeout",
    });
    const decision = await decide();
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toBeUndefined();
    expect(decision.notice).toBeUndefined();
    expect(store.record).toHaveBeenCalledWith(
      expect.objectContaining({
        verification: expect.objectContaining({ outcome: "unverified", error: "timeout" }),
      }),
    );
  });
  it("does not verify a turn that explicitly called update_goal", async () => {
    const decision = await decide({
      result: turn({ toolSummary: { calls: 1, tools: ["update_goal"] } }),
    });
    expect(decision.queue).toBe(true);
    expect(verifier.run).not.toHaveBeenCalled();
  });
  it("runs the verifier when the decision model is unavailable", async () => {
    // F5: `undefined` means the classifier could not answer, not that the turn
    // made no completion claim. Without decision assistance the gate must still
    // verify — fail open toward verification, never toward completion.
    mocks.evaluate.mockResolvedValue({
      status: "unavailable",
      reason: "disabled",
    } as DecisionOutcome);
    const decision = await decide();
    expect(verifier.run).toHaveBeenCalledTimes(1);
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toContain("update_goal");
  });
  it("keeps a stored pass on a goal-continuation turn", async () => {
    // F4: the passing handoff and the advance turn are continuations, so they
    // keep the verdict. Only a user-originated turn invalidates it.
    store.advance.mockResolvedValue({
      status: "advanced",
      goal: goal({ continuationTurns: 1 }),
    });
    const decision = await decide({
      goalContinuation: true,
      goal: goal({
        verification: {
          outcome: "pass",
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: [],
          attempts: 1,
        },
      }),
    });
    expect(store.clear).not.toHaveBeenCalled();
    expect(verifier.run).not.toHaveBeenCalled();
    // A current pass keeps authorization open, and a continuation that claimed
    // completion without calling update_goal is handed off again instead of
    // stopping automation silently. The budget bounds it.
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toContain("update_goal");
    expect(store.advance).toHaveBeenCalledTimes(1);
  });

  it("does not strand an active goal when a handoff turn omits update_goal", async () => {
    // Defect A: a current pass plus a completion-claiming continuation used to
    // return { queue: false } — an active goal with no scheduled work and no
    // notice. It must re-handoff, and the cap must be the bound.
    store.advance.mockResolvedValue({
      status: "advanced",
      goal: goal({ continuationTurns: 2 }),
    });
    const decision = await decide({
      goalContinuation: true,
      goal: goal({
        verification: {
          outcome: "pass",
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: [],
          attempts: 1,
        },
      }),
    });
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toContain('status "complete"');

    // At the cap the loop stops and the stop is visible, never silent.
    store.advance.mockResolvedValue({ status: "capped", attentionRecorded: true });
    const capped = await decide({
      goalContinuation: true,
      goal: goal({
        verification: {
          outcome: "pass",
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: [],
          attempts: 1,
        },
      }),
    });
    expect(capped.queue).toBe(false);
    expect(capped.notice).toContain("Goal automation stopped");
  });

  it("drops a stored pass when a user-originated turn ends", async () => {
    // F4: ordinary work does not move the goal revision, so a pass would otherwise
    // survive work that undid the verified result. The ending user turn ends the
    // stretch of work the verdict judged.
    await decide({
      goal: goal({
        verification: {
          outcome: "pass",
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: [],
          attempts: 1,
        },
      }),
    });
    expect(store.clear).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: "goal-1", sessionKey: "agent:main:goal" }),
    );
    expect(verifier.run).toHaveBeenCalledTimes(1);
  });
  it("does not decide on a verdict the store refused", async () => {
    // F3: the referred verdict judged a goal state that no longer exists, so it
    // may not authorize completion *or* stop the loop. The turn falls back to
    // today's behavior and re-verifies against the current state.
    store.record.mockResolvedValue({ recorded: false });
    const decision = await decide();
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toBeUndefined();
    expect(store.advance).toHaveBeenCalledTimes(1);
  });
  it("does not stop the loop when dropping a stored verdict is refused", async () => {
    // F3: a refused write must never stand in for a decision. The current row
    // still holds a pass, but the store rejected this turn's verdict, so the
    // turn behaves like any unverified one (today's nudge, turn ends normally).
    store.record.mockResolvedValue({ recorded: false });
    store.clear.mockResolvedValue({ cleared: false });
    readEntry.current.mockResolvedValue(undefined);
    const decision = await decide({
      goal: goal({
        verification: {
          outcome: "pass",
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: [],
          attempts: 1,
        },
      }),
    });
    expect(decision.queue).toBe(true);
    expect(decision.promptOverride).toBeUndefined();
    expect(decision.notice).toBeUndefined();
  });
  it("re-verifies a verdict recorded for another revision", async () => {
    const decision = await decide({
      goal: goal({
        verification: {
          outcome: "pass",
          checkedAt: 150,
          checkedRevision: "goal-1:50:0",
          missingPoints: [],
          attempts: 1,
        },
      }),
    });
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(verifier.run).toHaveBeenCalledTimes(1);
    expect(decision.queue).toBe(true);
  });
  it("does not queue or verify while an operator approval is pending", async () => {
    approvals.list.mockResolvedValue([{ id: "approval-1" }]);
    const decision = await decide();
    expect(verifier.run).not.toHaveBeenCalled();
    expect(decision).toEqual({ queue: true });
  });
  it("stops automation once at the continuation cap and reports visually once", async () => {
    store.advance.mockResolvedValue({ status: "capped", attentionRecorded: true });
    verifier.run.mockResolvedValue(verdict("fail"));
    const decision = await decide();
    expect(decision.queue).toBe(false);
    expect(decision.notice).toContain("Goal automation stopped");
    expect(decision.notice).toContain("Ship the verified fix");
    expect(decision.notice).toContain("integration test not run");
    // A second pass must not repeat the notice.
    store.advance.mockResolvedValue({ status: "capped", attentionRecorded: false });
    const second = await decide();
    expect(second.queue).toBe(false);
    expect(second.notice).toBeUndefined();
  });
  it("stops without a verifier run once the attempt budget is spent", async () => {
    // The attempt budget is a continuation-loop budget: a user turn first drops
    // the stale record, so only a continuation can find the budget spent.
    const decision = await decide({
      goalContinuation: true,
      goal: goal({
        verification: {
          outcome: "unverified",
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: [],
          error: "error",
          attempts: 6,
        },
      }),
    });
    expect(verifier.run).not.toHaveBeenCalled();
    expect(decision.queue).toBe(false);
    expect(store.attention).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "verification-attempts" }),
    );
  });
  it("falls back to today's behavior for a goal that moved while verifying", async () => {
    const pending = createDeferred();
    verifier.run.mockImplementation(async () => {
      await pending.promise;
      return verdict("pass");
    });
    store.record.mockResolvedValue({ recorded: false });
    const result = decide();
    pending.resolve();
    expect((await result).queue).toBe(true);
  });
  it("counts only one verifier run for concurrent claims on the same goal", async () => {
    const pending = createDeferred<GoalVerificationVerdict>();
    verifier.run.mockImplementation(() => pending.promise);
    const first = decide();
    const second = decide();
    await vi.waitFor(() => expect(verifier.run).toHaveBeenCalledTimes(1));
    pending.resolve(verdict("pass"));
    await Promise.all([first, second]);
    expect(verifier.run).toHaveBeenCalledTimes(1);
  });
  it("carries the full objective in the nudge instead of clipping it", async () => {
    // F6: a clipped objective drops criteria the executor still owes. The nudge
    // bound is the protocol's own 16,000-character objective bound.
    const objective = `${"x".repeat(15_996)}-END`;
    expect(objective.length).toBe(16_000);
    verifier.run.mockResolvedValue(verdict("fail"));
    const decision = await decide({ goal: goal({ objective }) });
    expect(decision.promptOverride).toContain(objective);
    expect(decision.promptOverride).toContain("-END");
  });
  it("carries the full objective in a stopped-loop notice", async () => {
    const objective = `${"y".repeat(15_995)}-TAIL`;
    expect(objective.length).toBe(16_000);
    store.advance.mockResolvedValue({ status: "capped", attentionRecorded: true });
    verifier.run.mockResolvedValue(verdict("fail"));
    const decision = await decide({ goal: goal({ objective }) });
    expect(decision.notice).toContain("-TAIL");
  });
  it("records the attempts counter on every recorded verdict", async () => {
    verifier.run.mockResolvedValue(verdict("fail"));
    await decide({
      goalContinuation: true,
      goal: goal({
        verification: {
          outcome: "fail",
          checkedAt: 1,
          checkedRevision: "old",
          missingPoints: [],
          attempts: 2,
        },
      }),
    });
    expect(store.record).toHaveBeenCalledWith(
      expect.objectContaining({
        verification: expect.objectContaining({ attempts: 3 }),
      }),
    );
  });
});
