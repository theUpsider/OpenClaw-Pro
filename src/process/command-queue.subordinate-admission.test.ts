// Covers queue admission for work chained off settled roots and closed fences.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createGatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import {
  beginGatewayRestartSignalAdmission,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  rollbackGatewayRestartSignalFence,
  runWithGatewayIndependentRootWorkContinuation,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "./gateway-work-admission.test-helpers.js";

type SettledLeaseFence = { label: string; close: () => void; cleanup: () => void };

function suspendFence(phase: "preparing" | "draining" | "prepared"): SettledLeaseFence {
  let lease: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
  return {
    label: `suspension ${phase}`,
    close: () => {
      lease = tryBeginGatewaySuspendAdmission(() => {});
      if (!lease) {
        throw new Error(`suspend admission unavailable for ${phase}`);
      }
      if (phase === "draining") {
        lease.drain();
      } else if (phase === "prepared") {
        expect(lease.commit()).toBe(true);
      }
    },
    cleanup: () => {
      if (phase === "preparing") {
        lease?.rollback();
      } else {
        lease?.release();
      }
      lease = null;
    },
  };
}

// Every fence that must still refuse work chained off a settled lease, not just restart drain.
const settledLeaseFences: SettledLeaseFence[] = [
  { label: "restart drain", close: () => markGatewayRestartDraining(), cleanup: () => {} },
  {
    label: "stop drain",
    close: () => markGatewayRestartDraining("stop (SIGTERM)"),
    cleanup: () => {},
  },
  {
    label: "pending restart-signal fence",
    close: () => {
      expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
    },
    cleanup: () => {
      rollbackGatewayRestartSignalFence();
    },
  },
  suspendFence("preparing"),
  suspendFence("draining"),
  suspendFence("prepared"),
];

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("command queue subordinate admission", () => {
  beforeEach(resetCommandQueueStateForTest);
  afterEach(() => {
    vi.restoreAllMocks();
    resetCommandQueueStateForTest();
  });

  it("admits queued work chained off an already-released continuation root", async () => {
    const lane = `continuation-released-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const go = createDeferred();
    const enqueued = createDeferred<string>();
    let trackedDuringTask: number | undefined;
    await runWithGatewayRootWorkAdmissionForTest(async () => {
      await runWithGatewayIndependentRootWorkContinuation(async () => {
        // The continuation releases when this callback returns; the enqueue
        // below still inherits its settled lease, the way a channel dispatch
        // continues after the pump root that admitted it settled.
        void go.promise.then(() => {
          void enqueueCommandInLane(lane, async () => {
            trackedDuringTask = getActiveGatewayRootWorkCount();
            return "admitted";
          }).then((value) => enqueued.resolve(value));
        });
      }, "channel:inbound-dispatch");
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    go.resolve();
    await expect(enqueued.promise).resolves.toBe("admitted");
    // The re-entered task owns a fresh tracked root, so drain sees its span.
    expect(trackedDuringTask).toBe(1);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(settledLeaseFences)(
    "still refuses queued work chained off a released lease under $label",
    async ({ close, cleanup }) => {
      const lane = `released-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const go = createDeferred();
      const attempted = createDeferred<unknown>();
      const root = tryBeginGatewayRootWorkAdmission();
      expect(root).not.toBeNull();
      await root?.run(async () => {
        void go.promise.then(() => {
          attempted.resolve(enqueueCommandInLane(lane, async () => "blocked"));
        });
      });
      root?.release();
      close();

      try {
        go.resolve();
        await expect(attempted.promise).rejects.toBeInstanceOf(GatewayDrainingError);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        cleanup();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "holds a fresh tracked root for blocked work chained off a settled lease (%s)",
    async (outcome) => {
      const lane = `settled-blocked-${outcome}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const go = createDeferred();
      const entered = createDeferred();
      const release = createDeferred();
      const enqueued = createDeferred<string>();
      await runWithGatewayRootWorkAdmissionForTest(async () => {
        await runWithGatewayIndependentRootWorkContinuation(async () => {
          // Same shape as the released-continuation test above: the enqueue runs
          // after the continuation root settled, then the task blocks in the lane.
          void go.promise.then(() => {
            void enqueueCommandInLane(lane, async () => {
              entered.resolve();
              await release.promise;
              if (outcome === "reject") {
                throw new Error("blocked task failed");
              }
              return "admitted";
            }).then(enqueued.resolve, enqueued.reject);
          });
        }, "channel:inbound-dispatch");
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      go.resolve();
      // On the pre-fix predicate this settles instead of entering: the settled
      // lease was read as a fence, so no task ever reached the lane.
      await awaitGateBeforeSettlement(
        entered.promise,
        enqueued.promise,
        "queued work settled before entering its task",
      );
      // Ownership, not just the outcome: the fresh root must cover the whole
      // blocked span, which is what kept a drain snapshot from reading idle.
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(createGatewayActiveWorkSnapshot().idle).toBe(false);

      release.resolve();
      if (outcome === "reject") {
        await expect(enqueued.promise).rejects.toThrow("blocked task failed");
      } else {
        await expect(enqueued.promise).resolves.toBe("admitted");
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(createGatewayActiveWorkSnapshot().idle).toBe(true);
    },
  );

  it("keeps lane concurrency for the re-entered task", async () => {
    const lane = `released-concurrency-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const gate = createDeferred();
    setCommandLaneConcurrency(lane, 1);
    const first = enqueueCommandInLane(lane, async () => {
      await gate.promise;
      return "first";
    });
    const second = enqueueCommandInLane(lane, async () => "second");
    gate.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("runs accepted queued work during a closed fence while still refusing its nested enqueues", async () => {
    const lane = `fenced-dequeue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 0);
    const ran = createDeferred();
    const settled = createDeferred<string>();
    let nestedOutcome: "ran" | "refused" | undefined;

    await runWithGatewayRootWorkAdmissionForTest(async () => {
      void enqueueCommandInLane(lane, async () => {
        try {
          await enqueueCommandInLane(`${lane}-nested`, async () => "nested-ran");
          nestedOutcome = "ran";
        } catch {
          nestedOutcome = "refused";
        }
        ran.resolve();
        return "accepted";
      }).then(
        (value) => settled.resolve(value),
        () => settled.resolve("failed"),
      );
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    // Fence closes between enqueue and dequeue: the accepted task still runs
    // (its queue lane is the owning tracker), while new nested work refuses.
    markGatewayRestartDraining();
    setCommandLaneConcurrency(lane, 1);
    await ran.promise;
    await expect(settled.promise).resolves.toBe("accepted");
    expect(nestedOutcome).toBe("refused");
  });
});
