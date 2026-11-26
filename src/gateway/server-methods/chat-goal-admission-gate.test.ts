import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  goalAdmissionGateError,
  goalAdmissionRefusalError,
  hasUnsafeChatAdmissionHook,
  respondGoalAdmissionRefusal,
} from "./chat-goal-admission-gate.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("chat goal admission gate", () => {
  it("reports no unsafe hook without a registered admission hook", () => {
    initializeGlobalHookRunner(createMockPluginRegistry([]));
    expect(hasUnsafeChatAdmissionHook("agent:main:main")).toBe(false);
  });

  it("reports the deployment-wide execution gate as unsafe", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: vi.fn() }]),
    );
    expect(hasUnsafeChatAdmissionHook("agent:main:main")).toBe(true);
  });

  it("returns the typed, honest refusal when an admission hook is active", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: vi.fn() }]),
    );
    const error = goalAdmissionRefusalError("agent:main:main");
    expect(error).toBeInstanceOf(SessionGoalOperationError);
    expect((error as SessionGoalOperationError).code).toBe("admission-gate");
    expect(error.message).toContain("active execution hook");
    expect(error.message).not.toContain("native Codex");
  });

  it("keeps the historical runtime refusal when no admission hook is active", () => {
    initializeGlobalHookRunner(createMockPluginRegistry([]));
    const error = goalAdmissionRefusalError("agent:main:main");
    expect(error).not.toBeInstanceOf(SessionGoalOperationError);
    expect(error.message).toContain("recoverable history");
  });

  it("shapes the typed refusal as GOAL_OPERATION_REJECTED with its reason", () => {
    const respond = vi.fn();
    expect(respondGoalAdmissionRefusal(goalAdmissionGateError(), respond)).toBe(true);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: { code: "GOAL_OPERATION_REJECTED", reason: "admission-gate" },
      }),
    );
  });

  it("ignores non-Goal errors", () => {
    const respond = vi.fn();
    expect(respondGoalAdmissionRefusal(new Error("unrelated"), respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
});
