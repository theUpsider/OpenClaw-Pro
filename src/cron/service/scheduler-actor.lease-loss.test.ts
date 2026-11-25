import { BroadcastChannel } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createCronServiceWithStateForTest } from "../service.test-harness.js";
import { saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { waitForCronRunQueue } from "./run-queue.js";

// Route scheduler leases through the real owner while capturing the owner's
// native-loss callback, the same signal a terminated shared-state worker sends.
const leases = vi.hoisted(() => ({ nativeLoss: [] as Array<() => void>, failAcquire: false }));
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  const { retainOpenClawStateWorkerLease } =
    await import("../../state/openclaw-state-worker-lease.js");
  const { getOpenClawStateWorkerOwner } =
    await import("../../state/openclaw-state-worker-owner.js");
  return {
    ...actual,
    createOpenClawStateWorkerLease: (
      ...[context, finalize, onNativeLost]: Parameters<typeof actual.createOpenClawStateWorkerLease>
    ) => {
      if (leases.failAcquire) {
        throw new Error("injected lease acquisition failure");
      }
      return retainOpenClawStateWorkerLease(
        context,
        {
          open: (captured) => getOpenClawStateWorkerOwner().open(captured),
          retainOperation: (store, lost) => {
            if (lost) {
              leases.nativeLoss.push(lost);
            }
            return getOpenClawStateWorkerOwner().retainOperation(store, lost);
          },
        },
        finalize,
        onNativeLost,
      );
    },
  };
});

const fixtures = setupCronRegressionFixtures({ prefix: "cron-lease-loss-" });

async function startScheduler() {
  leases.nativeLoss.length = 0;
  leases.failAcquire = false;
  const { storePath } = fixtures.makeStorePath();
  const now = Date.now();
  const jobs = [
    createDueIsolatedJob({ id: "upcoming", nowMs: now, nextRunAtMs: now + 12_000 }),
    createDueIsolatedJob({ id: "later", nowMs: now, nextRunAtMs: now + 120_000 }),
  ];
  for (const job of jobs) {
    job.sessionTarget = "main";
    job.payload = { kind: "systemEvent", text: job.id };
  }
  await saveCronStore(storePath, { version: 1, jobs });
  const channels: BroadcastChannel[] = [];
  vi.spyOn(BroadcastChannel.prototype, "addEventListener").mockImplementation(function (
    this: BroadcastChannel,
    type,
    listener,
    options,
  ) {
    if (type === "message" && this.name.startsWith("openclaw.cron.")) {
      channels.push(this);
    }
    EventTarget.prototype.addEventListener.call(this, type, listener, options);
  });
  const enqueueSystemEvent = vi.fn();
  const log = { ...noopLogger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = createGatewaySchedulerClock(now);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler,
    storePath,
    cronEnabled: true,
    log,
    enqueueSystemEvent,
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
  await cron.start();
  expect(leases.nativeLoss).toHaveLength(1);
  expect(channels).toHaveLength(1);
  const enqueued = () => enqueueSystemEvent.mock.calls.map(([text]) => text);
  /** Terminate the worker-side actor like an OOM'd worker, then signal the lease. */
  const loseWorker = async () => {
    const lost = channels.at(-1)!;
    await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
      type: "cron.schedulerStop",
      input: { storeKey: cronStoreKey(storePath), channelName: lost.name },
    });
    leases.nativeLoss.at(-1)!();
  };
  return { cron, state, clock, scheduler, log, channels, enqueued, loseWorker };
}

it("re-arms the scheduler after its worker lease is natively lost", async () => {
  const { cron, state, clock, scheduler, log, channels, enqueued, loseWorker } =
    await startScheduler();
  try {
    expect(enqueued()).toEqual([]);
    await loseWorker();
    clock.setTime(clock.clock.now() + 15_000);
    // The first backoff step re-runs schedulerStart, whose catch-up fires the job
    // that came due while the lease was dead.
    await vi.waitFor(async () => {
      await clock.advanceBy(1_000);
      await waitForCronRunQueue(state);
      expect(enqueued()).toEqual(["upcoming"]);
    });
    expect(log.warn).toHaveBeenCalledWith({}, "cron: scheduler worker lease lost; re-arming");
    expect(log.info).toHaveBeenCalledWith({ attempt: 1 }, "cron: scheduler re-armed");
    expect(state.schedulerStarted).toBe(true);
    expect(channels).toHaveLength(2);
    // The replacement worker actor wakes the new channel and ticks normally.
    clock.setTime(clock.clock.now() + 120_000);
    channels.at(-1)!.dispatchEvent(new MessageEvent("message"));
    await vi.waitFor(() => expect(enqueued()).toEqual(["upcoming", "later"]));
    expect(log.error).not.toHaveBeenCalled();
  } finally {
    cron.stop();
    await scheduler.stop();
  }
});

it("gives up loudly after bounded re-arm attempts", async () => {
  const { cron, clock, scheduler, log, loseWorker } = await startScheduler();
  try {
    leases.failAcquire = true;
    await loseWorker();
    await vi.waitFor(
      async () => {
        await clock.advanceBy(60_000);
        expect(log.error).toHaveBeenCalledTimes(1);
      },
      { timeout: 5_000 },
    );
    const attempts = () =>
      log.warn.mock.calls.filter(
        ([, message]) => message === "cron: scheduler re-arm attempt failed",
      );
    expect(attempts()).toHaveLength(5);
    expect(log.error).toHaveBeenCalledWith(
      { attempts: 5 },
      "cron: scheduler could not re-arm after losing its worker lease; restart the gateway",
    );
    expect(scheduler.nextWakeAtMs).toBeNull();
  } finally {
    cron.stop();
    await scheduler.stop();
  }
});

it("does not re-arm a scheduler stopped during backoff", async () => {
  const { cron, state, clock, scheduler, log, loseWorker } = await startScheduler();
  try {
    await loseWorker();
    await vi.waitFor(() => expect(scheduler.nextWakeAtMs).not.toBeNull());
    cron.stop();
    await state.schedulerDrain;
    await clock.advanceBy(700_000);
    expect(log.info).not.toHaveBeenCalledWith({ attempt: 1 }, "cron: scheduler re-armed");
    expect(state.schedulerStarted).toBe(false);
  } finally {
    cron.stop();
    await scheduler.stop();
  }
});
