import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import { PluginHostCleanupTimeoutError } from "../plugins/host-hook-cleanup-timeout.js";
import { getPluginRuntimeGeneration, PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  LIFECYCLE_DRAIN_RETRY_BACKOFF_MAX_MS,
  LIFECYCLE_DRAIN_RETRY_BACKOFF_MS,
  PluginLifecycleRetryBackoffError,
} from "./config-reload-plugin-drain.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushReload,
  flushWatcherChange,
  makeSnapshot,
  makeWrite,
  makeZeroDebounceHookWrite,
  prepareConfigReloadTest,
} from "./config-reload.test-support.js";
import { PluginAdmittedWorkTimeoutError } from "./server-plugin-reload-cleanup.js";

vi.mock("../config/io.audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.audit.js")>()),
  appendConfigAuditRecord: vi.fn(),
}));
vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config-journal-snapshot.js")>()),
  readLatestConfigSnapshotAuditRecordAsync: vi.fn(async () => null),
  upsertConfigSnapshotAuditRecordAsync: vi.fn(),
}));

beforeEach((context) => {
  prepareConfigReloadTest(context);
  vi.useFakeTimers();
});
afterEach(async () => {
  await closeTestConfigReloaders();
  resetPluginRuntimeStateForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("plugin drain recovery", () => {
  it("hot-applies model settings without replacing the Codex generation", async () => {
    const initialConfig: OpenClawConfig = {
      plugins: { entries: { codex: { enabled: true } } },
    };
    let config = initialConfig;
    const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
      initialConfig,
    });
    await harness.reloader.ready;

    for (const update of [
      { agents: { defaults: { models: { "openai/gpt-5.6-sol": { alias: "primary" } } } } },
      { agents: { entries: { worker: { model: { primary: "openai/gpt-5.6-sol" } } } } },
      {
        models: {
          providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } },
        },
      },
    ] satisfies OpenClawConfig[]) {
      config = { ...initialConfig, ...update };
      await flushWatcherChange(harness);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(false);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
    }
    expect(harness.onHotReload).toHaveBeenCalledTimes(3);
    expect(harness.onRestart).not.toHaveBeenCalled();
  });

  it("replays a deferred plugin replacement with later edits once its admitted work settles", async () => {
    const codex = (sandbox: string) => ({ enabled: true, config: { sandbox } });
    const initialConfig: OpenClawConfig = {
      plugins: { entries: { codex: codex("read-only") } },
      agents: { entries: { main: {} } },
    };
    let config: OpenClawConfig = {
      ...initialConfig,
      plugins: { entries: { codex: codex("workspace-write") } },
    };
    let configHash = "initial";
    const application = createRuntimeConfigWriteApplication();
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({ id: "codex", source: "/synthetic/codex.ts" });
    builder.registry.plugins.push(record);
    builder.createApi(record, { config: {} });
    setActivePluginRegistry(builder.registry);
    const registryOwner = createPluginRegistryOwner(builder.registry);
    const instance = getPluginInstance(record);
    assert(instance);
    const releaseWork = instance.retainWork();
    const cleanup = createDeferredCore();
    let cleanupCall: Promise<void> | undefined;
    const harness = createReloaderHarness(async () => makeSnapshot({ config, hash: configHash }), {
      initialConfig,
      // Stands in for the reload owner's 60s pre-stop drain expiring on the held work.
      onHotReload: async (plan) => {
        if (plan.reloadPlugins && instance.retainedWorkCount > 0) {
          throw new PluginRuntimeApplicationError(
            "admitted work did not settle",
            {
              operationId: "failed-automatic-drain",
              generation: getPluginRuntimeGeneration(),
              pluginIds: ["codex"],
              phase: "drain",
              committed: false,
            },
            {
              cause: new PluginAdmittedWorkTimeoutError(
                new Set(["codex"]),
                [instance],
                new PluginHostCleanupTimeoutError("plugin codex admitted work"),
                60_000,
              ),
            },
          );
        }
        return plan.reloadPlugins
          ? {
              status: "applied",
              runtime: {
                operationId: "codex-replacement",
                generation: getPluginRuntimeGeneration(),
                pluginIds: ["codex"],
              },
            }
          : "applied";
      },
    });
    try {
      await harness.reloader.ready;
      configHash = "plugin-change";
      application.recordConfigChange(initialConfig, config);
      harness.emitWrite(
        attachRuntimeConfigWriteApplication(makeWrite(config, configHash), application),
      );
      await flushReload(harness.reloader);
      await expect(application.result).resolves.toBe("failed");
      config = { ...config, agents: { entries: { main: { skills: [] } } } };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.onConfigApplied).not.toHaveBeenCalled();
      expect(harness.log.info).toHaveBeenCalledWith(
        expect.stringContaining("config reload deferred"),
      );
      expect(harness.log.info).not.toHaveBeenCalledWith(expect.stringContaining("--wait"));

      // The pre-stop drain also joins cleanup calls, so the retry waits for them too.
      cleanupCall = instance.runCleanup(() => cleanup.promise);
      releaseWork();
      await flushReload(harness.reloader);
      expect(harness.onHotReload).toHaveBeenCalledOnce();

      cleanup.resolve();
      await cleanupCall;
      await flushReload(harness.reloader);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
      expect(harness.log.error).toHaveBeenCalledOnce();
    } finally {
      await harness.reloader.stop();
      releaseWork();
      cleanup.resolve();
      await cleanupCall;
      await registryOwner.close();
    }
  });

  it.each(["explicit wait", "revert", "revert with model edit"] as const)(
    "retains a failed automatic plugin drain until recovery: %s",
    async (recovery) => {
      const initialConfig: OpenClawConfig = {
        plugins: { entries: { codex: { enabled: true, config: { sandbox: "read-only" } } } },
      };
      let config: OpenClawConfig = {
        plugins: {
          entries: { codex: { enabled: true, config: { sandbox: "workspace-write" } } },
        },
      };
      const failure = new PluginRuntimeApplicationError("admitted work did not settle", {
        operationId: "failed-automatic-drain",
        generation: getPluginRuntimeGeneration(),
        pluginIds: ["codex"],
        phase: "drain",
        committed: false,
      });
      const runtime = {
        operationId: "explicit-wait-recovery",
        generation: getPluginRuntimeGeneration(),
        pluginIds: ["codex"],
      };
      const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
        initialConfig,
        onHotReload: async (plan) => {
          if (plan.reloadPlugins && !plan.pluginLifecycle?.waitForDrain) {
            throw failure;
          }
          return plan.reloadPlugins ? { status: "applied", runtime } : "applied";
        },
      });
      await harness.reloader.ready;
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();

      await flushWatcherChange(harness);
      config = {
        ...config,
        agents: { defaults: { models: { "openai/gpt-5.6-sol": { alias: "primary" } } } },
      };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.log.error).toHaveBeenCalledOnce();
      expect(harness.onConfigApplied).not.toHaveBeenCalled();
      // Nothing watches a drain that failed without an admitted-work timeout.
      expect(harness.log.info).toHaveBeenCalledWith(expect.stringContaining("--wait"));

      if (recovery !== "explicit wait") {
        config = {
          ...initialConfig,
          ...(recovery === "revert with model edit" ? { agents: config.agents } : {}),
        };
        await flushWatcherChange(harness);
        expect(harness.onConfigAccepted.mock.lastCall?.[0]).toEqual(config);
        const attempts = harness.onHotReload.mock.calls.length;
        config = {
          ...config,
          plugins: { entries: { codex: { enabled: true, config: { sandbox: "new-settings" } } } },
        };
        await flushWatcherChange(harness);
        expect(harness.onHotReload).toHaveBeenCalledTimes(attempts + 1);
        expect(harness.log.error).toHaveBeenCalledTimes(2);
        await flushWatcherChange(harness);
        expect(harness.onHotReload).toHaveBeenCalledTimes(attempts + 1);
        return;
      }

      await expect(
        harness.reloader.applyPluginLifecycleChange({
          config,
          pluginIds: ["codex"],
          reason: "reload",
        }),
      ).rejects.toBe(failure);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      await expect(
        harness.reloader.applyPluginLifecycleChange({
          config,
          pluginIds: ["codex"],
          reason: "reload",
          waitForDrain: true,
        }),
      ).resolves.toBe(runtime);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);

      config = { ...config, agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(false);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
    },
  );

  it.each([true, false])(
    "applies a different plugin after partial then complete reversion (existing entries: %s)",
    async (existingEntries) => {
      const codex = {
        enabled: true,
        config: { sandbox: "read-only", appServer: { args: ["--original"] } },
      };
      const other = { enabled: true, config: { value: "original" } };
      const initialConfig: OpenClawConfig = existingEntries
        ? { plugins: { entries: { codex, other } } }
        : {};
      const pendingCodex = {
        ...codex,
        config: { sandbox: "workspace-write", appServer: { args: ["--replacement"] } },
      };
      let config: OpenClawConfig = {
        plugins: { entries: { codex: pendingCodex, ...(existingEntries ? { other } : {}) } },
      };
      const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
        initialConfig,
      });
      await harness.reloader.ready;
      harness.onHotReload.mockRejectedValueOnce(
        new PluginRuntimeApplicationError("admitted work did not settle", {
          operationId: "failed-codex-drain",
          generation: getPluginRuntimeGeneration(),
          pluginIds: ["codex"],
          phase: "drain",
          committed: false,
        }),
      );
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();

      const nextOther = { ...other, config: { value: "replacement" } };
      config = {
        plugins: {
          entries: {
            codex: {
              ...pendingCodex,
              config: existingEntries
                ? { ...pendingCodex.config, sandbox: codex.config.sandbox }
                : { appServer: pendingCodex.config.appServer },
            },
            other: nextOther,
          },
        },
      };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.onConfigApplied).not.toHaveBeenCalled();

      config = {
        plugins: { entries: { ...(existingEntries ? { codex } : {}), other: nextOther } },
      };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
      expect(harness.log.error).toHaveBeenCalledOnce();
    },
  );
});

