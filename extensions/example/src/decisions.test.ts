import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { afterEach, expect, it, vi } from "vitest";
import { createDecisionProvider } from "./decisions.js";

const batch: DecisionBatch = { state: "synthetic state", questions: { b: { type: "boolean" } } };
const READY = { baseUrl: "http://127.0.0.1:8011", timeoutMs: 30000, maxTokens: 4096 };

function context() {
  return {
    model: "example/ds41-314113f8",
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 30000,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("is not ready without a configured baseUrl", () => {
  const provider = createDecisionProvider(() => ({ timeoutMs: 30000, maxTokens: 4096 }));
  expect(provider.id).toBe("example");
  expect(provider.contractVersion).toBe(1);
  expect(provider.isReady?.()).toBe(false);
});

it("is ready once a baseUrl is configured", () => {
  const provider = createDecisionProvider(() => READY);
  expect(provider.isReady?.()).toBe(true);
});

it("reports credentials-unavailable when evaluated without a baseUrl", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const provider = createDecisionProvider(() => ({ timeoutMs: 30000, maxTokens: 4096 }));
  await expect(provider.evaluate(batch, context())).resolves.toEqual({
    status: "unavailable",
    reason: "credentials-unavailable",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("returns unsupported-input for an unowned model without dispatching", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const provider = createDecisionProvider(() => READY);
  await expect(provider.evaluate(batch, { ...context(), model: "other/model" })).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("surfaces caller cancellation as a rejection, not an outcome", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller closed"));
  const provider = createDecisionProvider(() => READY);
  await expect(
    provider.evaluate(batch, { ...context(), signal: controller.signal }),
  ).rejects.toThrow("caller closed");
});
