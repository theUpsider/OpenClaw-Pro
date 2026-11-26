// Store-level coverage for the goal verification fields, loop cap, and attention marker.
import { describe, expect, it, vi } from "vitest";

// mock-isolation: F9 needs a failing goal-changed notice while the real store,
// marker write, and warning path stay in play. Only the goal store's own logger
// is redirected so the emitted warning is observable.
const goalChanged = vi.hoisted(() => ({ fail: false }));
const goalLog = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../sessions/session-state-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/session-state-events.js")>();
  return {
    ...actual,
    recordSessionGoalChanged: async (
      params: Parameters<typeof actual.recordSessionGoalChanged>[0],
    ) => {
      if (goalChanged.fail) {
        throw new Error("event store unavailable");
      }
      return await actual.recordSessionGoalChanged(params);
    },
  };
});
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "sessions/goal"
        ? { ...actual.createSubsystemLogger(subsystem), warn: goalLog.warn }
        : actual.createSubsystemLogger(subsystem),
  };
});

import { resolveSessionGoalRevision } from "./goals-transitions.js";
import {
  advanceSessionGoalContinuation,
  clearSessionGoalVerification,
  createSessionGoal,
  markSessionGoalAttention,
  recordSessionGoalVerification,
  updateSessionGoalStatus,
} from "./goals.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore as upsertAccessorSessionEntry,
} from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

const sessionKey = "agent:main:goal-verification";