describe("plugin observations", () => {
  const runtime = { operationId: "manual", generation: 1, pluginIds: ["notes"] };
  const failure = () =>
    new PluginRuntimeApplicationError("candidate activation failed", {
      ...runtime,
      phase: "activate",
      committed: false,
    });

  it.each(["none", "file-before", "file-during", "write-during"] as const)(
    "retains only real config work after a failed manual reload: %s",
    async (event) => {
      const config: OpenClawConfig = {};
      const write = makeZeroDebounceHookWrite("next");
      let snapshot = makeSnapshot({ config, hash: "initial" });
      const entered = createDeferred();
      const release = createDeferred();
      const error = failure();
      let reject = false;
      const harness = createReloaderHarness(async () => snapshot, {
        initialConfig: config,
        onHotReload: async (plan) => {
          if (plan.pluginLifecycle && reject) {
            entered.resolve();
            await release.promise;
            throw error;
          }
          return plan.pluginLifecycle ? { status: "applied", runtime } : "applied";
        },
      });
      await harness.reloader.ready;
      const reload = (sourceConfig = config) =>
        withPluginLifecycleLease({}, () =>
          harness.reloader.applyPluginLifecycleChange({
            config: sourceConfig,
            pluginIds: ["notes"],
            reason: "reload",
          }),
        );
      await expect(reload()).resolves.toEqual(runtime);
      harness.onConfigAccepted.mockClear();
      if (event === "file-before") {
        snapshot = write.snapshot;
        harness.watcher.emit("change");
      }
      reject = true;
      const result = reload(snapshot.sourceConfig).catch((caught: unknown) => caught);
      try {
        await entered.promise;
        if (event === "file-during" || event === "write-during") {
          snapshot = write.snapshot;
          if (event === "write-during") {
            harness.emitWrite(write);
          } else {
            harness.watcher.emit("change");
          }
          await vi.advanceTimersByTimeAsync(0);
        }
        release.resolve();
        expect(await result).toBe(error);
        await flushReload(harness.reloader);
        expect(harness.onConfigAccepted).toHaveBeenCalledTimes(event === "none" ? 0 : 1);
        if (event !== "none") {
          expect(harness.onConfigAccepted.mock.calls[0]?.[2]).toEqual(write.sourceConfig);
        }
        // A later genuine observation remains admissible after either outcome.
        harness.onConfigAccepted.mockClear();
        harness.watcher.emit("change");
        await flushReload(harness.reloader);
        expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await result;
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "discards a late initial source read after manual failure: %s",
    async (outcome) => {
      const initialRead = createDeferred<ConfigFileSnapshot>();
      const config: OpenClawConfig = {};
      const snapshot = makeSnapshot({ config, hash: "same" });
      const readSnapshot = vi
        .fn<() => Promise<ConfigFileSnapshot>>()
        .mockImplementationOnce(() => initialRead.promise)
        .mockResolvedValue(snapshot);
      const error = failure();
      const harness = createReloaderHarness(readSnapshot, {
        initialConfig: config,
        onHotReload: async () => {
          throw error;
        },
      });
      await harness.reloader.ready;
      harness.watcher.emit("ready");
      await expect(
        withPluginLifecycleLease({}, () =>
          harness.reloader.applyPluginLifecycleChange({
            config,
            pluginIds: ["notes"],
            reason: "reload",
          }),
        ),
      ).rejects.toBe(error);
      if (outcome === "reject") {
        initialRead.reject(new Error("old read failed"));
      } else {
        initialRead.resolve(makeSnapshot({ exists: false, valid: false }));
      }
      await flushReload(harness.reloader);
      expect(readSnapshot).toHaveBeenCalledTimes(2);
      expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    },
  );

  it("applies transcript changes through the plugin reload transaction without a plugin policy", async () => {
    const registry = createTestRegistry([]);
    setActivePluginRegistry(registry);
    const config: OpenClawConfig = {
      transcripts: { autoStart: [{ providerId: "capture", channelId: "old-room" }] },
    };
    const nextConfig: OpenClawConfig = {
      transcripts: { autoStart: [{ providerId: "capture", channelId: "new-room" }] },
    };
    const drainSignal = new AbortController().signal;
    const appliedRuntime = {
      operationId: "transcript-reload",
      generation: 2,
      pluginIds: ["notes"],
    };
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config: nextConfig, sourceConfig: nextConfig, hash: "next" }),
      {
        initialConfig: config,
        initialCompareConfig: config,
        onHotReload: async (plan, next, ownership) => {
          ownership.markRuntimeCommitted(next, plan);
          return { status: "applied", runtime: appliedRuntime };
        },
      },
    );
    await harness.reloader.ready;
    try {
      const applied = harness.reloader.applyPluginLifecycleChange({
        config: nextConfig,
        pluginIds: ["notes"],
        reason: "reload",
        waitForDrain: true,
        drainSignal,
      });
      await expect(applied).resolves.toEqual(appliedRuntime);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.onHotReload.mock.calls[0]?.[0]).toMatchObject({
        pluginLifecycle: { waitForDrain: true, drainSignal },
        reloadPlugins: true,
        restartGateway: false,
        changedPaths: ["transcripts.autoStart"],
      });
      expect(harness.onHotReload.mock.calls[0]?.[1]).toEqual(nextConfig);
      expect(harness.onRestart).not.toHaveBeenCalled();
    } finally {
      await harness.reloader.stop();
    }
  });
});

