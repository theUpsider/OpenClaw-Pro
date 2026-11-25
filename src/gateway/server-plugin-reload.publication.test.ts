import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/io.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { clearActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { isConfigReloadSuperseded } from "./config-reload-plugin-drain.js";
import { createPluginReloadRecoveryFixture } from "./server-plugin-reload.recovery.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveConfigWidePluginMetadataSnapshot: vi.fn(),
  loadPluginLookUpTable: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../config/io.plugin-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.plugin-metadata.js")>()),
  resolveConfigWidePluginMetadataSnapshotAsync: mocks.resolveConfigWidePluginMetadataSnapshot,
}));
vi.mock("../plugins/plugin-lookup-table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-lookup-table.js")>()),
  loadPluginLookUpTable: mocks.loadPluginLookUpTable,
}));

const cleanups: Array<() => Promise<void>> = [];
const scanMetadata = () =>
  Object.assign(
    createPluginMetadataSnapshotFixture({ plugins: [{ id: "first" }, { id: "sibling" }] }),
    { discovery: { candidates: [], diagnostics: [] } },
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  mocks.resolveConfigWidePluginMetadataSnapshot.mockImplementation(scanMetadata);
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
    clearPluginMetadataLifecycleCaches();
  }
});

function createFixture(options: Parameters<typeof createPluginReloadRecoveryFixture>[1] = {}) {
  return createPluginReloadRecoveryFixture(
    { cleanups, logMocks: mocks.log },
    { abortOnCandidateStart: false, ...options },
  );
}

it("publishes the staged generation in one synchronous block inside commit", async () => {
  let observed: Record<string, boolean> | undefined;
  const fixture = await createFixture({
    // Called without an await after `publish()` returns; an async publication would still be
    // pending here, with the claim, registry, or snapshot not yet switched.
    afterPublish: async () => {
      const candidate = fixture.candidates[0]?.registry;
      observed = {
        registry: candidate !== undefined && fixture.registryOwner.registry === candidate,
        claim: fixture.owner.currentClaim() !== claimBefore,
        snapshot: fixture.runtime.pluginMetadataSnapshot !== snapshotBefore,
        logged: mocks.log.info.mock.calls.some(
          ([message]) => message === "Plugin replacement applied: first",
        ),
      };
    },
  });
  const claimBefore = fixture.owner.currentClaim();
  const snapshotBefore = fixture.runtime.pluginMetadataSnapshot;

  await fixture.reload();

  expect(observed).toEqual({ registry: true, claim: true, snapshot: true, logged: true });
});

it("keeps the previous registry object when the operation is superseded before old owners stop", async () => {
  let superseded = false;
  const fixture = await createFixture({
    prepareConfigEffects: () => {
      superseded = true;
      return { retire: () => {}, rollback: async () => {} };
    },
  });
  const claimBefore = fixture.owner.currentClaim();
  const snapshotBefore = fixture.runtime.pluginMetadataSnapshot;

  const result = await fixture
    .reload(fixture.getConfig(), ["first"], [], { isAborted: () => superseded })
    .catch((error: unknown) => error);

  assert(result instanceof PluginRuntimeApplicationError);
  expect(result.details).toMatchObject({ phase: "drain", committed: false });
  expect(isConfigReloadSuperseded(result)).toBe(true);
  expect(fixture.candidates).toHaveLength(0);
  expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
  expect(fixture.owner.currentClaim()).toBe(claimBefore);
  expect(fixture.runtime.pluginMetadataSnapshot).toBe(snapshotBefore);
  expect(fixture.firstStop).not.toHaveBeenCalled();
  expect(fixture.firstStart).toHaveBeenCalledOnce();
});

it.each(["superseded", "invoker closed", "commit failed"] as const)(
  "retires a staged candidate without publishing it when %s before publication",
  async (boundary) => {
    let closed = false;
    const commitFailure = new Error("commit owner refused publication");
    const fixture = await createFixture({
      beforePublish: async () => {
        if (boundary === "commit failed") {
          throw commitFailure;
        }
        closed = true;
      },
      assertInvokerOwned: () => {
        if (boundary === "invoker closed" && closed) {
          throw new Error("invoker closed");
        }
      },
    });
    const claimBefore = fixture.owner.currentClaim();
    const snapshotBefore = fixture.runtime.pluginMetadataSnapshot;
    const retainedSibling = fixture.previousRegistry.plugins.find(
      (record) => record.id === "sibling",
    );

    const result = await fixture
      .reload(fixture.getConfig(), ["first"], [], {
        isAborted: () => boundary === "superseded" && closed,
      })
      .catch((error: unknown) => error);

    assert(result instanceof PluginRuntimeApplicationError);
    expect(result.details).toMatchObject({ phase: "activate", committed: false });
    expect(isConfigReloadSuperseded(result)).toBe(boundary === "superseded");
    if (boundary === "commit failed") {
      expect(result.cause).toBe(commitFailure);
    }
    // The candidate was fully staged (loaded and started), then retired unpublished.
    expect(fixture.candidates).toHaveLength(1);
    const candidate = fixture.candidates[0]!.registry;
    const candidateFirst = candidate.plugins.find((record) => record.id === "first");
    assert(candidateFirst);
    expect(fixture.candidateStop).toHaveBeenCalledOnce();
    expect(getPluginInstance(candidateFirst)?.acceptingCalls).toBe(false);
    expect(fixture.registryOwner.registry).not.toBe(candidate);
    expect(fixture.owner.currentClaim()).toBe(claimBefore);
    expect(fixture.runtime.pluginMetadataSnapshot).toBe(snapshotBefore);
    // Stopped owners cannot reopen, so recovery re-registers the captured old code; the
    // untouched sibling keeps serving from the same record.
    expect(fixture.firstStart).toHaveBeenCalledTimes(2);
    expect(fixture.registryOwner.registry.plugins).toContain(retainedSibling);
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    expect(fixture.owner.getReloadStatus()).toBeUndefined();
  },
);
