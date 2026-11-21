/**
 * Numeric reasoning-effort wire contract for OpenAI-compatible chat-template routes.
 *
 * `compat.numericReasoningEfforts` replaces the route's string effort mapping with JSON numbers
 * sent in `chat_template_kwargs.reasoning_effort`; the top-level `reasoning_effort` field must
 * disappear for those routes, and every other route keeps its previous byte-identical shape.
 */
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { resolveOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  buildOpenAICompletionsParams,
  buildOpenAICompletionsRequest,
} from "./openai-completions-params.js";
import { applyCompletionsReasoningAndRouting } from "./openai-completions-policy.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";
import { buildOpenAIResponsesParams } from "./openai-responses-params-internal.js";

// Mirrors the live `example`/`example-workers` ds41 rows: graded efforts plus the numeric map.
const DS41_NUMERIC_EFFORTS = { low: 40, medium: 50, high: 70, xhigh: 80, max: 100 };
const DS41_SUPPORTED_EFFORTS = ["low", "high", "xhigh", "max"];
const DS41_EFFORT_MAP = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  adaptive: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "max",
};

function ds41Model(
  overrides: Partial<Model<"openai-completions">> = {},
): Model<"openai-completions"> {
  return makeCompletionsModel({
    id: "ds41",
    name: "DeepSeek V4.1 Flash",
    provider: "example",
    baseUrl: "http://example-gpu.example.test:8001/v1",
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    compat: {
      supportedReasoningEfforts: DS41_SUPPORTED_EFFORTS,
      reasoningEffortMap: DS41_EFFORT_MAP,
      numericReasoningEfforts: DS41_NUMERIC_EFFORTS,
      supportsUsageInStreaming: true,
    },
    ...overrides,
  });
}

function emptyContext(): Context {
  return { systemPrompt: "system", messages: [], tools: [] };
}

function managedPayload(
  model: Model<"openai-completions">,
  options?: Parameters<typeof buildOpenAICompletionsParams>[2],
) {
  return buildOpenAICompletionsParams(model, emptyContext(), options);
}

function directPayload(
  model: Model<"openai-completions">,
  options?: Parameters<typeof buildOpenAICompletionsRequest>[2],
) {
  return buildOpenAICompletionsRequest(model, emptyContext(), options, {
    mode: "direct",
    compat: resolveOpenAICompletionsCompat(model),
    cacheRetention: "none",
  });
}

