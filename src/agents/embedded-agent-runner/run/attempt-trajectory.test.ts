import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";

const admissions: ReturnType<typeof prepareSystemAgentRunAdmission>[] = [];
afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
});

const hoisted = vi.hoisted(() => ({
  buildTrajectoryRunMetadata: vi.fn(() => ({ trace: "metadata" })),
  createTrajectoryRuntimeRecorder: vi.fn(),
  resolveAttemptTrajectorySessionFile: vi.fn(async () => "/tmp/trajectory.jsonl"),
}));

vi.mock("../../../trajectory/metadata.js", () => ({
  buildTrajectoryRunMetadata: hoisted.buildTrajectoryRunMetadata,
}));
// mock-isolation: Recorder persistence is outside the attempt metadata contract.
vi.mock("../../../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: hoisted.createTrajectoryRuntimeRecorder,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveAttemptTrajectorySessionFile: hoisted.resolveAttemptTrajectorySessionFile,
}));

import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";

async function createInput(
  disableTrajectory = false,
  abortSignal?: AbortSignal,
  options: {
    capabilityToolNames?: Iterable<string>;
    senderIsOwner?: boolean;
    wireToolNames?: Iterable<string>;
  } = {},
) {
  const admission = prepareSystemAgentRunAdmission({}, "run-1", "main", "trajectory-test");
  admissions.push(admission);
  const admittedRunContext = await admission.admit("embedded");
  return {
    activeSession: { sessionId: "session-1" },
    attempt: {
      config: {},
      admittedRunContext,
      abortSignal,
      disableTrajectory,
      fastMode: true,
      model: { api: "anthropic-messages" },
      modelId: "model-1",
      provider: "provider-1",
      runId: "run-1",
      senderIsOwner: options.senderIsOwner,
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:session-1",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: "/tmp/openclaw-agent.sqlite",
      },
      thinkLevel: "medium",
      trigger: "user",
      workspaceDir: "/tmp/workspace",
    },
    capabilityToolNames: options.capabilityToolNames ?? new Set(["read"]),
    wireToolNames: options.wireToolNames ?? new Set(["read"]),
    clientToolCount: 2,
    effectiveToolCount: 7,
    effectiveWorkspace: "/tmp/workspace",
    localModelLeanEnabled: false,
    sessionAgentId: "main",
  };
}

describe("prepareEmbeddedAttemptTrajectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "creates trajectory metadata with retained target: %s, senderIsOwner: %s",
    async (retained, senderIsOwner) => {
      const recorder = { recordEvent: vi.fn() };
      hoisted.createTrajectoryRuntimeRecorder.mockReturnValue(recorder);

      const input = await createInput(false, undefined, {
        // Deliberately non-sorted insertion order: the emitted array must be ascending.
        capabilityToolNames: new Set(["sessions_spawn", "exec", "read"]),
        wireToolNames: new Set(["write", "exec", "read"]),
        senderIsOwner,
      });
      const result = await prepareEmbeddedAttemptTrajectory({
        ...input,
        ...(retained
          ? {
              transcriptOwner: {
                sessionTarget: input.attempt.sessionTarget,
                assertCommitAllowed: resolveAdmittedRunActiveAssertion(
                  input.attempt.admittedRunContext,
                ),
              },
            }
          : {}),
      } as never);

      expect(result).toBe(recorder);
      if (retained) {
        expect(hoisted.resolveAttemptTrajectorySessionFile).not.toHaveBeenCalled();
      } else {
        expect(hoisted.resolveAttemptTrajectorySessionFile).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "main",
            sessionFile: "/tmp/session.jsonl",
            sessionId: "session-1",
          }),
        );
      }
      expect(hoisted.createTrajectoryRuntimeRecorder).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          sessionFile: retained ? input.attempt.sessionKey : "/tmp/trajectory.jsonl",
          sessionId: "session-1",
          sessionTarget: expect.objectContaining({
            agentId: "main",
            sessionId: "session-1",
            sessionKey: "agent:main:session-1",
            storePath: "/tmp/openclaw-agent.sqlite",
          }),
        }),
      );
      expect(recorder.recordEvent).toHaveBeenNthCalledWith(
        1,
        "session.started",
        expect.objectContaining({
          toolCount: 7,
          clientToolCount: 2,
          senderIsOwner,
          capabilityToolNames: ["exec", "read", "sessions_spawn"],
          capabilityToolNamesCount: 3,
          capabilityToolNamesHash: sha256Hex(JSON.stringify(["exec", "read", "sessions_spawn"])),
          wireToolNames: ["exec", "read", "write"],
          wireToolNamesCount: 3,
          wireToolNamesHash: sha256Hex(JSON.stringify(["exec", "read", "write"])),
        }),
      );
      expect(recorder.recordEvent).toHaveBeenNthCalledWith(2, "trace.metadata", {
        trace: "metadata",
      });
      expect(hoisted.buildTrajectoryRunMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ fastMode: true, provider: "provider-1" }),
      );
    },
  );

  it("keeps capabilityToolNames byte-identical across insertion orders", async () => {
    const emitCapabilityToolNames = async (capabilityToolNames: Iterable<string>) => {
      const recorder = { recordEvent: vi.fn() };
      hoisted.createTrajectoryRuntimeRecorder.mockReturnValue(recorder);
      await prepareEmbeddedAttemptTrajectory(
        (await createInput(false, undefined, { capabilityToolNames })) as never,
      );
      const started = recorder.recordEvent.mock.calls.find(([type]) => type === "session.started");
      if (!started) {
        throw new Error("expected session.started to be recorded");
      }
      return (started[1] as { capabilityToolNames: string[] }).capabilityToolNames;
    };

    const a = await emitCapabilityToolNames(new Set(["sessions_spawn", "exec", "read"]));
    const b = await emitCapabilityToolNames(new Set(["read", "sessions_spawn", "exec"]));

    // A missing field must not satisfy the stability claim: assert the array is real
    // and ascending before comparing two insertion orders against each other.
    expect(Array.isArray(a)).toBe(true);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual([...a].toSorted());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // A basis above the limiter's 64-item array cap is not merely shortened: the
  // limiter's `trajectory-array-size-limit` marker lands at index 64 and is then
  // dropped by the 64-key diagnostic projection, so the recorded array looks like
  // an ordinary 64-item list. The count and digest must still describe the
  // complete pre-truncation basis.
  it("describes a capability basis larger than the 64-item array limit", async () => {
    const names = Array.from({ length: 100 }, (_, index) => `tool_${index}`);
    const recorder = { recordEvent: vi.fn() };
    hoisted.createTrajectoryRuntimeRecorder.mockReturnValue(recorder);

    await prepareEmbeddedAttemptTrajectory(
      (await createInput(false, undefined, {
        capabilityToolNames: names,
      })) as never,
    );

    const started = recorder.recordEvent.mock.calls.find(([type]) => type === "session.started");
    if (!started) {
      throw new Error("expected session.started to be recorded");
    }
    const data = started[1] as {
      capabilityToolNames: string[];
      capabilityToolNamesCount: number;
      capabilityToolNamesHash: string;
    };
    const sorted = [...names].toSorted();
    expect(data.capabilityToolNamesCount).toBe(100);
    expect(data.capabilityToolNamesHash).toBe(sha256Hex(JSON.stringify(sorted)));
    expect(data.capabilityToolNamesHash).toMatch(/^[0-9a-f]{64}$/);
    // Distinct bases must not collide on the digest, including shapes that a
    // plain separator join would encode identically.
    expect(data.capabilityToolNamesHash).not.toBe(
      sha256Hex(JSON.stringify([...sorted.slice(0, 99), "different"])),
    );
    expect(sha256Hex(JSON.stringify(["z", "zz\nzzz"].toSorted()))).not.toBe(
      sha256Hex(JSON.stringify(["z\nzz", "zzz"].toSorted())),
    );
  });

  it("keeps wireToolNames byte-identical across insertion orders", async () => {
    const emitWireToolNames = async (wireToolNames: Iterable<string>) => {
      const recorder = { recordEvent: vi.fn() };
      hoisted.createTrajectoryRuntimeRecorder.mockReturnValue(recorder);
      await prepareEmbeddedAttemptTrajectory(
        (await createInput(false, undefined, { wireToolNames })) as never,
      );
      const started = recorder.recordEvent.mock.calls.find(([type]) => type === "session.started");
      if (!started) {
        throw new Error("expected session.started to be recorded");
      }
      return (started[1] as { wireToolNames: string[] }).wireToolNames;
    };

    const a = await emitWireToolNames(new Set(["write", "exec", "read"]));
    const b = await emitWireToolNames(new Set(["read", "write", "exec"]));

    expect(Array.isArray(a)).toBe(true);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual([...a].toSorted());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // The mocked recorder sees the payload BEFORE the runtime limiter runs, so an
  // array of 100 names still arrives with all 100 entries here. The 64-item cap
  // the event reader actually gets is proven against the real limiter in
  // src/trajectory/runtime.test.ts: "caps a 100-name wire surface at the 64-item
  // array limit while count and digest keep the full set".
  it("describes a wire surface larger than the 64-item array limit", async () => {
    const names = Array.from({ length: 100 }, (_value, index) => `tool_${index}`);
    const recorder = { recordEvent: vi.fn() };
    hoisted.createTrajectoryRuntimeRecorder.mockReturnValue(recorder);

    await prepareEmbeddedAttemptTrajectory(
      (await createInput(false, undefined, { wireToolNames: names })) as never,
    );

    const started = recorder.recordEvent.mock.calls.find(([type]) => type === "session.started");
    if (!started) {
      throw new Error("expected session.started to be recorded");
    }
    const data = started[1] as {
      wireToolNames: string[];
      wireToolNamesCount: number;
      wireToolNamesHash: string;
    };
    const sorted = [...names].toSorted();
    expect(data.wireToolNames).toHaveLength(100);
    expect(data.wireToolNamesCount).toBe(100);
    expect(data.wireToolNamesHash).toBe(sha256Hex(JSON.stringify(sorted)));
    expect(data.wireToolNamesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the wire digest JSON-framed and change-sensitive", async () => {
    const emitWireEvent = async (wireToolNames: Iterable<string>) => {
      const recorder = { recordEvent: vi.fn() };
      hoisted.createTrajectoryRuntimeRecorder.mockReturnValue(recorder);
      await prepareEmbeddedAttemptTrajectory(
        (await createInput(false, undefined, { wireToolNames })) as never,
      );
      const started = recorder.recordEvent.mock.calls.find(([type]) => type === "session.started");
      if (!started) {
        throw new Error("expected session.started to be recorded");
      }
      return started[1] as { wireToolNames: string[]; wireToolNamesHash: string };
    };

    // Two distinct bases a plain "\n" join would encode identically; the JSON
    // framing must keep them apart.
    const joined = ["z", "zz\nzzz"];
    const separated = ["z\nzz", "zzz"];
    expect(joined.join("\n")).toBe(separated.join("\n"));
    expect(sha256Hex(joined.join("\n"))).toBe(sha256Hex(separated.join("\n")));
    const a = await emitWireEvent(joined);
    const b = await emitWireEvent(separated);
    expect(a.wireToolNames).not.toEqual(b.wireToolNames);
    expect(a.wireToolNamesHash).not.toBe(b.wireToolNamesHash);

    // Negative control: mutating the wire set (one name added) changes the digest.
    const c = await emitWireEvent(["read", "exec"]);
    const d = await emitWireEvent(["read", "exec", "write"]);
    expect(c.wireToolNamesHash).not.toBe(d.wireToolNamesHash);
  });

  it.each(["revoke", "abort"])(
    "does not record prepared metadata after %s during sink preparation",
    async (change) => {
      const abort = new AbortController();
      const input = await createInput(false, abort.signal);
      const recorder = { recordEvent: vi.fn() };
      hoisted.createTrajectoryRuntimeRecorder.mockImplementation(async () => {
        if (change === "revoke") {
          closeAdmittedRunDelegatedAuthority(input.attempt.admittedRunContext);
        } else {
          abort.abort();
        }
        return recorder;
      });
      await expect(
        prepareEmbeddedAttemptTrajectory({
          ...input,
          transcriptOwner: {
            sessionTarget: input.attempt.sessionTarget,
            assertCommitAllowed: resolveAdmittedRunActiveAssertion(
              input.attempt.admittedRunContext,
            ),
          },
        } as never),
      ).rejects.toThrow("admitted run authority is no longer active");
      expect(recorder.recordEvent).not.toHaveBeenCalled();
    },
  );

  it("keeps trajectory path resolution but skips recorder creation when disabled", async () => {
    await expect(
      prepareEmbeddedAttemptTrajectory((await createInput(true)) as never),
    ).resolves.toBeNull();

    expect(hoisted.resolveAttemptTrajectorySessionFile).toHaveBeenCalledOnce();
    expect(hoisted.createTrajectoryRuntimeRecorder).not.toHaveBeenCalled();
    expect(hoisted.buildTrajectoryRunMetadata).not.toHaveBeenCalled();
  });
});
