import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveEmbeddedRun } from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { resetDiagnosticRunActivityForTest } from "../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { createPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { createPluginRecord } from "./status.test-helpers.js";

const sessionKey = "agent:main:advisor-steer-prep-test";
const sessionId = "advisor-steer-prep-session";

function createApi() {
  const runtime = createPluginRuntime();
  runtime.config.current = () => ({});
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
  });
  const record = createPluginRecord({ id: "advisor", origin: "bundled" });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, hookPolicy: { allowPromptInjection: true } });
  setActivePluginRegistry(builder.registry);
  return { api };
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticSessionStateForTest();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

describe("plugin active-run steering uses the prepared injection path", () => {
  it("takes queueMessageAsync and never the deprecated ReplyBackendMessageInjectionV2.queueMessage", async () => {
    const { api } = createApi();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const queueMessage = vi.fn(async () => {});
    const queueMessageAsync = vi.fn(async () => {});
    setActiveEmbeddedRun(
      sessionId,
      {
        ...createEmbeddedRunHandle({ runId: "prepared-run" }),
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage,
          queueMessageAsync,
        },
      },
      sessionKey,
    );

    await expect(
      api.session.workflow.steerActiveRun({ sessionKey, text: "Check the current result." }),
    ).resolves.toEqual({ steered: true, runId: "prepared-run" });

    expect(queueMessageAsync).toHaveBeenCalledOnce();
    expect(queueMessage).not.toHaveBeenCalled();
    const messages = warning.mock.calls.map(([message]) => String(message));
    assert(
      !messages.some((message) => message.includes("ReplyBackendMessageInjectionV2.queueMessage")),
      `no deprecated injection warning expected, saw: ${messages.join(" | ")}`,
    );
  });
});
