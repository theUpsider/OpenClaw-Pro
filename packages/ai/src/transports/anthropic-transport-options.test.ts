import { describe, expect, it } from "vitest";
import { buildAnthropicRequest } from "./anthropic-messages.js";
import {
  resolveAnthropicMessagesMaxTokens,
  resolveAnthropicTransportOptions,
} from "./anthropic-transport-options.js";
import { makeAnthropicTransportModel } from "./anthropic-transport-stream.test-support.js";

const API_KEY = "test-api-key";
const FABLE_5_MAX_TOKENS = 128_000;
const TRANSPORT_CLAMP_MAX_TOKENS = 32_000;

/** Fable 5 runs adaptive thinking on max_tokens, so the clamp starves the turn. */
function makeFable5Model() {
  return makeAnthropicTransportModel({
    id: "claude-fable-5-2",
    name: "Claude Fable 5",
    maxTokens: FABLE_5_MAX_TOKENS,
    contextWindow: 1_000_000,
  });
}

describe("resolveAnthropicMessagesMaxTokens", () => {
  it("clamps catalog caps above 32k unless the model default applies", () => {
    expect(
      resolveAnthropicMessagesMaxTokens({
        modelContextWindow: 1_000_000,
        modelMaxTokens: FABLE_5_MAX_TOKENS,
        requestedMaxTokens: undefined,
      }),
    ).toBe(TRANSPORT_CLAMP_MAX_TOKENS);
  });

  it("keeps the full catalog cap when the model default applies", () => {
    expect(
      resolveAnthropicMessagesMaxTokens({
        modelContextWindow: 1_000_000,
        modelMaxTokens: FABLE_5_MAX_TOKENS,
        requestedMaxTokens: undefined,
        useModelDefault: true,
      }),
    ).toBe(FABLE_5_MAX_TOKENS);
  });
});

describe("resolveAnthropicTransportOptions output cap", () => {
  it("keeps the full catalog output cap for Claude Fable 5", () => {
    const resolved = resolveAnthropicTransportOptions(makeFable5Model(), undefined, API_KEY);

    expect(resolved.maxTokens).toBe(FABLE_5_MAX_TOKENS);
  });

  it("still clamps models without the model-default exception", () => {
    const model = makeAnthropicTransportModel({
      id: "claude-sonnet-4-6",
      maxTokens: FABLE_5_MAX_TOKENS,
    });

    const resolved = resolveAnthropicTransportOptions(model, undefined, API_KEY);

    expect(resolved.maxTokens).toBe(TRANSPORT_CLAMP_MAX_TOKENS);
  });

  it("keeps an explicit caller maxTokens ahead of the model default", () => {
    const resolved = resolveAnthropicTransportOptions(
      makeFable5Model(),
      { maxTokens: 50_000 },
      API_KEY,
    );

    expect(resolved.maxTokens).toBe(50_000);
  });
});

/**
 * The resolver above only proves the option. Pin the value that actually reaches the request, so a
 * future re-clamp between the two layers (or a fixture that stops being recognised) cannot stay green.
 */
describe("Anthropic Messages request max_tokens", () => {
  async function wireMaxTokens(id: string) {
    const model = makeAnthropicTransportModel({
      id,
      maxTokens: FABLE_5_MAX_TOKENS,
      contextWindow: 1_000_000,
    });
    const transportOptions = resolveAnthropicTransportOptions(model, undefined, API_KEY);
    const built = await buildAnthropicRequest(
      model,
      { messages: [{ role: "user", content: "hi" }] } as never,
      transportOptions,
      "transport",
      false,
      false,
      undefined,
    );
    return (built as unknown as { params: { max_tokens: number } }).params.max_tokens;
  }

  it("sends the full catalog cap for Claude Fable 5", async () => {
    expect(await wireMaxTokens("claude-fable-5-2")).toBe(FABLE_5_MAX_TOKENS);
  });

  it("lifts every Fable 5 id the catalog ships, not just the -5-2 ref", async () => {
    expect(await wireMaxTokens("claude-fable-5")).toBe(FABLE_5_MAX_TOKENS);
    expect(await wireMaxTokens("claude-fable-5-1")).toBe(FABLE_5_MAX_TOKENS);
  });

  it("does not lift an id the Fable 5 matcher must reject", async () => {
    expect(await wireMaxTokens("claude-fable-50")).toBe(TRANSPORT_CLAMP_MAX_TOKENS);
    expect(await wireMaxTokens("claude-sonnet-4-6")).toBe(TRANSPORT_CLAMP_MAX_TOKENS);
  });
});
