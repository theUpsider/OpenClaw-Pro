import { hashStableJson } from "../plugins/installed-plugin-index-hash.js";
import {
  getPluginRuntimeGeneration,
  PluginRuntimeApplicationError,
  type PluginRuntimeApplication,
} from "../plugins/lifecycle.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import { PluginAdmittedWorkTimeoutError } from "./server-plugin-reload-cleanup.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

export function isConfigReloadSuperseded(error: unknown): boolean {
  // Only completed rollback preserves the direct cause. Cleanup failures and
  // published replacements must settle instead of transferring the write.
  const cause =
    error instanceof PluginRuntimeApplicationError && !error.details.committed
      ? error.cause
      : error;
  return cause instanceof GatewayConfigReloadSupersededError;
}

/** First wait before an identical lifecycle replacement may rerun after a drain failure. */
export const LIFECYCLE_DRAIN_RETRY_BACKOFF_MS = 30_000;
/** Repeated identical failures double the wait up to this bound. */
export const LIFECYCLE_DRAIN_RETRY_BACKOFF_MAX_MS = 8 * 60_000;
const LIFECYCLE_DRAIN_RETRY_MAX_KEYS = 16;

/** An identical lifecycle replacement is refused while its last drain failure backs off. */
export class PluginLifecycleRetryBackoffError extends Error {
  constructor(
    readonly retryAfterMs: number,
    options: { cause: PluginRuntimeApplicationError },
  ) {
    super(
      `An identical plugin replacement failed during drain and is backing off for ${Math.ceil(retryAfterMs / 1000)}s; ` +
        "retry after that, change the plugin config, or reload with --wait to wait for the failed plugin's work. " +
        `Last failure: ${options.cause.message}`,
      options,
    );
    this.name = "PluginLifecycleRetryBackoffError";
  }
}

/**
 * Retain a failed automatic drain until its generation or pending settings settle,
 * and schedule the replacement again once the failed plugins' work settles.
 * Explicit lifecycle requests that repeat an uncommitted drain failure over unchanged
 * inputs and generation back off exponentially instead of each running a generation.
 */