describe("lifecycle drain retry backoff", () => {
  const config: OpenClawConfig = {};
  const drainFailure = () =>
    new PluginRuntimeApplicationError("plugin service stop timed out", {
      operationId: "failed",
      generation: getPluginRuntimeGeneration(),
      pluginIds: ["notes"],
      phase: "drain",
      committed: false,
    });

  async function createFailingHarness() {
    const harness = createReloaderHarness(async () => makeSnapshot({ config, hash: "same" }), {
      initialConfig: config,
      onHotReload: async () => {
        throw drainFailure();
      },
    });
    await harness.reloader.ready;
    const reload = (pluginIds = ["notes"], waitForDrain?: boolean) =>
      harness.reloader
        .applyPluginLifecycleChange({ config, pluginIds, reason: "reload", waitForDrain })
        .catch((error: unknown) => error);
    return { harness, reload };
  }

  it("collapses concurrent identical retries of a failed drain into one generation run", async () => {
    const { harness, reload } = await createFailingHarness();

    const results = await withPluginLifecycleLease({}, () =>
      Promise.all(Array.from({ length: 4 }, () => reload())),
    );

    expect(harness.onHotReload).toHaveBeenCalledOnce();
    const [first, ...refused] = results;
    expect(first).toMatchObject({ details: { phase: "drain", committed: false } });
    const operationIds = new Set<unknown>();
    for (const result of refused) {
      assert(result instanceof PluginRuntimeApplicationError);
      expect(result.details).toMatchObject({
        pluginIds: ["notes"],
        phase: "prepare",
        committed: false,
      });
      assert(result.cause instanceof PluginLifecycleRetryBackoffError);
      expect(result.cause.cause).toBe(first);
      expect(result.cause.retryAfterMs).toBeLessThanOrEqual(LIFECYCLE_DRAIN_RETRY_BACKOFF_MS);
      operationIds.add(result.details.operationId);
    }
    // Each refused caller receives its own operation receipt.
    expect(operationIds.size).toBe(refused.length);
  });

  it("reruns an identical replacement only after its backoff, with --wait, or for other plugins", async () => {
    const { harness, reload } = await createFailingHarness();
    await withPluginLifecycleLease({}, async () => {
      await reload();
      await reload();
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);
      await reload(["other"]);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
      await reload(["notes"], true);
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);

      // The failed --wait run repeats the request, so its wait doubled despite the unrelated failure.
      await vi.advanceTimersByTimeAsync(LIFECYCLE_DRAIN_RETRY_BACKOFF_MS);
      await reload();
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(LIFECYCLE_DRAIN_RETRY_BACKOFF_MS);
      await reload();
      expect(harness.onHotReload).toHaveBeenCalledTimes(4);
    });
  });

  /** Outcome and persisted bytes are switchable; a success keeps the generation, like A2. */
  async function createSwitchableHarness() {
    const state = { outcome: "fail" as "fail" | "apply", hash: "same" };
    const harness = createReloaderHarness(async () => makeSnapshot({ config, hash: state.hash }), {
      initialConfig: config,
      onHotReload: async () => {
        if (state.outcome === "fail") {
          throw drainFailure();
        }
        return {
          status: "applied",
          runtime: {
            operationId: "kept",
            generation: getPluginRuntimeGeneration(),
            pluginIds: ["notes"],
          },
        };
      },
    });
    await harness.reloader.ready;
    const reload = (reason: "reload" | "enable" = "reload") =>
      harness.reloader
        .applyPluginLifecycleChange({ config, pluginIds: ["notes"], reason })
        .catch((error: unknown) => error);
    return { harness, reload, state };
  }

  it("keys the backoff to the request: another reason or other persisted bytes run at once", async () => {
    const { harness, reload, state } = await createSwitchableHarness();
    await withPluginLifecycleLease({}, async () => {
      await reload();
      expect(await reload()).toMatchObject({
        cause: expect.any(PluginLifecycleRetryBackoffError),
      });
      expect(harness.onHotReload).toHaveBeenCalledTimes(1);

      await reload("enable");
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);

      // Changed inputs never see the stale entry; it stays bounded and leaves with the generation.
      state.hash = "edited";
      await reload();
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);
    });
  });

  it("resets the backoff when the same request later succeeds without a new generation", async () => {
    const { harness, reload, state } = await createSwitchableHarness();
    await withPluginLifecycleLease({}, async () => {
      await reload();
      await vi.advanceTimersByTimeAsync(LIFECYCLE_DRAIN_RETRY_BACKOFF_MS);
      state.outcome = "apply";
      const generation = getPluginRuntimeGeneration();
      await expect(reload()).resolves.toMatchObject({ generation });
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);

      // A later failure is a first failure again: it waits the base window, not double.
      state.outcome = "fail";
      await reload();
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(LIFECYCLE_DRAIN_RETRY_BACKOFF_MS);
      await reload();
      expect(harness.onHotReload).toHaveBeenCalledTimes(4);
    });
  });

  it("always admits the identical retry again once each capped window passes", async () => {
    const { harness, reload } = await createSwitchableHarness();
    await withPluginLifecycleLease({}, async () => {
      await reload();
      for (let failures = 1; failures <= 7; failures++) {
        const waitMs = Math.min(
          LIFECYCLE_DRAIN_RETRY_BACKOFF_MS * 2 ** (failures - 1),
          LIFECYCLE_DRAIN_RETRY_BACKOFF_MAX_MS,
        );
        await vi.advanceTimersByTimeAsync(waitMs - 1);
        await reload();
        expect(harness.onHotReload).toHaveBeenCalledTimes(failures);
        await vi.advanceTimersByTimeAsync(1);
        await reload();
        expect(harness.onHotReload).toHaveBeenCalledTimes(failures + 1);
      }
    });
  });
});
