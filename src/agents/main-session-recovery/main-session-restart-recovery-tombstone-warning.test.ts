import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import {
  readStartupRecoveryTombstoneWarning,
  readStartupRecoveryWarning,
} from "./main-session-restart-recovery-diagnostics.js";
import {
  createRestartRecoveryStoreFixture,
  mainSessionEntry,
} from "./main-session-restart-recovery-fixture.test-support.js";
import {
  markStartupOrphanedMainSessionsForRecovery,
  recoverRestartAbortedMainSessions,
} from "./main-session-restart-recovery.js";

const callGateway = vi.fn(async () => ({ runId: "run-resumed" }));
const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(async () => ({
  suppressed: false,
}));
const gatewayRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: async () => {},
  sendRecoveryNotice,
});

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-tombstone-warning-");
let stateDir: string;
const { makeSessionsDir, writeStore, writeTranscript } = createRestartRecoveryStoreFixture(
  () => stateDir,
);

async function runStartupRecovery(storePath: string) {
  const cfg = { session: { store: storePath } };
  setRuntimeConfigSnapshot(cfg);
  try {
    await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir });
    return await recoverRestartAbortedMainSessions({ cfg, stateDir, gatewayRuntime });
  } finally {
    clearRuntimeConfigSnapshot();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentEventsForTest();
  rotateAgentEventLifecycleGeneration();
  stateDir = tempDirs.make();
});

describe("startup recovery tombstone warning", () => {
  it.each(["settled", "tombstoned"] as const)(
    "names a delegated turn the restart dropped (%s)",
    async (outcome) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:main";
      await writeStore(sessionsDir, {
        [sessionKey]: mainSessionEntry({
          restartRecoveryDeliveryRunId: "delegated-run",
          restartRecoveryDeliverySourceRunId: "delegated-run",
          restartRecoverySourceIngress: "internal",
          // A second unfinished fence keeps execution custody, so recovery must tombstone.
          ...(outcome === "tombstoned"
            ? { restartRecoveryRuns: [{ runId: "sibling-run", lifecycleGeneration: "previous" }] }
            : {}),
        }),
      });
      await writeTranscript(sessionsDir, "main-session", [
        {
          role: "user",
          content: "Finish the delegated task.",
          idempotencyKey: "delegated-run",
          provenance: { kind: "inter_session" },
        },
      ]);
      expect(readStartupRecoveryTombstoneWarning()).toBeUndefined();

      await runStartupRecovery(storePath);

      expect(callGateway).not.toHaveBeenCalled();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      const saved = loadSessionEntry({ storePath, sessionKey });
      if (outcome === "tombstoned") {
        expect(saved?.mainRestartRecovery?.tombstone?.reason).toBe(
          "delegated recovery sender authority is unavailable",
        );
      } else {
        expect(saved).toMatchObject({ status: "interrupted", abortedLastRun: false });
        expect(saved?.mainRestartRecovery).toBeUndefined();
      }
      const warning = readStartupRecoveryTombstoneWarning();
      expect(warning).toContain("will not resume 1 main session(s)");
      expect(warning).toContain("1 lost delegated sender authority");
      expect(warning).toContain(
        `main: ${sessionKey} (delegated recovery sender authority is unavailable)`,
      );
      const reader = readStartupRecoveryTombstoneWarning(false);
      expect(reader).toContain("1 lost delegated sender authority");
      expect(reader).toContain("/new or /reset");
      expect(reader).not.toContain(sessionKey);
      expect(readStartupRecoveryWarning()).toBeUndefined();
    },
  );

  it("reports persisted tombstones from earlier boots and skips replaced ones", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const tombstoned = (reason: string, recovered = false) =>
      mainSessionEntry({
        status: "failed",
        abortedLastRun: false,
        mainRestartRecovery: {
          cycleId: "old-cycle",
          revision: 2,
          chargedAttempts: 3,
          tombstone: {
            reason,
            ...(recovered
              ? { recoveredSessionId: "successor", recoveredSessionKey: "agent:main:successor" }
              : {}),
          },
        },
      });
    await writeStore(sessionsDir, {
      "agent:main:main": tombstoned("delegated recovery sender authority is unavailable"),
      "agent:main:exhausted": {
        ...tombstoned("automatic recovery exhausted"),
        sessionId: "exhausted-session",
      },
      "agent:main:replaced": {
        ...tombstoned("automatic recovery exhausted", true),
        sessionId: "replaced-session",
      },
    });

    await runStartupRecovery(storePath);

    expect(callGateway).not.toHaveBeenCalled();
    const warning = readStartupRecoveryTombstoneWarning();
    expect(warning).toContain("will not resume 2 main session(s)");
    expect(warning).toContain("1 lost delegated sender authority");
    expect(warning).toContain("1 other tombstoned session(s) already have a replacement");
    expect(warning).toContain("agent:main:exhausted (automatic recovery exhausted)");
    expect(warning).toContain("agent:main:main (delegated recovery sender authority");
    expect(warning).not.toContain("agent:main:replaced");
    expect(readStartupRecoveryTombstoneWarning(false)).not.toContain("agent:main:exhausted");

    rotateAgentEventLifecycleGeneration();
    expect(readStartupRecoveryTombstoneWarning()).toBeUndefined();
  });

  it("stays silent on a clean boot", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": mainSessionEntry({
        status: "done",
        abortedLastRun: false,
        mainRestartRecovery: undefined,
      }),
    });

    await runStartupRecovery(storePath);

    expect(readStartupRecoveryTombstoneWarning()).toBeUndefined();
    expect(readStartupRecoveryTombstoneWarning(false)).toBeUndefined();
  });
});
