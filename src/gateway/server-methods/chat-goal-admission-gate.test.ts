import { describe, expect, it, vi } from "vitest";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import {
  goalAdmissionGateError,
  goalAdmissionRefusalError,
  respondGoalAdmissionRefusal,
} from "./chat-goal-admission-gate.js";

describe("chat goal admission gate", () => {
  it("returns the typed, honest refusal for the admission-hook case", () => {
    const error = goalAdmissionGateError();
    expect(error).toBeInstanceOf(SessionGoalOperationError);
    expect(error.code).toBe("admission-gate");
    expect(error.message).toContain("active execution hook");
    expect(error.message).not.toContain("native Codex");
  });

  it("keeps the historical runtime refusal for every other refusal", () => {
    const error = goalAdmissionRefusalError();
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
    expect(respondGoalAdmissionRefusal(goalAdmissionRefusalError(), respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
});