describe("session goal verification store", () => {
  const fixture = useTempSessionsFixture("openclaw-goal-verification-");

  async function seed(entry: Partial<SessionEntry> = {}): Promise<void> {
    await upsertAccessorSessionEntry({ storePath: fixture.storePath(), sessionKey }, {
      sessionId: "sess-1",
      updatedAt: 1,
      totalTokens: 0,
      ...entry,
    } as SessionEntry);
  }

  function goal() {
    return loadSessionEntry({ storePath: fixture.storePath(), sessionKey })!.goal!;
  }

  it("captures the per-goal opt-in at creation only", async () => {
    await seed();
    const created = await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    expect(created.verifyCompletion).toBe(true);
    const plain = loadSessionEntry({ storePath: fixture.storePath(), sessionKey })!.goal!;
    expect(plain.continuationTurns).toBe(0);
    expect(plain.verification).toBeUndefined();
    expect(plain.attention).toBeUndefined();
  });

  it("omits the flag when creation did not opt in", async () => {
    await seed();
    const created = await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "plain goal",
      now: 10,
    });
    expect(created.verifyCompletion).toBeUndefined();
  });

  it("records a verdict for the current revision without moving it", async () => {
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const before = goal();
    const revision = resolveSessionGoalRevision(before);
    const result = await recordSessionGoalVerification({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: before.id,
      revision,
      verification: {
        outcome: "fail",
        checkedAt: 20,
        checkedRevision: revision,
        missingPoints: ["tests not run"],
        attempts: 1,
      },
      now: 20,
    });
    expect(result.recorded).toBe(true);
    const after = goal();
    expect(after.verification?.outcome).toBe("fail");
    expect(after.verification?.missingPoints).toEqual(["tests not run"]);
    // Bookkeeping must not invalidate the verdict it just recorded.
    expect(resolveSessionGoalRevision(after)).toBe(revision);
  });

  it("refuses to record a verdict for a revision that already moved", async () => {
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const result = await recordSessionGoalVerification({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      revision: "goal-1:1:0",
      verification: {
        outcome: "pass",
        checkedAt: 20,
        checkedRevision: "goal-1:1:0",
        missingPoints: [],
        attempts: 1,
      },
      now: 20,
    });
    expect(result.recorded).toBe(false);
    expect(goal().verification).toBeUndefined();
  });

  it("increments the continuation counter and reports the cap without writing", async () => {
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const opts = { storePath: fixture.storePath(), sessionKey, goalId: goal().id };
    expect((await advanceSessionGoalContinuation({ ...opts, maxTurns: 2 })).status).toBe(
      "advanced",
    );
    expect((await advanceSessionGoalContinuation({ ...opts, maxTurns: 2 })).status).toBe(
      "advanced",
    );
    const capped = await advanceSessionGoalContinuation({ ...opts, maxTurns: 2 });
    expect(capped.status).toBe("capped");
    expect(capped.attentionRecorded).toBe(true);
    expect(goal().continuationTurns).toBe(2);
    expect(goal().attention?.reason).toBe("continuation-budget");
    // The marker is written once; later callers see no new record.
    const again = await advanceSessionGoalContinuation({ ...opts, maxTurns: 2 });
    expect(again.status).toBe("capped");
    expect(again.attentionRecorded).toBe(false);
    // The goal itself stays active and incomplete.
    expect(goal().status).toBe("active");
  });

  it("moves the revision when real work follows a verdict", async () => {
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const before = resolveSessionGoalRevision(goal());
    const advanced = await advanceSessionGoalContinuation({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      maxTurns: 5,
    });
    expect(resolveSessionGoalRevision(goal())).not.toBe(before);
    // The advanced row is reported back so callers can bind a verdict to the
    // revision the queued turn actually runs at.
    expect(advanced.goal).toBeDefined();
    expect(resolveSessionGoalRevision(advanced.goal!)).toBe(resolveSessionGoalRevision(goal()));
  });

  it("marks attention once and only for an active goal", async () => {
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const first = await markSessionGoalAttention({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      reason: "verification-attempts",
      now: 30,
      summary: "goal automation stopped: verification-attempts",
    });
    expect(first.recorded).toBe(true);
    const second = await markSessionGoalAttention({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      reason: "verification-attempts",
      now: 31,
      summary: "goal automation stopped: verification-attempts",
    });
    expect(second.recorded).toBe(false);
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "paused",
      now: 40,
    });
    const paused = await markSessionGoalAttention({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      reason: "verification-attempts",
      now: 41,
      summary: "goal automation stopped: verification-attempts",
    });
    expect(paused.recorded).toBe(false);
  });

  it("clears the marker and budget on an explicit resume", async () => {
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    await advanceSessionGoalContinuation({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      maxTurns: 1,
    });
    // The cap is stamped on the call that finds the budget already spent.
    const capped = await advanceSessionGoalContinuation({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      maxTurns: 1,
    });
    expect(capped.status).toBe("capped");
    expect(goal().attention?.reason).toBe("continuation-budget");
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 50,
    });
    const resumed = goal();
    expect(resumed.continuationTurns).toBe(0);
    expect(resumed.attention).toBeUndefined();
    expect(resumed.status).toBe("active");
  });

  it("starts a fresh verification episode when an explicit resume clears a spent attempt budget", async () => {
    // F7: keeping `verification.attempts` across a resume made the next decision
    // stop immediately, so a resumed goal could never be verified again.
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const revision = resolveSessionGoalRevision(goal());
    await recordSessionGoalVerification({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      revision,
      verification: {
        outcome: "unverified",
        checkedAt: 20,
        checkedRevision: revision,
        missingPoints: [],
        error: "error",
        attempts: 6,
      },
      now: 20,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "blocked",
      now: 30,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 40,
    });
    expect(goal().verification).toBeUndefined();
  });

  it("does not carry a prior pass across a resume", async () => {
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const revision = resolveSessionGoalRevision(goal());
    await recordSessionGoalVerification({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      revision,
      verification: {
        outcome: "pass",
        checkedAt: 20,
        checkedRevision: revision,
        missingPoints: [],
        attempts: 1,
      },
      now: 20,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "paused",
      now: 30,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 40,
    });
    expect(goal().verification).toBeUndefined();
  });

  it("keeps a verdict when a resume does not actually change the status", async () => {
    // A no-op `active` write is not a resume and must not silently drop a verdict.
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const revision = resolveSessionGoalRevision(goal());
    await recordSessionGoalVerification({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: goal().id,
      revision,
      verification: {
        outcome: "pass",
        checkedAt: 20,
        checkedRevision: revision,
        missingPoints: [],
        attempts: 1,
      },
      now: 20,
    });
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "active",
      now: 30,
    });
    expect(goal().verification?.outcome).toBe("pass");
  });

  it("reports stale instead of queueing once the goal is no longer active", async () => {
    // F2 bounding: the pass handoff is a normal continuation, so it stops
    // existing as soon as the executor completes the goal during the handoff —
    // the loop cannot advance a goal that is no longer active.
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const goalId = goal().id;
    await updateSessionGoalStatus({
      storePath: fixture.storePath(),
      sessionKey,
      status: "complete",
      now: 20,
    });
    const advanced = await advanceSessionGoalContinuation({
      storePath: fixture.storePath(),
      sessionKey,
      goalId,
      maxTurns: 5,
    });
    // The store reports a non-advancing status (pre-existing stale/capped mapping);
    // either way the coordinator queues nothing for a goal that is no longer active.
    expect(advanced.status).not.toBe("advanced");
    expect(advanced.goal).toBeUndefined();
    expect(goal().continuationTurns).toBe(0);
    expect(goal().attention).toBeUndefined();
  });

  it("drops the stored verdict and attempt count when the store is asked to clear it", async () => {
    // F4 support: a user-originated turn ends the stretch of work the verdict
    // judged, and the drop must remove the verdict and its attempt count without
    // touching the pursuit itself.
    await seed();
    await createSessionGoal({
      storePath: fixture.storePath(),
      sessionKey,
      objective: "verified goal",
      verifyCompletion: true,
      now: 10,
    });
    const before = goal();
    const revision = resolveSessionGoalRevision(before);
    await recordSessionGoalVerification({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: before.id,
      revision,
      verification: {
        outcome: "pass",
        checkedAt: 20,
        checkedRevision: revision,
        missingPoints: [],
        attempts: 2,
      },
      now: 20,
    });
    const cleared = await clearSessionGoalVerification({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: before.id,
    });
    expect(cleared.cleared).toBe(true);
    const after = goal();
    expect(after.verification).toBeUndefined();
    expect(after.status).toBe("active");
    expect(resolveSessionGoalRevision(after)).toBe(resolveSessionGoalRevision(before));
    // Nothing left to drop: a second call reports that it changed nothing.
    const again = await clearSessionGoalVerification({
      storePath: fixture.storePath(),
      sessionKey,
      goalId: before.id,
    });
    expect(again.cleared).toBe(false);
  });

  it("records the attention marker even when the goal-changed notice fails", async () => {
    // F9: the marker is durable before the notice is attempted, so a failed
    // notice must not roll back goal state. Delivery failure stays observable
    // through the warning the store emits instead of being swallowed.
    goalLog.warn.mockClear();
    try {
      await seed();
      await createSessionGoal({
        storePath: fixture.storePath(),
        sessionKey,
        objective: "verified goal",
        verifyCompletion: true,
        now: 10,
      });
      goalChanged.fail = true;
      await expect(
        markSessionGoalAttention({
          storePath: fixture.storePath(),
          sessionKey,
          goalId: goal().id,
          reason: "continuation-budget",
          now: 30,
          summary: "goal automation stopped: continuation-budget",
        }),
      ).resolves.toEqual({ recorded: true });
      expect(goalLog.warn).toHaveBeenCalledWith(
        "goal attention notice could not be recorded",
        expect.objectContaining({ error: "event store unavailable" }),
      );
      // The swallowed notice failure must not change goal state either.
      expect(goal().attention?.reason).toBe("continuation-budget");
      expect(goal().status).toBe("active");
    } finally {
      goalChanged.fail = false;
    }
  });
});