describe("numeric reasoning efforts", () => {
  it.each([
    ["low", 40],
    ["medium", 50],
    ["high", 70],
    ["xhigh", 80],
    ["max", 100],
  ] as const)(
    "sends the numeric effort for %s instead of the string mapping",
    (level, expected) => {
      const payload = managedPayload(ds41Model(), { reasoning: level });
      expect(payload.chat_template_kwargs).toMatchObject({
        thinking: true,
        reasoning_effort: expected,
      });
      expect(
        typeof (payload.chat_template_kwargs as Record<string, unknown>).reasoning_effort,
      ).toBe("number");
      // The route owns the wire shape through the numeric field: no top-level effort remains.
      expect(payload).not.toHaveProperty("reasoning_effort");
      expect(payload.chat_template_kwargs).not.toHaveProperty("enable_thinking");
    },
  );

  it('refuses the string mapping for a shared level (medium -> 50, not "high")', () => {
    const payload = managedPayload(ds41Model(), { reasoning: "medium" });
    expect((payload.chat_template_kwargs as Record<string, unknown>).reasoning_effort).toBe(50);
  });

  it("sends no effort for a level without a numeric entry", () => {
    const payload = managedPayload(ds41Model(), { reasoning: "minimal" });
    expect(payload.chat_template_kwargs).toMatchObject({ thinking: true });
    expect(payload.chat_template_kwargs).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("keeps off binary without any effort", () => {
    const payload = managedPayload(ds41Model(), { reasoning: "off" });
    expect(payload.chat_template_kwargs).toMatchObject({ thinking: false });
    expect(payload.chat_template_kwargs).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("sends no effort for off even when the numeric map declares an off entry", () => {
    // A legal config may carry an `off` number; the binary state still owns off, so no
    // numeric effort may ship (regression for the disabled-level guard on the numeric path).
    const model = ds41Model({
      compat: {
        supportedReasoningEfforts: DS41_SUPPORTED_EFFORTS,
        numericReasoningEfforts: { ...DS41_NUMERIC_EFFORTS, off: 1, none: 2 },
      },
    });
    for (const level of ["off", "none"] as const) {
      const payload = managedPayload(model, { reasoning: level });
      expect(payload.chat_template_kwargs, level).toMatchObject({ thinking: false });
      expect(payload.chat_template_kwargs, level).not.toHaveProperty("reasoning_effort");
      expect(payload, level).not.toHaveProperty("reasoning_effort");
    }
  });

  it("preserves unrelated chat_template_kwargs keys", () => {
    const model = ds41Model();
    const params: Record<string, unknown> = { chat_template_kwargs: { preserve_thinking: true } };
    applyCompletionsReasoningAndRouting(
      params,
      model as never,
      { effort: undefined, thinkingEnabled: true, numericEffort: 70, thinkingExplicit: true },
      resolveOpenAICompletionsCompat(model),
      "managed",
    );
    expect(params.chat_template_kwargs).toEqual({
      preserve_thinking: true,
      thinking: true,
      reasoning_effort: 70,
    });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("applies the same shape for the direct transport and drops a prior scalar effort", () => {
    const model = ds41Model();
    const params: Record<string, unknown> = { reasoning_effort: "high" };
    applyCompletionsReasoningAndRouting(
      params,
      model as never,
      { effort: undefined, thinkingEnabled: true, numericEffort: 80, thinkingExplicit: true },
      resolveOpenAICompletionsCompat(model),
      "direct",
    );
    expect(params.chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: 80 });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it.each([
    ["managed", managedPayload, { reasoning: "max" }],
    ["direct", directPayload, { reasoningEffort: "max" }],
  ] as const)("keeps the numeric wire shape over %s HTTP mode", (_mode, build, options) => {
    const model = ds41Model();
    const params = build(model, options as never);
    expect(params.chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: 100 });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("ignores the string map for the binary state when the numeric map owns the route", () => {
    // A leftover off/none string entry must not flip `thinking` against the logical level.
    const model = ds41Model({
      compat: {
        numericReasoningEfforts: { medium: 50 },
        reasoningEffortMap: { off: "low", medium: "off" },
      },
    });
    expect(managedPayload(model, { reasoning: "off" }).chat_template_kwargs).toEqual({
      thinking: false,
    });
    expect(managedPayload(model, { reasoning: "medium" }).chat_template_kwargs).toEqual({
      thinking: true,
      reasoning_effort: 50,
    });
  });

  it("drops a conflicting enable_thinking and a stale nested effort from a seeded payload", () => {
    // A caller may already carry a template control block; the numeric contract owns the shape.
    const model = ds41Model();
    const params: Record<string, unknown> = {
      reasoning_effort: "high",
      chat_template_kwargs: {
        enable_thinking: true,
        reasoning_effort: 70,
        preserve_thinking: true,
      },
    };
    applyCompletionsReasoningAndRouting(
      params,
      model as never,
      {
        effort: undefined,
        thinkingEnabled: false,
        numericEffort: undefined,
        thinkingExplicit: true,
      },
      resolveOpenAICompletionsCompat(model),
      "managed",
    );
    expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true, thinking: false });
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it.each([
    ["example", "http://example-gpu.example.test:8001/v1"],
    ["example-workers", "http://127.0.0.1:8011/v1"],
  ] as const)(
    "resolves every level numerically for the live-shaped %s row",
    (provider, baseUrl) => {
      const model = ds41Model({ provider, baseUrl });
      const expected = {
        off: undefined,
        minimal: undefined,
        low: 40,
        medium: 50,
        high: 70,
        xhigh: 80,
        max: 100,
      };
      for (const [level, effort] of Object.entries(expected)) {
        const payload = managedPayload(model, { reasoning: level as never });
        const kwargs = payload.chat_template_kwargs as Record<string, unknown>;
        expect(kwargs.thinking, level).toBe(level !== "off");
        expect(kwargs.reasoning_effort, level).toBe(effort);
        expect(payload, level).not.toHaveProperty("reasoning_effort");
      }
    },
  );
});

describe("turn over session precedence", () => {
  it.each([
    ["medium", 50],
    ["low", 40],
    ["xhigh", 80],
  ] as const)("lets a turn %s beat the session level", (turn, expected) => {
    // Session `high` is superseded by the turn's explicit effort, and the wire value is the winner.
    const payload = managedPayload(ds41Model(), { reasoning: "high", reasoningEffort: turn });
    expect(payload.chat_template_kwargs).toMatchObject({
      thinking: true,
      reasoning_effort: expected,
    });
  });

  it("lets a turn off beat the session level and send no effort", () => {
    const payload = managedPayload(ds41Model(), { reasoning: "high", reasoningEffort: "off" });
    expect(payload.chat_template_kwargs).toMatchObject({ thinking: false });
    expect(payload.chat_template_kwargs).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("uses the session level when the turn carries no override", () => {
    const payload = managedPayload(ds41Model(), { reasoning: "high" });
    expect(payload.chat_template_kwargs).toMatchObject({ thinking: true, reasoning_effort: 70 });
  });
});

describe("string-effort regression", () => {
  it("keeps the top-level reasoning_effort for a route without the numeric field", () => {
    const model = makeCompletionsModel({
      id: "gpt-5.6-sol",
      provider: "custom",
      baseUrl: "https://proxy.example.test/v1",
      reasoning: true,
      compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "high"] },
    });
    const payload = managedPayload(model, { reasoning: "high" });
    expect(payload.reasoning_effort).toBe("high");
    expect(payload).not.toHaveProperty("chat_template_kwargs");
  });

  it("leaves an openai-responses route untouched by the Completions numeric field", () => {
    // The field is a Completions contract; a Responses route that carries it must not lose effort.
    const model: Model<"openai-responses"> = {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high"],
        numericReasoningEfforts: { medium: 50 },
      },
    } as Model<"openai-responses">;
    const payload = buildOpenAIResponsesParams(model, emptyContext(), { reasoning: "high" });
    expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("keeps a declared qwen-chat-template route byte-identical", () => {
    const model = makeCompletionsModel({
      id: "qwen3.8-32b",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: true,
      compat: {
        thinkingFormat: "qwen-chat-template",
        supportedReasoningEfforts: ["low", "medium", "xhigh"],
        reasoningEffortMap: { high: "xhigh" },
      },
    });
    const payload = managedPayload(model, { reasoning: "high" });
    expect(structuredClone(payload).chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_effort: "xhigh",
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
