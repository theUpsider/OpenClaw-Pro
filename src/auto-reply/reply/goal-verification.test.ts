import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../config/zod-schema.agent-defaults-base.js";
import type { evaluateDecisionInRegistry } from "../../decisions/runtime.js";
import type { DecisionOutcome } from "../../decisions/types.js";
import {
  evaluateGoalClaimPrefilter,
  extractCompletionClaim,
  GOAL_CLAIM_QUESTION_ID,
  GOAL_CLAIM_THRESHOLD,
  isSameVerifierRoute,
  MAX_VERIFIER_OBJECTIVE_CHARS,
  parseGoalVerifierOutput,
  runGoalVerifier,
} from "./goal-verification.js";

const mocks = vi.hoisted(() => ({
  evaluate: vi.fn<typeof evaluateDecisionInRegistry>(),
}));
vi.mock("../../decisions/runtime.js", () => ({ evaluateDecisionInRegistry: mocks.evaluate }));
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: () => null,
}));

const isolated = vi.hoisted(() => ({
  runIsolatedCompletion: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));
vi.mock("../../transcripts/summary-model.runtime.js", () => ({
  runIsolatedCompletion: isolated.runIsolatedCompletion,
  resolveSimpleCompletionSelectionForAgent: isolated.resolveSimpleCompletionSelectionForAgent,
}));

const config: OpenClawConfig = {
  agents: {
    defaults: AgentDefaultsBaseSchema.parse({
      model: "test/executor-model",
      experimental: { decisionAssistance: true, goalCompletionVerification: true },
      decisionModel: "fixture/decision",
    }),
  },
};

const bool = (probabilityTrue: number) => ({ type: "boolean", probabilityTrue });
const outcomeFor = (answer: unknown): DecisionOutcome =>
  ({
    status: "ok",
    provenance: { providerId: "fixture", rubricVersion: "1", runtimeGeneration: "test" },
    result: { model: "model", answers: { [GOAL_CLAIM_QUESTION_ID]: answer } },
  }) as DecisionOutcome;

beforeEach(() => {
  setRuntimeConfigSnapshot(config);
  mocks.evaluate.mockReset().mockResolvedValue(outcomeFor(bool(1)));
  isolated.runIsolatedCompletion.mockReset().mockResolvedValue({
    text: JSON.stringify({
      outcome: "pass",
      missingPoints: [],
      evidence: ["built the thing"],
      risks: [],
    }),
    provider: "verifier",
    model: "verifier-model",
  });
  isolated.resolveSimpleCompletionSelectionForAgent.mockReset().mockReturnValue({
    provider: "verifier",
    modelId: "verifier-model",
    agentDir: "/tmp/verifier",
  });
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("goal completion claim extraction", () => {
  it("returns a trimmed claim and refuses empty text", () => {
    expect(extractCompletionClaim("  done, everything shipped  ")).toBe("done, everything shipped");
    expect(extractCompletionClaim("   ")).toBeUndefined();
    expect(extractCompletionClaim(undefined)).toBeUndefined();
  });
  it("bounds the claim length", () => {
    const claim = extractCompletionClaim("x".repeat(50_000));
    expect(claim!.length).toBeLessThanOrEqual(6_000);
  });
});

describe("goal claim pre-filter", () => {
  it("reports a below-threshold claim without running the verifier", async () => {
    mocks.evaluate.mockResolvedValue(outcomeFor(bool(0.1)));
    const result = await evaluateGoalClaimPrefilter({
      cfg: config,
      agentId: "main",
      objective: "ship the fix",
      claim: "still working on it",
    });
    expect(result.claimsCompletion).toBe(false);
    expect(result.reason).toBe("below-threshold");
    expect(isolated.runIsolatedCompletion).not.toHaveBeenCalled();
  });
  it("reports an at-or-above-threshold claim", async () => {
    mocks.evaluate.mockResolvedValue(outcomeFor(bool(GOAL_CLAIM_THRESHOLD)));
    const result = await evaluateGoalClaimPrefilter({
      cfg: config,
      agentId: "main",
      objective: "ship the fix",
      claim: "shipped",
    });
    expect(result.claimsCompletion).toBe(true);
  });
  it.each([
    ["malformed answer", outcomeFor({ type: "boolean", probabilityTrue: Number.NaN })],
    ["unavailable provider", { status: "unavailable", reason: "disabled" } as DecisionOutcome],
  ])("stays undecided for %s instead of blocking", async (_label, outcome) => {
    mocks.evaluate.mockResolvedValue(outcome);
    const result = await evaluateGoalClaimPrefilter({
      cfg: config,
      agentId: "main",
      objective: "ship the fix",
      claim: "shipped",
    });
    expect(result.claimsCompletion).toBeUndefined();
    expect(result.reason).not.toBe("");
  });
});

describe("goal verifier output parsing", () => {
  it("accepts the documented shape", () => {
    expect(
      parseGoalVerifierOutput(
        JSON.stringify({
          outcome: "fail",
          missingPoints: ["tests not run"],
          evidence: [],
          risks: [],
        }),
      ),
    ).toEqual({ outcome: "fail", missingPoints: ["tests not run"], evidence: [], risks: [] });
  });
  it.each([
    ["prose without JSON", "The objective looks complete to me."],
    ["invalid JSON", '{"outcome": '],
    ["undeclared outcome", JSON.stringify({ outcome: "maybe", missingPoints: [] })],
    ["array instead of object", JSON.stringify(["pass"])],
    ["missing outcome", JSON.stringify({ missingPoints: [] })],
    // F1: a bare outcome is not a pass; every documented field must validate.
    ["outcome only", JSON.stringify({ outcome: "pass" })],
    [
      "wrongly typed list field",
      JSON.stringify({ outcome: "pass", missingPoints: "x", evidence: [], risks: [] }),
    ],
    [
      "non-string list entry",
      JSON.stringify({ outcome: "pass", missingPoints: [1], evidence: [], risks: [] }),
    ],
    [
      "missing one list field",
      JSON.stringify({ outcome: "pass", missingPoints: [], evidence: [] }),
    ],
    [
      "prose around the object",
      `Sure! Here is the verdict: ${JSON.stringify({ outcome: "pass", missingPoints: [], evidence: [], risks: [] })}`,
    ],
  ])("rejects %s", (_label, text) => {
    expect(parseGoalVerifierOutput(text)).toBeUndefined();
  });
  it("accepts the documented shape wrapped in a single code fence", () => {
    expect(
      parseGoalVerifierOutput(
        [
          "```json",
          JSON.stringify({ outcome: "pass", missingPoints: [], evidence: [], risks: [] }),
          "```",
        ].join("\n"),
      ),
    ).toEqual({ outcome: "pass", missingPoints: [], evidence: [], risks: [] });
  });
  it("clips oversized lists and items", () => {
    const parsed = parseGoalVerifierOutput(
      JSON.stringify({
        outcome: "fail",
        missingPoints: Array.from({ length: 50 }, (_, index) => `gap ${index} ${"y".repeat(900)}`),
        evidence: [],
        risks: [],
      }),
    );
    expect(parsed!.missingPoints.length).toBeLessThanOrEqual(10);
    for (const point of parsed!.missingPoints) {
      expect(point.length).toBeLessThanOrEqual(400);
    }
  });
});

describe("verifier route separation", () => {
  it("detects a verifier that is the executing model", () => {
    expect(
      isSameVerifierRoute(
        { provider: "test", modelId: "executor-model" },
        { provider: "test", model: "executor-model" },
      ),
    ).toBe(true);
    expect(
      isSameVerifierRoute(
        { provider: "verifier", modelId: "verifier-model" },
        { provider: "test", model: "executor-model" },
      ),
    ).toBe(false);
  });
});

describe("goal verifier", () => {
  it("returns a passing verdict from a valid model answer", async () => {
    const verdict = await runGoalVerifier({
      cfg: config,
      agentId: "main",
      objective: "ship the fix",
      claim: "shipped",
      executor: { provider: "test", model: "executor-model" },
      settings: {},
    });
    expect(verdict.outcome).toBe("pass");
    const call = isolated.runIsolatedCompletion.mock.calls[0]![0];
    expect(call.systemPrompt).toContain("adversarial");
    expect(call.prompt).toContain("ship the fix");
    expect(call.prompt).toContain("shipped");
  });
  it("never lets the verifier be the executing model", async () => {
    isolated.resolveSimpleCompletionSelectionForAgent.mockReturnValue({
      provider: "test",
      modelId: "executor-model",
      agentDir: "/tmp/verifier",
    });
    const verdict = await runGoalVerifier({
      cfg: config,
      agentId: "main",
      objective: "ship the fix",
      claim: "shipped",
      executor: { provider: "test", model: "executor-model" },
      settings: {},
    });
    expect(verdict.outcome).toBe("unverified");
    expect(verdict.reason).toBe("verifier-is-executor");
    expect(isolated.runIsolatedCompletion).not.toHaveBeenCalled();
  });
  it("is unverified, never pass, for malformed output", async () => {
    isolated.runIsolatedCompletion.mockResolvedValue({
      text: "Sure! The objective is complete.",
      provider: "verifier",
      model: "verifier-model",
    });
    const verdict = await runGoalVerifier({
      cfg: config,
      agentId: "main",
      objective: "ship the fix",
      claim: "shipped",
      settings: {},
    });
    expect(verdict.outcome).toBe("unverified");
    expect(verdict.reason).toBe("malformed-output");
  });
  it("is unverified, never pass, when the call throws", async () => {
    isolated.runIsolatedCompletion.mockRejectedValue(new Error("provider down"));
    const verdict = await runGoalVerifier({
      cfg: config,
      agentId: "main",
      objective: "ship the fix",
      claim: "shipped",
      settings: {},
    });
    expect(verdict.outcome).toBe("unverified");
    expect(verdict.reason).toBe("error");
  });
  it("is unverified when no verifier model is configured", async () => {
    const verdict = await runGoalVerifier({
      cfg: { agents: { defaults: {} } } as OpenClawConfig,
      agentId: "main",
      objective: "ship the fix",
      claim: "shipped",
      settings: {},
    });
    expect(verdict.outcome).toBe("unverified");
    expect(verdict.reason).toBe("no-verifier-model");
  });
  it("honors an explicitly configured verifier model", async () => {
    await runGoalVerifier({
      cfg: config,
      agentId: "main",
      objective: "ship the fix",
      claim: "shipped",
      settings: { verifierModel: "explicit/verifier" },
    });
    expect(isolated.resolveSimpleCompletionSelectionForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modelRef: "explicit/verifier" }),
    );
  });
  it("is unverified, never a truncated pass, for an objective beyond the verifier bound", async () => {
    // F6: the objective is authoritative. Clipping it would let the verifier
    // judge a partial objective, so an over-long objective is not verified at
    // all rather than silently redefined.
    const verdict = await runGoalVerifier({
      cfg: config,
      agentId: "main",
      objective: `${"x".repeat(4_000)}-UNSEEN-CRITERION`,
      claim: "shipped",
      settings: {},
    });
    expect(verdict.outcome).toBe("unverified");
    expect(verdict.outcome).not.toBe("pass");
    expect(verdict.reason).toBe("objective-too-long");
    expect(isolated.runIsolatedCompletion).not.toHaveBeenCalled();
  });
  it("sends the objective verbatim when it fits the bound", async () => {
    const objective = `${"o".repeat(3_980)}-VERBATIM-END`;
    expect(objective.length).toBeLessThanOrEqual(MAX_VERIFIER_OBJECTIVE_CHARS);
    await runGoalVerifier({
      cfg: config,
      agentId: "main",
      objective,
      claim: "shipped",
      settings: {},
    });
    const call = isolated.runIsolatedCompletion.mock.calls[0]![0];
    expect(call.prompt).toContain("-VERBATIM-END");
    expect(call.prompt).not.toContain("objective truncated");
  });
  it("never throws to the caller when the tool graph cannot load", async () => {
    isolated.runIsolatedCompletion.mockImplementation(() => {
      throw new Error("graph exploded");
    });
    await expect(
      runGoalVerifier({
        cfg: config,
        agentId: "main",
        objective: "ship the fix",
        claim: "shipped",
        settings: {},
      }),
    ).resolves.toMatchObject({ outcome: "unverified" });
  });
});
