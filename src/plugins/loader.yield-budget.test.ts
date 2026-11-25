import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_YIELD_BUDGET_MS } from "../infra/yield-budget.js";
import { isPluginRegistryLoadInFlight } from "./loader-cache.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadOpenClawPlugins, loadOpenClawPluginsAsync } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});

type K1TestGlobals = { __k1Registered?: string[]; __k1Clock?: { value: number } };
const testGlobals = globalThis as K1TestGlobals;

afterEach(() => {
  delete testGlobals.__k1Registered;
  delete testGlobals.__k1Clock;
});

/** Each plugin's registration body runs when its candidate step loads the module. */
function writeInventory(registrations: Record<string, string>): PluginLoadOptions {
  useNoBundledPlugins();
  const plugins = Object.entries(registrations).map(([id, registration]) =>
    writePlugin({ id, registration }),
  );
  return {
    config: {
      plugins: {
        allow: plugins.map((plugin) => plugin.id),
        load: { paths: plugins.map((plugin) => plugin.file) },
        slots: { memory: "none" },
        entries: Object.fromEntries(plugins.map((plugin) => [plugin.id, { enabled: true }])),
      },
    },
    activate: false,
    cache: false,
  };
}

function writePreflightInventory(count: number): PluginLoadOptions {
  return {
    ...writeInventory(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`yield-budget-${index}`, ""]),
      ),
    ),
    // Gateway replacement preflight: no candidate attempts a module load.
    loadModules: false,
  };
}

/** Counts event-loop turns that complete while `run` is still pending. */
async function countTurnsDuring<T>(run: () => Promise<T>): Promise<{ value: T; turns: number }> {
  let turns = 0;
  let settled = false;
  const observe = () => {
    if (!settled) {
      turns++;
      setImmediate(observe);
    }
  };
  setImmediate(observe);
  try {
    return { value: await run(), turns };
  } finally {
    settled = true;
  }
}

it("returns to the event loop during a metadata-only generation run once each turn's budget is spent", async () => {
  const options = writePreflightInventory(4);
  const expected = loadOpenClawPlugins(options).plugins.map((plugin) => [plugin.id, plugin.status]);
  // Every clock read reports a spent budget, so every candidate boundary must yield.
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += DEFAULT_YIELD_BUDGET_MS));

  const { value: registry, turns } = await countTurnsDuring(() =>
    loadOpenClawPluginsAsync(options),
  );

  // Candidates were previously one unbroken turn because none attempted a module load.
  expect(turns).toBeGreaterThanOrEqual(4);
  expect(registry.plugins.map((plugin) => [plugin.id, plugin.status])).toEqual(expected);
});

it("stops a cancelled generation run at its next step boundary and releases the load slot", async () => {
  const registered: string[] = [];
  testGlobals.__k1Registered = registered;
  const controller = new AbortController();
  const options: PluginLoadOptions = {
    ...writeInventory(
      Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [
          `yield-cancel-${index}`,
          `globalThis.__k1Registered.push(${JSON.stringify(`yield-cancel-${index}`)});`,
        ]),
      ),
    ),
    signal: controller.signal,
  };
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += DEFAULT_YIELD_BUDGET_MS));
  const reason = new Error("replacement drain cancelled");
  // Runs in the first turn the run gives back, while it is parked at a step boundary.
  setImmediate(() => controller.abort(reason));

  await expect(loadOpenClawPluginsAsync(options)).rejects.toBe(reason);

  // No candidate registered after the abort, and the generator's finally released its slot.
  expect(registered).toEqual([]);
  expect(isPluginRegistryLoadInFlight(options)).toBe(false);
});

it.each([
  { slowMs: 499, warned: false },
  { slowMs: 600, warned: true },
])(
  "names a step the budget cannot split once it reaches 500 ms ($slowMs ms)",
  async ({ slowMs, warned }) => {
    const clock = { value: 0 };
    testGlobals.__k1Clock = clock;
    const warn = vi.fn();
    const options: PluginLoadOptions = {
      ...writeInventory({
        "yield-quick": "",
        "yield-slow": `globalThis.__k1Clock.value += ${slowMs};`,
        "yield-after": "",
      }),
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    };
    vi.spyOn(performance, "now").mockImplementation(() => clock.value);

    const registry = await loadOpenClawPluginsAsync(options);

    expect(registry.plugins.map((plugin) => plugin.status)).toEqual(["loaded", "loaded", "loaded"]);
    expect(warn.mock.calls).toEqual(
      warned
        ? [
            [
              `[plugins] generation run held the event loop for 1 step(s) >= 500ms; longest ${slowMs}ms at yield-slow`,
            ],
          ]
        : [],
    );
  },
);

it("keeps a generation run within budget in one turn", async () => {
  const options = writePreflightInventory(4);
  vi.spyOn(performance, "now").mockReturnValue(0);

  const { value: registry, turns } = await countTurnsDuring(() =>
    loadOpenClawPluginsAsync(options),
  );

  expect(turns).toBe(0);
  expect(registry.plugins).toHaveLength(4);
});
