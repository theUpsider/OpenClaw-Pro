import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import {
  findRestartRecoveryUnsafeChatAdmissionHook,
  findRestartRecoveryUnsafeGoalAdmissionHook,
} from "./restart-recovery-hook-safety.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("findRestartRecoveryUnsafeChatAdmissionHook", () => {
  it("allows deferred before_agent_reply at initial durable chat admission", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler: vi.fn() },
        { hookName: "before_message_write", handler: vi.fn() },
      ]),
    );

    expect(findRestartRecoveryUnsafeChatAdmissionHook("agent")).toBe("before_message_write");
  });

  it("still treats a global before_agent_run gate as unsafe for ordinary chat", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: vi.fn() }]),
    );

    expect(findRestartRecoveryUnsafeChatAdmissionHook("agent")).toBe("before_agent_run");
  });
});

describe("findRestartRecoveryUnsafeGoalAdmissionHook", () => {
  it("does not refuse a Goal for a deployment-wide before_agent_run gate", () => {
    // Regression: host-wide execution gates (for example a document-scope guard)
    // register before_agent_run unconditionally. Treating it as unsafe refused
    // every Goal start and resume on such a host.
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: vi.fn() }]),
    );

    expect(findRestartRecoveryUnsafeGoalAdmissionHook("agent")).toBeUndefined();
  });

  it("refuses a Goal when a reply-claiming dispatch hook is unscoped", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "reply_dispatch", handler: vi.fn() }]),
    );

    expect(findRestartRecoveryUnsafeGoalAdmissionHook("agent")).toBe("reply_dispatch");
  });

  it("keeps a Goal admissible when only the ACP dispatch path is claimed", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "reply_dispatch", handler: vi.fn(), eligibleDispatchKinds: ["acp"] },
      ]),
    );

    expect(findRestartRecoveryUnsafeGoalAdmissionHook("agent")).toBeUndefined();
    expect(findRestartRecoveryUnsafeGoalAdmissionHook("acp")).toBe("reply_dispatch");
  });
  it("refuses a Goal when a transcript write gate is registered", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_message_write", handler: vi.fn() }]),
    );

    expect(findRestartRecoveryUnsafeGoalAdmissionHook("agent")).toBe("before_message_write");
  });
});
