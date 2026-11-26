/**
 * Test: per-hook failure policy (fail-open vs fail-closed).
 *
 * Guards such as an outbound policy plugin must be able to fail closed: a
 * handler timeout has to deny the guarded operation instead of letting the
 * unguarded payload through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNormalizedPluginsConfig } from "./config-state.js";
import {
  HookFailureClosedError,
  resolveHookFailurePolicy,
  unwrapHookFailureClosedError,
  type HookFailurePolicy,
} from "./hook-failure-policy.js";
import type { PluginHookMessageSendingResult } from "./hook-message.types.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";
import { createPluginRecord } from "./status.test-helpers.js";

const demoChannelCtx = { channelId: "demo-channel" };
const outboundEvent = { to: "user-123", content: "guarded content" };

describe("resolveHookFailurePolicy", () => {
  it("lets operator config override the api.on registration policy", () => {
    expect(
      resolveHookFailurePolicy({
        hookName: "message_sending",
        registrationPolicy: "fail-open",
        policy: { failurePolicy: "fail-closed" },
      }),
    ).toBe("fail-closed");
    expect(
      resolveHookFailurePolicy({
        hookName: "message_sending",
        registrationPolicy: "fail-closed",
        policy: { failurePolicies: { message_sending: "fail-open" } },
      }),
    ).toBe("fail-open");
  });

  it("prefers the registration policy over the Gateway default", () => {
    expect(
      resolveHookFailurePolicy({
        hookName: "message_sending",
        registrationPolicy: "fail-closed",
        defaultPolicy: "fail-open",
      }),
    ).toBe("fail-closed");
  });

  it("prefers the per-hook operator override over the plugin default", () => {
    expect(
      resolveHookFailurePolicy({
        hookName: "message_sending",
        policy: { failurePolicy: "fail-open", failurePolicies: { message_sending: "fail-closed" } },
      }),
    ).toBe("fail-closed");
  });

  it("falls back to the Gateway default and then to fail-open", () => {
    expect(
      resolveHookFailurePolicy({ hookName: "before_agent_run", defaultPolicy: "fail-closed" }),
    ).toBe("fail-closed");
    expect(resolveHookFailurePolicy({ hookName: "message_sending" })).toBe("fail-open");
  });
});

describe("HookFailureClosedError", () => {
  it("unwraps through Error.cause chains and AggregateError members", () => {
    const leaf = new HookFailureClosedError({
      hookName: "message_sending",
      pluginId: "guard",
      message: "[hooks] message_sending handler from guard failed: guard gateway unreachable",
      cause: new Error("guard gateway unreachable"),
    });
    expect(unwrapHookFailureClosedError(leaf)).toBe(leaf);
    expect(unwrapHookFailureClosedError(new AggregateError([leaf]))?.pluginId).toBe("guard");
    expect(unwrapHookFailureClosedError(new Error("wrapper", { cause: leaf }))).toBe(leaf);
    expect(unwrapHookFailureClosedError(new Error("unrelated"))).toBeUndefined();
    expect(unwrapHookFailureClosedError(new Error("cycle", { cause: undefined }))).toBeUndefined();
  });
});

describe("message_sending failure policy", () => {
  it("keeps failing open by default so a hook outage cannot stall delivery", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const { runner } = createHookRunnerWithRegistry(
      [{ hookName: "message_sending", handler: () => Promise.reject(new Error("guard down")) }],
      { logger },
    );

    await expect(runner.runMessageSending(outboundEvent, demoChannelCtx)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("denies the send when a fail-closed delivery hook fails", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "message_sending",
        failurePolicy: "fail-closed",
        handler: () => Promise.reject(new Error("guard down")),
      },
    ]);

    await expect(runner.runMessageSending(outboundEvent, demoChannelCtx)).rejects.toBeInstanceOf(
      HookFailureClosedError,
    );
    await expect(runner.runMessageSending(outboundEvent, demoChannelCtx)).rejects.toThrow(
      "message_sending handler from test-plugin failed: guard down",
    );
  });

  it("denies the send when a fail-closed delivery hook times out", async () => {
    vi.useFakeTimers();
    try {
      const { runner } = createHookRunnerWithRegistry([
        {
          hookName: "message_sending",
          failurePolicy: "fail-closed",
          timeoutMs: 50,
          handler: () => new Promise<PluginHookMessageSendingResult>(() => {}),
        },
      ]);
      const asserted = expect(
        runner.runMessageSending(outboundEvent, demoChannelCtx),
      ).rejects.toBeInstanceOf(HookFailureClosedError);
      await vi.advanceTimersByTimeAsync(60);
      await asserted;
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets later handlers run when the failing handler stays fail-open", async () => {
    const deferred = createDeferred<PluginHookMessageSendingResult>();
    const later = vi.fn(() => ({ cancel: true }) as never);
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "message_sending", priority: 10, handler: () => deferred.promise },
      { hookName: "message_sending", priority: 5, handler: later },
    ]);

    const run = runner.runMessageSending(outboundEvent, demoChannelCtx);
    deferred.reject(new Error("first handler failed"));
    await expect(run).resolves.toEqual({ cancel: true });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("does not let a fail-closed hook failure be swallowed for reply_payload_sending", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "reply_payload_sending",
        failurePolicy: "fail-closed",
        handler: () => {
          throw new Error("guard down");
        },
      },
    ]);

    await expect(
      runner.runReplyPayloadSending(
        { payload: { text: "guarded" }, kind: "final" },
        { channelId: "demo-channel" },
      ),
    ).rejects.toBeInstanceOf(HookFailureClosedError);
  });
});

describe("failure policy through plugin registration", () => {
  afterEach(() => {
    resetGlobalHookRunner();
  });

  // Real path: config normalization -> api.on -> registrar -> Gateway hook runner.
  function registerThrowingHook(params: {
    hookName: "message_sending" | "before_tool_call" | "before_install" | "before_agent_run";
    plugins?: OpenClawConfig["plugins"];
    failurePolicy?: HookFailurePolicy;
  }) {
    const runtime = createPluginRuntime();
    runtime.config.current = () => ({});
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
    });
    const record = createPluginRecord({ id: "guard", origin: "bundled" });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, {
      config: {},
      hookPolicy: createNormalizedPluginsConfig(params.plugins).entries.guard?.hooks,
    });
    api.on(
      params.hookName,
      () => {
        throw new Error("guard backend unreachable");
      },
      params.failurePolicy ? { failurePolicy: params.failurePolicy } : undefined,
    );
    initializeGlobalHookRunner(builder.registry);
    const runner = getGlobalHookRunner();
    if (!runner) {
      throw new Error("expected the global hook runner");
    }
    return { registration: builder.registry.typedHooks.at(-1), runner };
  }

  it("keeps Gateway fail-closed hooks fail-closed when nothing is configured", async () => {
    const toolCall = registerThrowingHook({ hookName: "before_tool_call" });
    expect(toolCall.registration).not.toHaveProperty("failurePolicy");
    await expect(
      toolCall.runner.runBeforeToolCall(
        { toolName: "bash", params: { command: "safe" } },
        { toolName: "bash", agentId: "main", sessionKey: "agent:main:main" },
      ),
    ).rejects.toBeInstanceOf(HookFailureClosedError);

    const install = registerThrowingHook({ hookName: "before_install" });
    expect(install.registration).not.toHaveProperty("failurePolicy");
    await expect(
      install.runner.runBeforeInstall(
        {
          targetName: "demo-skill",
          targetType: "skill",
          sourcePath: "/tmp/demo-skill",
          sourcePathKind: "directory",
          origin: "openclaw-workspace",
          request: { kind: "skill-install", mode: "install" },
          builtinScan: {
            status: "ok",
            scannedFiles: 1,
            critical: 0,
            warn: 0,
            info: 0,
            findings: [],
          },
          skill: { installId: "deps" },
        },
        { origin: "openclaw-workspace", targetType: "skill", requestKind: "skill-install" },
      ),
    ).rejects.toBeInstanceOf(HookFailureClosedError);

    const agentRun = registerThrowingHook({ hookName: "before_agent_run" });
    expect(agentRun.registration).not.toHaveProperty("failurePolicy");
    await expect(
      agentRun.runner.runBeforeAgentRun(
        { prompt: "hello", messages: [] },
        { runId: "run-1", agentId: "main", sessionKey: "agent:main:main", sessionId: "sid-1" },
      ),
    ).rejects.toBeInstanceOf(HookFailureClosedError);
  });

  it("lets operator config override the plugin's api.on policy", async () => {
    const { registration, runner } = registerThrowingHook({
      hookName: "message_sending",
      failurePolicy: "fail-open",
      plugins: {
        entries: { guard: { hooks: { failurePolicies: { message_sending: "fail-closed" } } } },
      },
    });
    expect(registration?.failurePolicy).toBe("fail-closed");
    await expect(runner.runMessageSending(outboundEvent, demoChannelCtx)).rejects.toBeInstanceOf(
      HookFailureClosedError,
    );
  });

  it("feeds the plugin-level config default into the registration", async () => {
    const { registration, runner } = registerThrowingHook({
      hookName: "message_sending",
      plugins: { entries: { guard: { hooks: { failurePolicy: "fail-closed" } } } },
    });
    expect(registration?.failurePolicy).toBe("fail-closed");
    await expect(runner.runMessageSending(outboundEvent, demoChannelCtx)).rejects.toBeInstanceOf(
      HookFailureClosedError,
    );
  });

  it("keeps the plugin's own api.on policy when the operator sets none", async () => {
    const { registration, runner } = registerThrowingHook({
      hookName: "message_sending",
      failurePolicy: "fail-closed",
    });
    expect(registration?.failurePolicy).toBe("fail-closed");
    await expect(runner.runMessageSending(outboundEvent, demoChannelCtx)).rejects.toBeInstanceOf(
      HookFailureClosedError,
    );
  });
});
