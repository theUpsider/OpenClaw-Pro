import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginRuntimeApplication } from "./lifecycle.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import { createPluginRecord } from "./status.test-helpers.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const instances: PluginInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0).toReversed()) {
    await instance.dispose();
  }
});

function bindConfigInstance(rootDir: string, entry: string, origin: PluginRecord["origin"]) {
  const record = createPluginRecord({
    id: "probe",
    origin,
    status: "loaded",
    rootDir,
    source: entry,
  });
  const registry = { plugins: [record] } as unknown as PluginRegistry;
  const instance = new PluginInstance(record.id, { record, registry });
  instances.push(instance);
  withPluginCache(createPluginCache(), () =>
    bindPluginInstanceModuleLoader({ instance, origin, source: entry, rootDir }),
  );
  instance.loadModule(entry);
  return { record, registry, instance };
}

const ENTRY_V1 = "export const value = 1;\nexport const register = () => {};\n";

describe("plugin runtime application restart honesty", () => {
  it("does not require a restart when a config plugin's live code matches disk", () => {
    const root = temp.make("receipt-config-match-");
    const entry = path.join(root, "index.ts");
    fs.writeFileSync(entry, ENTRY_V1);
    const { record, registry } = bindConfigInstance(root, entry, "config");
    const receipt = createPluginRuntimeApplication({
      operationId: "op",
      generation: 2,
      registry,
      pluginIds: new Set([record.id]),
      reloadPluginIds: new Set([record.id]),
      warnings: [],
    });
    expect(receipt.restartRequired ?? false).toBe(false);
    expect(receipt.warnings ?? []).toEqual([]);
  });

  it("reports restartRequired when a config plugin's live code is stale", () => {
    const root = temp.make("receipt-config-stale-");
    const entry = path.join(root, "index.ts");
    fs.writeFileSync(entry, ENTRY_V1);
    const { record, registry } = bindConfigInstance(root, entry, "config");
    // The running owner retained its generation; the file changed underneath it.
    fs.writeFileSync(entry, `${ENTRY_V1}// edited without replacing the live owner\n`);
    const receipt = createPluginRuntimeApplication({
      operationId: "op",
      generation: 2,
      registry,
      pluginIds: new Set([record.id]),
      reloadPluginIds: new Set([record.id]),
      warnings: [],
    });
    expect(receipt.restartRequired).toBe(true);
    expect((receipt.warnings ?? []).join(" ")).toContain("not the current source on disk");
  });

  it("leaves unrelated (non-reloaded) plugin ids alone", () => {
    const root = temp.make("receipt-config-scope-");
    const entry = path.join(root, "index.ts");
    fs.writeFileSync(entry, ENTRY_V1);
    const { record, registry } = bindConfigInstance(root, entry, "config");
    fs.writeFileSync(entry, `${ENTRY_V1}// edited\n`);
    const receipt = createPluginRuntimeApplication({
      operationId: "op",
      generation: 2,
      registry,
      pluginIds: new Set([record.id]),
      // No reload for this id: an unrelated operation must not brand it.
      warnings: [],
    });
    expect(receipt.restartRequired ?? false).toBe(false);
  });
});
