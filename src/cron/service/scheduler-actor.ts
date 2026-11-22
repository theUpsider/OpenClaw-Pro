import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BroadcastChannel } from "node:worker_threads";
import { isAbortError } from "../../infra/abort-signal.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createOpenClawStateWorkerLease,
  type OpenClawStateWorkerLease,
} from "../../state/openclaw-state-worker-store.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronSchedulerResult } from "../store/scheduler-actor.types.js";
import { locked } from "./locked.js";
import { registerCronSchedulerRefresh } from "./run-queue-wake.js";
import {
  adoptCronRunRequests,
  getCronRunQueueRequests,
  launchCronRunQueueResult,
} from "./run-queue.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { captureCronSchedulerSnapshot } from "./scheduler-config.js";
import { runCronSchedulerMaintenance } from "./scheduler-maintenance.js";
import { emit, type CronServiceState } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";

type ActorConnection = {
  lease: OpenClawStateWorkerLease;
  channel: BroadcastChannel;
  channelName: string;
  unsubscribe: () => void;
  unregister: () => void;
  releaseRefresh: () => void;
  pending: Promise<void>;
  /** The worker accepted this actor; earlier failures belong to the starting caller. */
  armed: boolean;
};

const connections = new WeakMap<CronServiceState, ActorConnection>();

/** Bounded backoff for replacing a scheduler connection whose worker lease died. */
const REARM_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

async function publish(state: CronServiceState, result: CronSchedulerResult): Promise<void> {
  if (result.jobs.length > 0) {
    noteCronJobsStoreCommit(cronStoreKey(state.deps.storePath));
    applyCronRuntimeRowsToState(state, result.jobs);
  }
  for (const log of result.logs) {
    state.deps.log[log.level](log.fields, log.message);
  }
  for (const job of result.ownerless) {
    emit(state, {
      jobId: job.id,
      action: "finished",
      job,
      status: "skipped",
      completionStatus: "failed",
      error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      runAtMs: job.state.lastRunAtMs,
      durationMs: 0,
      nextRunAtMs: job.state.nextRunAtMs,
    });
  }
  await runPostPersistCronNotifications(state, result.notifications);
}

export async function startCronScheduler(
  state: CronServiceState,
  skipJobIds: ReadonlySet<string>,
): Promise<void> {
  if (connections.has(state)) {
    return;
  }
  const channelName = `openclaw.cron.${randomUUID()}`;
  const generation = state.lifecycleGeneration;
  const storeKey = cronStoreKey(state.deps.storePath);
  const channel = new BroadcastChannel(channelName);
  channel.unref();
  const context = captureOpenClawStateWorkerContext();
  const lease = createOpenClawStateWorkerLease(
    context,
    async (scope) => {
      await scope.execute({ type: "cron.schedulerStop", input: { storeKey, channelName } });
    },
    () => recoverLostCronSchedulerLease(state, lease),
  );
  const connection: ActorConnection = {
    lease,
    channel,
    channelName,
    unsubscribe: () => {},
    unregister: () => {},
    releaseRefresh: () => {},
    pending: Promise.resolve(),
    armed: false,
  };
  connections.set(state, connection);
  connection.releaseRefresh = registerCronSchedulerRefresh(state, () =>
    refreshCronScheduler(state),
  );
  connection.unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (identity && identity.key !== context.admission.identity.key) {
        return;
      }
      state.stopped = true;
      await state.schedulerScope.stop();
      await closeConnection(state, connection, true);
    },
  });
  channel.addEventListener("message", () => {
    if (connections.get(state) !== connection || state.stopped || state.schedulingPaused) {
      return;
    }
    void runInDetachedAsyncContext(async () => {
      const run = () => tickCronScheduler(state);
      await (state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(run) : run());
    }).catch((error: unknown) => {
      state.deps.log.warn({ err: String(error) }, "cron: scheduling delayed; worker will retry");
      recoverClosedCronSchedulerLease(state, connection, error);
    });
  });
  connection.unsubscribe = sessionChanges.subscribe((change) => {
    if (
      !("all" in change) ||
      typeof change.scope !== "string" ||
      !change.scope.startsWith("config")
    ) {
      return;
    }
    refreshCronScheduler(state);
  });
  let started = false;
  try {
    await lease.ready;
    const result = await lease.execute({
      type: "cron.schedulerStart",
      input: {
        storeKey,
        channelName,
        snapshot: await captureCronSchedulerSnapshot(state),
        nowMs: state.deps.nowMs(),
        monotonicMs: performance.now(),
        skipJobIds: [...skipJobIds],
        deferAgentWork: true,
        liveSinceMs: state.liveSinceMs,
        paused: state.schedulingPaused,
        requests: getCronRunQueueRequests(state),
      },
    });
    const requests = adoptCronRunRequests(
      state,
      result.accepted,
      { source: "startup" },
      context,
      generation,
    );
    started = true;
    connection.armed = true;
    state.schedulerStarted = true;
    await publish(state, result);
    await locked(state, () => launchCronRunQueueResult(state, result, context));
    // Readiness observers retain queued custody without holding Gateway initialization.
    const preparingReceiptIds = new Set(
      result.preparing.map(({ runReceipt }) => runReceipt.receiptId),
    );
    const completed = await Promise.allSettled(
      requests
        .filter((request) => !preparingReceiptIds.has(request.runReceipt.receiptId))
        .map((request) => request.completion),
    );
    const failed = completed.find((completion) => completion.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
  } catch (error) {
    if (!started) {
      await stopCronScheduler(state);
    }
    throw error;
  }
}

