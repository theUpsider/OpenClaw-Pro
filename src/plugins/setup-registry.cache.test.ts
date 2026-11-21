import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resetPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolvePluginSetupProviderCore, resolvePluginSetupRegistry } from "./setup-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const COUNTS_KEY = "__openclawSetupRegistryCacheTestCounts";
type SetupCounts = { evaluations: number; registrations: number };
const counts = () =>
  ((globalThis as Record<string, unknown>)[COUNTS_KEY] ??= {}) as Record<string, SetupCounts>;
const countsFor = (key: string) => counts()[key] ?? { evaluations: 0, registrations: 0 };

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginCache();
  delete (globalThis as Record<string, unknown>)[COUNTS_KEY];
  cleanupTrackedTempDirs(tempDirs);
});

// Each fixture counts its own module evaluations and register() calls in a process global,
// so the assertions observe real setup execution rather than registry equality.
function writeSetupFixture(
  id: string,
  options: { counter?: string; label?: string; register?: string; topLevel?: string } = {},
) {
  const rootDir = fs.realpathSync(makeTrackedTempDir("setup-registry-cache", tempDirs));
  const source = path.join(rootDir, "setup-api.cjs");
  const counter = JSON.stringify(options.counter ?? id);
  fs.writeFileSync(
    source,
    `const all = (globalThis[${JSON.stringify(COUNTS_KEY)}] ??= {});
    const own = (all[${counter}] ??= { evaluations: 0, registrations: 0 });
    own.evaluations += 1;
    ${options.topLevel ?? ""}
    module.exports = { id: ${JSON.stringify(id)}, register(api) {
      own.registrations += 1;
      api.registerProvider({
        id: ${JSON.stringify(id)},
        label: ${JSON.stringify(options.label ?? "Fixture")},
        envVars: ["FIXTURE_API_KEY"],
        auth: [],
      });
      ${options.register ?? ""}
    } };`,
  );
  return {
    id,
    origin: "config",
    rootDir,
    source,
    setupSource: source,
    providers: [id],
    setup: { requiresRuntime: true, providers: [{ id }] },
  } satisfies Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">;
}

function publish(...plugins: ReturnType<typeof writeSetupFixture>[]): PluginMetadataSnapshot {
  const snapshot = createPluginMetadataSnapshotFixture({ plugins });
  setCurrentPluginMetadataSnapshot(snapshot);
  return snapshot;
}

function canonical(snapshot: PluginMetadataSnapshot, id: string): PluginManifestRecord {
  const record = snapshot.manifestRegistry.plugins.find((plugin) => plugin.id === id);
  if (!record) {
    throw new Error(`fixture snapshot lacks ${id}`);
  }
  return record;
}

// The shape resolveSetupRegistryForManifestOwner builds for every provider lookup.
function lookupOwner(record: PluginManifestRecord, env?: NodeJS.ProcessEnv) {
  return resolvePluginSetupRegistry({
    manifestRegistry: { plugins: [record], diagnostics: [] },
    ...(env ? { env } : {}),
  });
}

