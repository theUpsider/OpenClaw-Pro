import type {
  DecisionAnswer,
  DecisionOutcome,
  DecisionQuestion,
} from "openclaw/plugin-sdk/decisions";
import { describe, expect, it, vi } from "vitest";
import {
  createDecisionEvaluateCommand,
  createLobsterRegistry,
  DECISION_COMMAND_NAME,
  DECISION_REJECTION_MARKER,
  MAX_REJECTION_REASON_CHARS,
  resolveRoute,
  rubricVersionFor,
  validateRoutePolicy,
  type DecisionEvaluator,
  type LobsterCommand,
  type LobsterCommandContext,
  type LobsterRegistry,
  type RoutePolicy,
} from "./decision-bridge.js";

const choiceQuestion: DecisionQuestion = {
  type: "choice",
  criteria: { A: "safe to proceed", B: "needs review" },
};
const booleanQuestion: DecisionQuestion = { type: "boolean" };
const scoreQuestion: DecisionQuestion = { type: "score", criteria: ["low", "middle", "high"] };

function policy(overrides: Partial<RoutePolicy> = {}): RoutePolicy {
  return {
    questions: { route: choiceQuestion },
    question: "route",
    minConfidence: 0.5,
    ...overrides,
  };
}

function acceptedChoice(): Extract<DecisionAnswer, { type: "choice" }> {
  return {
    type: "choice",
    choice: "A",
    probabilities: { A: 0.83, B: 0.17 },
    confidence: 0.66,
  };
}