/** The worker decides which slots are due; the host only launches committed requests. */
function tickCronScheduler(state: CronServiceState): Promise<void> {
  const connection = connections.get(state);
  if (!connection || state.stopped || state.schedulingPaused) {
    return Promise.resolve();
  }
  const tick = connection.pending
    .catch(() => {})
    .then(() => runCronSchedulerTick(state, connection));
  connection.pending = tick;
  return tick;
}

async function runCronSchedulerTick(
  state: CronServiceState,
  connection: ActorConnection,
): Promise<void> {
  if (connections.get(state) !== connection || state.stopped || state.schedulingPaused) {
    return;
  }
  const generation = state.lifecycleGeneration;
  let admission;
  try {
    admission = await beginGatewayRootWorkAdmissionWhenOpen(
      "cron:worker-tick",
      state.schedulerScope.signal,
    );
  } catch (error) {
    if (
      error instanceof GatewayDrainingError ||
      (state.schedulerScope.signal.aborted && isAbortError(error))
    ) {
      return;
    }
    throw error;
  }
  try {
    await admission.run(async () => {
      if (connections.get(state) !== connection || state.stopped || state.schedulingPaused) {
        return;
      }
      await runCronSchedulerMaintenance(state);
      const result = await connection.lease.execute({
        type: "cron.schedulerTick",
        input: {
          storeKey: cronStoreKey(state.deps.storePath),
          channelName: connection.channelName,
          paused: false,
          requests: getCronRunQueueRequests(state),
          snapshot: await captureCronSchedulerSnapshot(state),
          nowMs: state.deps.nowMs(),
          monotonicMs: performance.now(),
        },
      });
      adoptCronRunRequests(state, result.accepted, { source: "scheduled" }, undefined, generation);
      await publish(state, result);
      await locked(state, () => launchCronRunQueueResult(state, result));
    });
  } finally {
    admission.release();
  }
}