export function createConfigPluginDrainTracker(params: {
  signal: AbortSignal;
  onWorkSettled: () => void;
}) {
  // Keyed so an unrelated failure in between cannot reset another request's backoff.
  const lifecycleRetries = new Map<
    string,
    { error: PluginRuntimeApplicationError; failures: number; retryAtMs: number }
  >();
  let lifecycleRetryGeneration: number | undefined;
  // Inputs identify the persisted config and install records the plan was built from.
  const lifecycleRetryKey = (plan: GatewayReloadPlan, inputs: unknown) =>
    plan.pluginLifecycle &&
    hashStableJson({
      pluginIds: plan.pluginLifecycle.pluginIds.toSorted(),
      reason: plan.pluginLifecycle.reason,
      expectedSourceDigests: plan.pluginLifecycle.expectedSourceDigests ?? null,
      expectedInstallHashes: plan.pluginLifecycle.expectedInstallHashes ?? null,
      changedPaths: plan.changedPaths.toSorted(),
      inputs,
    });
  let failure:
    | {
        error: PluginRuntimeApplicationError;
        paths: readonly string[];
        observation: AbortController;
        retriesWhenIdle: boolean;
        observing: boolean;
        reported: boolean;
      }
    | undefined;
  const clear = () => {
    failure?.observation.abort();
    failure = undefined;
  };
  const hasPendingFailure = (plan?: GatewayReloadPlan) =>
    failure?.paths.some((failedPath) =>
      plan?.changedPaths.some(
        (path) =>
          path === failedPath ||
          path.startsWith(`${failedPath}.`) ||
          failedPath.startsWith(`${path}.`),
      ),
    ) ?? false;
  return {
    assertCanApply(plan: GatewayReloadPlan, inputs: unknown) {
      if (failure && failure.error.details.generation !== getPluginRuntimeGeneration()) {
        clear();
      }
      if (lifecycleRetryGeneration !== getPluginRuntimeGeneration()) {
        lifecycleRetries.clear();
      }
      const key = lifecycleRetryKey(plan, inputs);
      const retry = key ? lifecycleRetries.get(key) : undefined;
      const retryAfterMs = retry ? retry.retryAtMs - Date.now() : 0;
      if (retry && retryAfterMs > 0 && !plan.pluginLifecycle?.waitForDrain) {
        throw new PluginLifecycleRetryBackoffError(retryAfterMs, { cause: retry.error });
      }
      if (
        plan.reloadPlugins &&
        failure &&
        !plan.pluginLifecycle?.waitForDrain &&
        hasPendingFailure(plan)
      ) {
        // Publishing this candidate would expose plugin settings whose replacement never committed.
        throw failure.error;
      }
    },
    recordFailure(plan: GatewayReloadPlan, error: unknown, inputs: unknown) {
      const key = lifecycleRetryKey(plan, inputs);
      if (
        key &&
        error instanceof PluginRuntimeApplicationError &&
        error.details.phase === "drain" &&
        !error.details.committed &&
        !isConfigReloadSuperseded(error)
      ) {
        // Recovery has already republished the restored generation when the failure arrives.
        if (lifecycleRetryGeneration !== getPluginRuntimeGeneration()) {
          lifecycleRetries.clear();
          lifecycleRetryGeneration = getPluginRuntimeGeneration();
        }
        const failures = (lifecycleRetries.get(key)?.failures ?? 0) + 1;
        lifecycleRetries.delete(key);
        if (lifecycleRetries.size >= LIFECYCLE_DRAIN_RETRY_MAX_KEYS) {
          lifecycleRetries.delete(lifecycleRetries.keys().next().value!);
        }
        lifecycleRetries.set(key, {
          error,
          failures,
          retryAtMs:
            Date.now() +
            Math.min(
              LIFECYCLE_DRAIN_RETRY_BACKOFF_MS * 2 ** (failures - 1),
              LIFECYCLE_DRAIN_RETRY_BACKOFF_MAX_MS,
            ),
        });
      }
      if (
        !plan.pluginLifecycle &&
        error instanceof PluginRuntimeApplicationError &&
        error.details.phase === "drain" &&
        !error.details.committed &&
        !isConfigReloadSuperseded(error)
      ) {
        clear();
        const timeout =
          error.cause instanceof PluginAdmittedWorkTimeoutError ? error.cause : undefined;
        const current = {
          error,
          paths: plan.reloadPluginPaths ?? [],
          observation: new AbortController(),
          retriesWhenIdle: timeout !== undefined,
          observing: false,
          reported: false,
        };
        failure = current;
      }
    },
    observeAfterReceipt() {
      const current = failure;
      const timeout = current?.error.cause;
      if (!current || current.observing || !(timeout instanceof PluginAdmittedWorkTimeoutError)) {
        return;
      }
      current.observing = true;
      // The failed write receipt must settle before its turn can release retained work.
      const signal = AbortSignal.any([params.signal, current.observation.signal]);
      void Promise.all(timeout.instances.map((instance) => instance.waitForIdle(signal))).then(
        () => {
          if (failure === current) {
            clear();
            params.onWorkSettled();
          }
        },
        () => {},
      );
    },
    applied(plan?: GatewayReloadPlan, runtime?: PluginRuntimeApplication, inputs?: unknown) {
      // Clear reverted settings only after the candidate applies, including unrelated plugin edits.
      if (!plan?.reloadPlugins || runtime || !hasPendingFailure(plan)) {
        clear();
      }
      // Success ends this request's backoff even when it kept the generation (an unchanged
      // id-less refresh), so a later failure starts again at the first wait.
      const key = plan && runtime && lifecycleRetryKey(plan, inputs);
      if (key) {
        lifecycleRetries.delete(key);
      }
    },
    shouldReport(error: unknown) {
      if (!failure || error !== failure.error) {
        return true;
      }
      const report = !failure.reported;
      failure.reported = true;
      return report;
    },
    /** Whether the deferring failure clears itself once its timed-out work settles. */
    retriesWhenIdle() {
      return failure?.retriesWhenIdle ?? false;
    },
  };
}