function ok(answers: Record<string, DecisionAnswer>): DecisionOutcome {
  return {
    status: "ok",
    result: { model: "fixture", answers },
    provenance: { providerId: "fixture", rubricVersion: "r", runtimeGeneration: "g" },
  };
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

function commandContext(signal?: AbortSignal): LobsterCommandContext {
  return {
    signal: signal ?? new AbortController().signal,
    env: {},
    cwd: "/tmp",
    stderr: { write: () => true },
  };
}

/**
 * Assert a rejection is delivered as a TERMINAL halt. An ordinary throw would be swallowed by
 * a step's `on_error: continue`/`retry`, letting a later branch run on an unresolved route.
 */
async function expectRejection(
  command: LobsterCommand,
  args: Record<string, unknown>,
  pattern: RegExp,
): Promise<void> {
  const result = await command.run({ input: noInput(), args, ctx: commandContext() });
  expect(result?.halt).toBe(true);
  const items = await collect(result!.output as AsyncIterable<unknown>);
  expect(items).toHaveLength(1);
  const item = items[0] as { status: string; reason: string };
  expect(item.status).toBe("rejected");
  expect(item.reason).toMatch(pattern);
  // A rejected run must never expose a route a condition could branch on.
  expect(item).not.toHaveProperty("route");
}

async function* noInput(): AsyncIterable<unknown> {
  // empty pipeline input
}

function baseRegistry(): LobsterRegistry {
  const registry: LobsterRegistry = {
    get: (name) => (name === "exec" ? { name: "exec", run: async () => undefined } : undefined),
    list: () => ["exec", "json", "head"],
  };
  return registry;
}

describe("validateRoutePolicy", () => {
  it("accepts each declared flag inside its bounds", () => {
    expect(() => validateRoutePolicy(policy({ minConfidence: 0 }))).not.toThrow();
    expect(() => validateRoutePolicy(policy({ minConfidence: 1 }))).not.toThrow();
    expect(() =>
      validateRoutePolicy(policy({ questions: { route: booleanQuestion }, minProbability: 0.51 })),
    ).not.toThrow();
    expect(() => validateRoutePolicy(policy({ minMargin: 0 }))).not.toThrow();
  });

  it.each([
    { label: "min-confidence below 0", override: { minConfidence: -0.1 } },
    { label: "min-confidence above 1", override: { minConfidence: 1.1 } },
    { label: "min-probability at the 0.5 midpoint", override: { minProbability: 0.5 } },
    { label: "min-probability below 0.5", override: { minProbability: 0.4 } },
    { label: "min-probability above 1", override: { minProbability: 1.2 } },
    { label: "min-margin at 1", override: { minMargin: 1 } },
    { label: "min-margin below 0", override: { minMargin: -0.2 } },
  ])("rejects an out-of-bounds flag: $label", ({ override }) => {
    expect(() => validateRoutePolicy(policy(override))).toThrow();
  });

  it("rejects a missing acceptance policy", () => {
    expect(() =>
      validateRoutePolicy({ questions: { route: choiceQuestion }, question: "route" }),
    ).toThrow(/requires an acceptance policy/);
  });
});

describe("resolveRoute", () => {
  it("accepts a choice whose provider label is the unique strict argmax", () => {
    expect(resolveRoute(acceptedChoice(), policy())).toBe("A");
  });

  it("accepts a choice on margin alone", () => {
    expect(
      resolveRoute(acceptedChoice(), policy({ minConfidence: undefined, minMargin: 0.5 })),
    ).toBe("A");
  });

  it("accepts booleans from the --min-probability band", () => {
    expect(
      resolveRoute(
        { type: "boolean", probabilityTrue: 0.95 },
        policy({
          questions: { route: booleanQuestion },
          minConfidence: undefined,
          minProbability: 0.9,
        }),
      ),
    ).toBe("true");
    expect(
      resolveRoute(
        { type: "boolean", probabilityTrue: 0.05 },
        policy({
          questions: { route: booleanQuestion },
          minConfidence: undefined,
          minProbability: 0.9,
        }),
      ),
    ).toBe("false");
  });

  it("accepts a score whose unique strict argmax level is the route", () => {
    const route = resolveRoute(
      { type: "score", score: 1.3, probabilities: [0.1, 0.5, 0.4], confidence: 0.8 },
      policy({ questions: { route: scoreQuestion }, question: "route" }),
    );
    expect(route).toBe("1");
  });

  it("rejects a choice label that disagrees with the distribution argmax (bridge policy)", () => {
    expect(() =>
      resolveRoute(
        { type: "choice", choice: "B", probabilities: { A: 0.83, B: 0.17 }, confidence: 0.9 },
        policy(),
      ),
    ).toThrow(/unique strict argmax/);
  });

  it("rejects a tie", () => {
    expect(() =>
      resolveRoute(
        { type: "choice", choice: "A", probabilities: { A: 0.5, B: 0.5 }, confidence: 0.9 },
        policy(),
      ),
    ).toThrow(/unique strict argmax/);
  });

  it("rejects a missing confidence required by --min-confidence", () => {
    expect(() =>
      resolveRoute({ type: "choice", choice: "A", probabilities: { A: 0.83, B: 0.17 } }, policy()),
    ).toThrow(/missing a finite confidence/);
  });

  it("rejects a confidence below the floor", () => {
    expect(() => resolveRoute(acceptedChoice(), policy({ minConfidence: 0.9 }))).toThrow(
      /below --min-confidence/,
    );
  });

  it("rejects a margin below the floor", () => {
    expect(() =>
      resolveRoute(
        { type: "choice", choice: "A", probabilities: { A: 0.52, B: 0.48 }, confidence: 0.9 },
        policy({ minConfidence: undefined, minMargin: 0.2 }),
      ),
    ).toThrow(/below --min-margin/);
  });

  it("rejects a probability outside [0, 1]", () => {
    expect(() =>
      resolveRoute(
        { type: "choice", choice: "A", probabilities: { A: 1.4, B: 0.1 }, confidence: 0.9 },
        policy(),
      ),
    ).toThrow(/finite number in \[0, 1\]/);
  });

  it("rejects an answer whose type does not match the declared question", () => {
    expect(() => resolveRoute({ type: "boolean", probabilityTrue: 0.9 }, policy())).toThrow(
      /does not match the declared question type/,
    );
  });

  it("rejects a missing answer", () => {
    expect(() => resolveRoute(undefined, policy())).toThrow(/returned no answer/);
  });

  it("rejects an unknown question id", () => {
    expect(() => resolveRoute(acceptedChoice(), policy({ question: "missing" }))).toThrow(
      /unknown decision question/,
    );
  });

  it("rejects a boolean in the ambiguous middle band", () => {
    expect(() =>
      resolveRoute(
        { type: "boolean", probabilityTrue: 0.7 },
        policy({
          questions: { route: booleanQuestion },
          minConfidence: undefined,
          minProbability: 0.8,
        }),
      ),
    ).toThrow(/ambiguous/);
  });

  it("rejects a boolean without the required --min-probability", () => {
    expect(() =>
      resolveRoute(
        { type: "boolean", probabilityTrue: 0.9 },
        policy({ questions: { route: booleanQuestion } }),
      ),
    ).toThrow(/require --min-probability/);
  });

  it("rejects a --min-confidence on a boolean question it can never honour", () => {
    expect(() =>
      resolveRoute(
        { type: "boolean", probabilityTrue: 0.95 },
        policy({
          questions: { route: booleanQuestion },
          minConfidence: 1,
          minProbability: 0.9,
        }),
      ),
    ).toThrow(/--min-confidence is not supported for a boolean question/);
  });

  it("rejects a --min-margin on a boolean question it can never honour", () => {
    expect(() =>
      resolveRoute(
        { type: "boolean", probabilityTrue: 0.8 },
        policy({
          questions: { route: booleanQuestion },
          minConfidence: undefined,
          minProbability: 0.8,
          minMargin: 0.9,
        }),
      ),
    ).toThrow(/--min-margin is not supported for a boolean question/);
  });

  it("accepts the inclusive decimal false endpoint instead of calling it ambiguous", () => {
    // 1 - 0.9 is 0.09999999999999998 in binary floating point; the symmetric form keeps the
    // mathematically inclusive endpoint 0.1 routable.
    expect(
      resolveRoute(
        { type: "boolean", probabilityTrue: 0.1 },
        policy({
          questions: { route: booleanQuestion },
          minConfidence: undefined,
          minProbability: 0.9,
        }),
      ),
    ).toBe("false");
  });

  it("rejects a score whose probability count disagrees with the rubric", () => {
    expect(() =>
      resolveRoute(
        { type: "score", score: 1, probabilities: [0.5, 0.5], confidence: 0.9 },
        policy({ questions: { route: scoreQuestion } }),
      ),
    ).toThrow(/declares 3 criteria/);
  });

  it("rejects a score with no unique strict argmax", () => {
    expect(() =>
      resolveRoute(
        { type: "score", score: 0.5, probabilities: [0.5, 0.5, 0.5], confidence: 0.9 },
        policy({ questions: { route: scoreQuestion } }),
      ),
    ).toThrow(/unique strict argmax/);
  });
});

describe("rubricVersionFor", () => {
  it("is stable and independent of key insertion order", () => {
    const first = rubricVersionFor({ a: booleanQuestion, b: choiceQuestion });
    const second = rubricVersionFor({ b: choiceQuestion, a: booleanQuestion });
    expect(first).toBe(second);
    expect(first).toMatch(/^lobster-bridge-v1-[0-9a-f]{24}$/);
  });

  it("changes when the rubric changes", () => {
    expect(rubricVersionFor({ a: booleanQuestion })).not.toBe(
      rubricVersionFor({ a: choiceQuestion }),
    );
  });
});

describe("createLobsterRegistry", () => {
  const options = {
    evaluate: (async () => ok({})) as DecisionEvaluator,
    agentId: "main",
    purpose: "test",
  };

  it("adds decision.evaluate to list() and get() without mutating the base", () => {
    const base = baseRegistry();
    const wrapped = createLobsterRegistry(base, options);
    expect(wrapped.list()).toEqual(["decision.evaluate", "exec", "head", "json"]);
    expect(wrapped.get(DECISION_COMMAND_NAME)?.name).toBe(DECISION_COMMAND_NAME);
    expect(wrapped.get("exec")?.name).toBe("exec");
    expect(base.list()).toEqual(["exec", "json", "head"]);
    expect(base.get(DECISION_COMMAND_NAME)).toBeUndefined();
  });
});

describe("createDecisionEvaluateCommand", () => {
  function harness(evaluate: DecisionEvaluator, agentId = "main") {
    const command = createDecisionEvaluateCommand({ evaluate, agentId, purpose: "test" });
    return command;
  }

  it("emits exactly one branchable item and calls the host with the bound identity", async () => {
    const evaluate = vi.fn<DecisionEvaluator>(async () => ok({ route: acceptedChoice() }));
    const command = harness(evaluate);
    const result = await command.run({
      input: noInput(),
      args: {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": JSON.stringify({ evidence: "x" }),
        "min-confidence": "0.5",
      },
      ctx: commandContext(),
    });
    const items = await collect(result!.output as AsyncIterable<unknown>);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: "ok",
      type: "choice",
      question: "route",
      route: "A",
    });
    expect(typeof (items[0] as { route: unknown }).route).toBe("string");
    const [batch, callOptions] = evaluate.mock.calls[0]!;
    expect(batch).toEqual({ state: { evidence: "x" }, questions: { route: choiceQuestion } });
    expect(callOptions).toMatchObject({
      agentId: "main",
      purpose: "test",
      timeoutMs: 30_000,
    });
    expect(callOptions.rubricVersion).toMatch(/^lobster-bridge-v1-/);
    expect(callOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("takes its state from the pipeline input when --state-json is absent", async () => {
    const evaluate = vi.fn<DecisionEvaluator>(async () => ok({ route: acceptedChoice() }));
    const command = harness(evaluate);
    async function* input() {
      yield { from: "pipeline" };
    }
    await command.run({
      input: input(),
      args: {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "min-confidence": "0.5",
      },
      ctx: commandContext(),
    });
    expect(evaluate.mock.calls[0]![0]).toEqual({
      state: { from: "pipeline" },
      questions: { route: choiceQuestion },
    });
  });

  it("fails closed when the host binding has no agent identity", async () => {
    const evaluate = vi.fn<DecisionEvaluator>(async () => ok({ route: acceptedChoice() }));
    const command = harness(evaluate, "");
    await expectRejection(
      command,
      {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
      },
      /requires a bound agent identity/,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed as a terminal halt when the decision layer is unavailable", async () => {
    const command = harness(async () => ({ status: "unavailable", reason: "transport" }));
    await expectRejection(
      command,
      {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
      },
      /unavailable: transport/,
    );
  });

  it("halts terminally on an evaluator rejection instead of picking a route", async () => {
    const command = harness(async () => {
      throw new Error("socket closed");
    });
    await expectRejection(
      command,
      {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
      },
      /socket closed/,
    );
  });

  it("bounds the rejection reason so an unbounded error cannot reach a sized sink", async () => {
    const command = harness(async () => {
      throw new Error("x".repeat(4000));
    });
    const result = await command.run({
      input: noInput(),
      args: {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
      },
      ctx: commandContext(),
    });
    expect(result?.halt).toBe(true);
    const items = await collect(result!.output as AsyncIterable<unknown>);
    const item = items[0] as { reason: string; [key: string]: unknown };
    expect(item.reason.length).toBeLessThanOrEqual(MAX_REJECTION_REASON_CHARS);
    expect(item[DECISION_REJECTION_MARKER]).toBe(true);
  });

  it("rethrows instead of halting when the run was cancelled, so cancellation survives", async () => {
    const controller = new AbortController();
    const command = harness(async () => {
      controller.abort(new Error("cancelled"));
      throw new Error("aborted");
    });
    await expect(
      command.run({
        input: noInput(),
        args: {
          "questions-json": JSON.stringify({ route: choiceQuestion }),
          "state-json": "{}",
          "min-confidence": "0.5",
        },
        ctx: commandContext(controller.signal),
      }),
    ).rejects.toThrow(/aborted/);
  });

  it("requires an explicit question when the rubric has more than one entry", async () => {
    const command = harness(async () => ok({}));
    await expectRejection(
      command,
      {
        "questions-json": JSON.stringify({ a: choiceQuestion, b: booleanQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
      },
      /--question is required/,
    );
  });

  it("rejects an unknown --question id", async () => {
    const command = harness(async () => ok({}));
    await expectRejection(
      command,
      {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
        question: "other",
      },
      /unknown --question/,
    );
  });

  it("requires state when neither --state-json nor input is present", async () => {
    const command = harness(async () => ok({}));
    await expectRejection(
      command,
      {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "min-confidence": "0.5",
      },
      /requires state/,
    );
  });

  it("bounds --timeout-ms to the configured maximum", async () => {
    const evaluate = vi.fn<DecisionEvaluator>(async () => ok({ route: acceptedChoice() }));
    const command = createDecisionEvaluateCommand({
      evaluate,
      agentId: "main",
      purpose: "test",
      maxTimeoutMs: 5_000,
    });
    await command.run({
      input: noInput(),
      args: {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
        "timeout-ms": "999999",
      },
      ctx: commandContext(),
    });
    expect(evaluate.mock.calls[0]![1]).toMatchObject({ timeoutMs: 5_000 });
  });

  it("never exceeds the configured maximum when --timeout-ms is omitted", async () => {
    const evaluate = vi.fn<DecisionEvaluator>(async () => ok({ route: acceptedChoice() }));
    const command = createDecisionEvaluateCommand({
      evaluate,
      agentId: "main",
      purpose: "test",
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 5_000,
    });
    await command.run({
      input: noInput(),
      args: {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
      },
      ctx: commandContext(),
    });
    expect(evaluate.mock.calls[0]![1]).toMatchObject({ timeoutMs: 5_000 });
  });

  it("never sends the host an invalid zero timeout for a fractional flag", async () => {
    const evaluate = vi.fn<DecisionEvaluator>(async () => ok({ route: acceptedChoice() }));
    const command = harness(evaluate);
    await command.run({
      input: noInput(),
      args: {
        "questions-json": JSON.stringify({ route: choiceQuestion }),
        "state-json": "{}",
        "min-confidence": "0.5",
        "timeout-ms": "0.5",
      },
      ctx: commandContext(),
    });
    const timeoutMs = evaluate.mock.calls[0]![1].timeoutMs;
    expect(Number.isFinite(timeoutMs)).toBe(true);
    expect(timeoutMs).toBeGreaterThanOrEqual(1);
  });
});