/** Queue a config/row notification after the current host mutation releases its lock. */
export function refreshCronScheduler(state: CronServiceState): void {
  const connection = connections.get(state);
  if (!connection || state.stopped) {
    return;
  }
  void state.op
    .then(async () => {
      if (connections.get(state) !== connection || state.stopped) {
        return;
      }
      const snapshot = await captureCronSchedulerSnapshot(state);
      await publish(
        state,
        await connection.lease.execute({
          type: "cron.schedulerRefresh",
          input: {
            storeKey: cronStoreKey(state.deps.storePath),
            snapshot,
            channelName: connection.channelName,
            paused: state.schedulingPaused,
            nowMs: state.deps.nowMs(),
          },
        }),
      );
    })
    .catch((error: unknown) => {
      state.deps.log.warn({ err: String(error) }, "cron: worker refresh delayed");
      recoverClosedCronSchedulerLease(state, connection, error);
    });
}

function recoverClosedCronSchedulerLease(
  state: CronServiceState,
  connection: ActorConnection,
  error: unknown,
): void {
  if (error instanceof SqliteWorkerError && error.code === "closed") {
    recoverLostCronSchedulerLease(state, connection.lease);
  }
}

/**
 * A native worker loss retires the scheduler lease and takes the worker-side
 * actor and its wake timer with it, so this connection can never tick again
 * while schedulerStarted stays true. Drop it and start a new one through the
 * normal start path; lifecycle stop rotates the generation and closes
 * schedulerScope, which cancels a pending attempt.
 */
function recoverLostCronSchedulerLease(
  state: CronServiceState,
  lease: OpenClawStateWorkerLease,
): void {
  const connection = connections.get(state);
  if (connection?.lease !== lease || !connection.armed || state.stopped) {
    return;
  }
  const generation = state.lifecycleGeneration;
  state.deps.log.warn({}, "cron: scheduler worker lease lost; re-arming");
  // closeConnection unpublishes synchronously, so repeated loss signals join this recovery.
  void stopCronScheduler(state)
    .catch((error: unknown) => {
      state.deps.log.warn({ err: String(error) }, "cron: lost scheduler lease cleanup failed");
    })
    .then(() => scheduleCronSchedulerRearm(state, generation, 0));
}

function scheduleCronSchedulerRearm(
  state: CronServiceState,
  generation: number,
  attempt: number,
): void {
  if (state.stopped || state.lifecycleGeneration !== generation) {
    return;
  }
  const delayMs = REARM_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    state.deps.log.error(
      { attempts: attempt },
      "cron: scheduler could not re-arm after losing its worker lease; restart the gateway",
    );
    return;
  }
  const current = () => !state.stopped && state.lifecycleGeneration === generation;
  state.schedulerScope.schedule({
    id: `cron:scheduler-rearm:${cronStoreKey(state.deps.storePath)}`,
    delayMs,
    run: async () => {
      if (!current() || connections.has(state)) {
        return;
      }
      // Live host runs stay in the request list the worker receives; boot-only
      // interrupted-run recovery does not apply to this process.
      const start = () => startCronScheduler(state, new Set());
      try {
        await (state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(start) : start());
      } catch (error) {
        state.deps.log.warn(
          { err: String(error), attempt: attempt + 1 },
          "cron: scheduler re-arm attempt failed",
        );
      }
      if (!current()) {
        await stopCronScheduler(state);
      } else if (connections.has(state)) {
        state.deps.log.info({ attempt: attempt + 1 }, "cron: scheduler re-armed");
      } else {
        scheduleCronSchedulerRearm(state, generation, attempt + 1);
      }
    },
  });
}

export async function stopCronScheduler(state: CronServiceState): Promise<void> {
  const connection = connections.get(state);
  if (!connection) {
    return;
  }
  await closeConnection(state, connection, false);
}

async function closeConnection(
  state: CronServiceState,
  connection: ActorConnection,
  retired: boolean,
) {
  connections.delete(state);
  connection.unsubscribe();
  connection.channel.close();
  connection.releaseRefresh();
  await connection.pending.catch(() => {});
  await (retired ? connection.lease.retire() : connection.lease.release());
  connection.unregister();
}
