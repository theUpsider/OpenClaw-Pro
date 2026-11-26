import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/io.js";
import { getPluginRuntimeGeneration } from "../plugins/lifecycle.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { clearActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
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

const scanMetadata = (
  description?: string,
  revision?: Partial<PluginMetadataSnapshot["index"]["plugins"][number]>,
) => {
  const snapshot = Object.assign(
    createPluginMetadataSnapshotFixture({
      plugins: [{ id: "first", ...(description ? { description } : {}) }, { id: "sibling" }],
    }),
    { discovery: { candidates: [], diagnostics: [] } },
  );
  if (revision) {
    // Installed-index revision facts only; manifest fields and policy stay identical.
    snapshot.index = {
      ...snapshot.index,
      plugins: snapshot.index.plugins.map((plugin) =>
        plugin.pluginId === "first" ? { ...plugin, ...revision } : plugin,
      ),
    };
  }
  return snapshot;
};

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  mocks.resolveConfigWidePluginMetadataSnapshot.mockImplementation(() => scanMetadata());
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

async function createFixture() {
  return createPluginReloadRecoveryFixture(
    { cleanups, logMocks: mocks.log },
    { abortOnCandidateStart: false, pluginMetadataSnapshot: scanMetadata() },
  );
}

it("keeps the live generation for an id-less lifecycle request over identical config and metadata", async () => {
  const fixture = await createFixture();
  const generation = getPluginRuntimeGeneration();

  const result = await fixture.reload(fixture.getConfig(), [], []);

  expect(result.runtime).toMatchObject({ generation, pluginIds: [] });
  expect(fixture.candidates).toHaveLength(0);
  expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
  expect(fixture.firstStop).not.toHaveBeenCalled();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
  expect(fixture.runtime.broadcast).not.toHaveBeenCalled();
  expect(fixture.owner.getReloadStatus()).toBeUndefined();
  expect(mocks.log.info).toHaveBeenCalledWith(
    "plugin metadata unchanged; kept the current plugin generation",
  );
});

it("still replaces an explicitly requested plugin when metadata is identical", async () => {
  const fixture = await createFixture();

  const result = await fixture.reload(fixture.getConfig(), ["first"], []);

  expect(result.runtime.pluginIds).toEqual(["first"]);
  expect(fixture.candidates).toHaveLength(1);
  expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
  expect(fixture.firstStop).toHaveBeenCalledOnce();
});

// Matched load: one fixture, one identical id-less request; only the scanned input differs.
// A skipped run proves nothing about loader cost, so a changed input must run a real load.
it("runs a real generation load for the same id-less request only when its metadata genuinely changed", async () => {
  const fixture = await createFixture();
  const request = () => fixture.reload(fixture.getConfig(), [], []);
  const generation = getPluginRuntimeGeneration();

  const kept = "plugin metadata unchanged; kept the current plugin generation";
  const keptCount = () => mocks.log.info.mock.calls.filter(([message]) => message === kept).length;

  // Skipped: the request over unchanged input, and over a config edit plugins do not depend on.
  await request();
  await fixture.reload(
    { ...fixture.getConfig(), agents: { defaults: { model: "openai/gpt-5.6-sol" } } },
    [],
    [],
  );
  expect(fixture.candidates).toHaveLength(0);
  expect(getPluginRuntimeGeneration()).toBe(generation);
  expect(keptCount()).toBe(2);

  mocks.resolveConfigWidePluginMetadataSnapshot.mockImplementation(() =>
    scanMetadata("rebuilt description"),
  );
  await request();

  expect(fixture.candidates).toHaveLength(1);
  expect(getPluginRuntimeGeneration()).toBeGreaterThan(generation);
  expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
  expect(fixture.runtime.pluginMetadataSnapshot?.plugins[0]?.description).toBe(
    "rebuilt description",
  );
  expect(keptCount()).toBe(2);
});

it.each([
  [
    "a rebuilt package",
    { packageVersion: "1.0.1", packageJson: { path: "/p/package.json", hash: "rebuilt" } },
  ],
  ["a reinstalled artifact", { installRecordHash: "reinstalled" }],
] as const)(
  "does not keep the live generation over %s with identical manifest and config",
  async (_label, revision) => {
    const fixture = await createFixture();
    const generation = getPluginRuntimeGeneration();
    mocks.resolveConfigWidePluginMetadataSnapshot.mockImplementation(() =>
      scanMetadata(undefined, revision),
    );

    await fixture.reload(fixture.getConfig(), [], []);

    expect(fixture.candidates).toHaveLength(1);
    expect(getPluginRuntimeGeneration()).toBeGreaterThan(generation);
    expect(mocks.log.info).not.toHaveBeenCalledWith(
      "plugin metadata unchanged; kept the current plugin generation",
    );
  },
);