describe("setup registry result cache for caller-supplied manifest records", () => {
  it("executes a provider's setup registration once across repeated owner lookups", () => {
    publish(writeSetupFixture("cached-owner"));

    for (let lookup = 0; lookup < 5; lookup += 1) {
      expect(resolvePluginSetupProviderCore({ provider: "cached-owner" })?.id).toBe("cached-owner");
    }

    expect(countsFor("cached-owner")).toEqual({ evaluations: 1, registrations: 1 });
  });

  it("serves the same cached registration to a fresh single-record wrapper", () => {
    const snapshot = publish(writeSetupFixture("wrapped-owner"));
    const record = canonical(snapshot, "wrapped-owner");

    expect(resolvePluginSetupProviderCore({ provider: "wrapped-owner" })?.id).toBe("wrapped-owner");
    for (let lookup = 0; lookup < 3; lookup += 1) {
      expect(lookupOwner(record).providers.map((entry) => entry.provider.id)).toEqual([
        "wrapped-owner",
      ]);
    }

    expect(countsFor("wrapped-owner").registrations).toBe(1);
  });

  it("isolates callers from mutations of returned registries", () => {
    const snapshot = publish(writeSetupFixture("isolated-owner"));
    const record = canonical(snapshot, "isolated-owner");

    const mutate = () => {
      const provider = lookupOwner(record).providers[0]?.provider;
      expect(provider?.envVars).toEqual(["FIXTURE_API_KEY"]);
      provider?.envVars?.push("MUTATED");
      if (provider) {
        provider.label = "mutated";
      }
    };
    mutate(); // miss: the caller owns the freshly built registry
    mutate(); // hit: the caller owns a clone of the cached registry

    expect(lookupOwner(record).providers[0]?.provider).toMatchObject({
      label: "Fixture",
      envVars: ["FIXTURE_API_KEY"],
    });
    expect(countsFor("isolated-owner").registrations).toBe(1);
  });

  it("invalidates when the current metadata snapshot is replaced", () => {
    const fixture = writeSetupFixture("replaced-snapshot");
    const first = publish(fixture);
    const previous = canonical(first, "replaced-snapshot");
    lookupOwner(previous);
    lookupOwner(previous);
    expect(countsFor("replaced-snapshot").registrations).toBe(1);

    const second = publish(fixture);
    lookupOwner(canonical(second, "replaced-snapshot"));
    lookupOwner(canonical(second, "replaced-snapshot"));
    expect(countsFor("replaced-snapshot").registrations).toBe(2);

    // A record of the retired snapshot is no longer canonical, so it never reuses a result.
    lookupOwner(previous);
    lookupOwner(previous);
    expect(countsFor("replaced-snapshot").registrations).toBe(4);
  });

  it("does not serve a cached result to a replacement record with the same plugin id", () => {
    const original = writeSetupFixture("same-id", { counter: "original", label: "Original" });
    const replacement = writeSetupFixture("same-id", {
      counter: "replacement",
      label: "Replacement",
    });
    const snapshot = publish(original);
    const record = canonical(snapshot, "same-id");
    expect(lookupOwner(record).providers[0]?.provider.label).toBe("Original");
    expect(lookupOwner(record).providers[0]?.provider.label).toBe("Original");

    const replaced: PluginManifestRecord = { ...record, ...replacement };
    expect(lookupOwner(replaced).providers[0]?.provider.label).toBe("Replacement");
    expect(lookupOwner(replaced).providers[0]?.provider.label).toBe("Replacement");

    expect(countsFor("original").registrations).toBe(1);
    expect(countsFor("replacement").registrations).toBe(2);
  });

  it("keeps results inside the plugin cache instance that registered them", () => {
    const snapshot = publish(writeSetupFixture("cache-owner"));
    const record = canonical(snapshot, "cache-owner");
    lookupOwner(record);
    lookupOwner(record);
    expect(countsFor("cache-owner").registrations).toBe(1);

    resetPluginCache();
    setCurrentPluginMetadataSnapshot(snapshot);
    lookupOwner(record);
    lookupOwner(record);
    expect(countsFor("cache-owner").registrations).toBe(2);
  });

  it("bypasses the cache when the caller supplies its own env", () => {
    const snapshot = publish(writeSetupFixture("caller-env"));
    const record = canonical(snapshot, "caller-env");
    const env = { ...process.env };

    lookupOwner(record, env);
    lookupOwner(record, env);

    expect(countsFor("caller-env").registrations).toBe(2);
  });

  it("bypasses the cache for structurally equal records that are not snapshot records", () => {
    const snapshot = publish(writeSetupFixture("foreign-record"));
    const record = canonical(snapshot, "foreign-record");

    lookupOwner({ ...record });
    lookupOwner(structuredClone(record));
    lookupOwner(record);
    lookupOwner({ ...record });

    expect(countsFor("foreign-record").registrations).toBe(4);
  });

  it("caches a failed setup load with its diagnostic, never as a provider", () => {
    const snapshot = publish(
      writeSetupFixture("broken-load", { topLevel: 'throw new Error("setup load broke");' }),
    );
    const record = canonical(snapshot, "broken-load");

    for (let lookup = 0; lookup < 3; lookup += 1) {
      expect(resolvePluginSetupProviderCore({ provider: "broken-load" })).toBeUndefined();
      const result = lookupOwner(record);
      expect(result.providers).toEqual([]);
      expect(result.diagnostics).toMatchObject([
        {
          pluginId: "broken-load",
          code: "setup-entry-load-failed",
          message: expect.stringContaining("setup load broke"),
        },
      ]);
    }
    expect(countsFor("broken-load").evaluations).toBe(1);
  });

  it("caches a throwing registration with its diagnostic and without partial contributions", () => {
    const snapshot = publish(
      writeSetupFixture("partial-register", {
        register: `api.registerCliBackend({ id: "partial-cli", config: { command: "partial" } });
          throw new Error("registration broke");`,
      }),
    );
    const record = canonical(snapshot, "partial-register");

    for (let lookup = 0; lookup < 3; lookup += 1) {
      expect(resolvePluginSetupProviderCore({ provider: "partial-register" })).toBeUndefined();
      const result = lookupOwner(record);
      expect(result.providers).toEqual([]);
      expect(result.cliBackends).toEqual([]);
      expect(result.diagnostics).toMatchObject([
        {
          pluginId: "partial-register",
          code: "setup-registration-failed",
          message: expect.stringContaining("registration broke"),
        },
      ]);
    }
    expect(countsFor("partial-register").registrations).toBe(1);
  });

  it("keeps distinct record sequences distinct within one owner and snapshot", () => {
    const first = writeSetupFixture("seq-a", { label: "A" });
    const second = writeSetupFixture("seq-b", { label: "Seq" });
    const snapshot = publish(first, second);
    const a = canonical(snapshot, "seq-a");
    const b = canonical(snapshot, "seq-b");

    const lookup = (records: PluginManifestRecord[]) =>
      resolvePluginSetupRegistry({ manifestRegistry: { plugins: records, diagnostics: [] } });

    // A constant key would serve one sequence's result for all four shapes below.
    expect(lookup([a]).providers.map((entry) => entry.pluginId)).toEqual(["seq-a"]);
    expect(lookup([b]).providers.map((entry) => entry.pluginId)).toEqual(["seq-b"]);
    expect(lookup([a, b]).providers.map((entry) => entry.pluginId)).toEqual(["seq-a", "seq-b"]);
    expect(lookup([b, a]).providers.map((entry) => entry.pluginId)).toEqual(["seq-b", "seq-a"]);

    // Repeats of an already-seen sequence still hit the cache.
    expect(lookup([a]).providers.map((entry) => entry.pluginId)).toEqual(["seq-a"]);
    expect(lookup([b, a]).providers.map((entry) => entry.pluginId)).toEqual(["seq-b", "seq-a"]);

    // Three distinct sequences exist ([a], [b], [a,b], [b,a]); the repeats above hit.
    // seq-a therefore registers in [a], [a,b] and [b,a], and seq-b in [b], [a,b] and [b,a].
    expect(countsFor("seq-a").registrations).toBe(3);
    expect(countsFor("seq-b").registrations).toBe(3);
  });

  it("does not confuse an explicit empty inventory with the implicit inventory", () => {
    publish(writeSetupFixture("empty-vs-implicit", { label: "Implicit" }));

    const explicitEmpty = resolvePluginSetupRegistry({
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    expect(explicitEmpty.providers).toEqual([]);

    // The implicit path still builds the snapshot's own records.
    const implicit = resolvePluginSetupRegistry();
    expect(implicit.providers.map((entry) => entry.pluginId)).toEqual(["empty-vs-implicit"]);
    expect(countsFor("empty-vs-implicit").registrations).toBe(1);
  });
});
