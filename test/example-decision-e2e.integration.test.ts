import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import exampleEntry from "../extensions/example/index.js";
import {
  createLobsterRegistry,
  type DecisionEvaluator,
} from "../extensions/lobster/test-api.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  evaluateDecisionInRegistry,
  prepareDecisionProviderReload,
} from "../src/decisions/runtime.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { runPluginRegisterSyncInRegistry } from "../src/plugins/loader-module-runtime.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";

/**
 * End-to-end: a real Lobster workflow branches on a typed decision answered by ds41.
 *
 * Chain under test (nothing on the decision path is mocked):
 *   lobster engine -> decision.evaluate bridge -> host DecisionRuntimeV1
 *     (evaluateDecisionInRegistry) -> registry-adopted provider (the plugin's own
 *     `example` entry) -> the real loopback ds41 endpoint.
 *
 * Two DIFFERENT live ds41 answers must drive DIFFERENT branches (A vs B); an
 * unavailable decision layer (dead endpoint) and a mis-pinned model must drive
 * NEITHER. Opt-in: the live endpoint is required, so this is gated on
 * EXAMPLE_LIVE_TEST=1 and skipped otherwise.
 */

type LobsterCore = {
  createDefaultRegistry: () => Parameters<typeof createLobsterRegistry>[0];
  runWorkflowFile: (params: {
    filePath: string;
    ctx?: Record<string, unknown>;
  }) => Promise<{ status: string; output: unknown[] }>;
};

async function loadCore(): Promise<LobsterCore> {
  // The engine ships inside the lobster extension's own dependency tree; resolve
  // it from that package root rather than from this test's directory.
  const lobsterRequire = createRequire(
    path.join(process.cwd(), "extensions", "lobster", "package.json"),
  );
  const specifier = ["@clawdbot", "lobster", "core"].join("/");
  return (await import(pathToFileURL(lobsterRequire.resolve(specifier)).href)) as LobsterCore;
}

const live = process.env.EXAMPLE_LIVE_TEST === "1" ? describe : describe.skip;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const ENDPOINT = "http://127.0.0.1:8011";
const DEAD_ENDPOINT = "http://127.0.0.1:8099";
const PINNED = "example/ds41-314113f8";

const QUESTION = JSON.stringify({
  escalate: {
    type: "boolean",
    instructions: "Does this evidence require immediate human incident response?",
    criteria: {
      true: "A serious service incident needs human attention now",
      false: "Routine handling is sufficient",
    },
  },
});

function config(baseUrl: string, model = PINNED): OpenClawConfig {
  return {
    agents: { defaults: { decisionModel: model } },
    plugins: { entries: { example: { enabled: true, config: { baseUrl, timeoutMs: 60000 } } } },
  };
}

/** Register the real `example` plugin entry and bind the host decision runtime to it. */
function bindExample(cfg: OpenClawConfig): DecisionEvaluator {
  // The provider reads its config from the host runtime snapshot; the mock must
  // carry the same config the registry selection is derived from.
  const builder = createTestPluginRegistry(
    createPluginRuntimeMock({ config: { current: () => cfg } }),
  );
  const record = createPluginRecord({
    id: "example",
    source: "/bundled/example/index.ts",
    origin: "bundled",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: ["example"] },
  });
  const api = builder.createApi(record, { config: cfg });
  runPluginRegisterSyncInRegistry(
    (registration) => exampleEntry.register(registration),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  onTestFinished(async () => {
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  return (batch, options) => evaluateDecisionInRegistry(batch, options, builder.registry, cfg);
}

/**
 * Run a real Lobster workflow whose decision step resolves a route and whose two
 * following steps each write their own letter when their condition matches. The
 * returned `markers` is the exact set of branches that actually ran.
 */
async function runRoute(params: {
  evaluator: DecisionEvaluator;
  state: string;
  markerName: string;
}): Promise<{ threw: boolean; markers: string }> {
  const core = await loadCore();
  const dir = tempDirs.make("example-lobster-e2e-");
  const workflowPath = path.join(dir, "route.lobster");
  // Keep the marker inside the tracker-managed temp dir so it is cleaned up with the run.
  const markerPath = path.join(dir, params.markerName);
  writeFileSync(
    workflowPath,
    JSON.stringify({
      name: "example-route",
      steps: [
        {
          id: "route",
          pipeline: `decision.evaluate --questions-json '${QUESTION}' --state-json '${params.state}' --min-probability 0.7`,
        },
        {
          id: "branch-b",
          command: `echo B >> ${markerPath}`,
          condition: "$route.json.route == 'false'",
        },
        {
          id: "branch-a",
          command: `echo A >> ${markerPath}`,
          condition: "$route.json.route == 'true'",
        },
      ],
    }),
  );
  const registry = createLobsterRegistry(core.createDefaultRegistry(), {
    evaluate: params.evaluator,
    agentId: "main",
    purpose: "example-e2e",
  });
  const ctx = {
    cwd: dir,
    env: { ...process.env, LOBSTER_STATE_DIR: path.join(dir, "state") },
    mode: "tool",
    stdout: { write: () => true },
    stderr: { write: () => true },
    registry,
  };
  rmSync(markerPath, { force: true });
  let threw = false;
  let error: string | undefined;
  try {
    await core.runWorkflowFile({ filePath: workflowPath, ctx });
  } catch (caught) {
    threw = true;
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }
  const markers = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
  if (error) {
    console.log(JSON.stringify({ e2e: "route-error", error }));
  }
  return { threw, markers };
}

live("example decision provider end-to-end through a real Lobster workflow", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
  });

  it("routes two different ds41 answers to different branches (A vs B)", async () => {
    const cfg = config(ENDPOINT);
    setRuntimeConfigSnapshot(cfg);
    const evaluator = bindExample(cfg);
    const outage = await runRoute({
      evaluator,
      state: '{"message":"Checkout is failing for all customers right now."}',
      markerName: "outage.txt",
    });
    const routine = await runRoute({
      evaluator,
      state: '{"message":"Please update my billing address for next month."}',
      markerName: "routine.txt",
    });
    console.log(
      JSON.stringify({
        e2e: "route",
        outage: { threw: outage.threw, markers: outage.markers },
        routine: { threw: routine.threw, markers: routine.markers },
      }),
    );
    // Both runs resolved a route: no rejection, exactly one branch each.
    expect(outage.threw).toBe(false);
    expect(routine.threw).toBe(false);
    expect(["A", "B"]).toContain(outage.markers);
    expect(["A", "B"]).toContain(routine.markers);
    // The two different live answers must drive different branches.
    expect(outage.markers).not.toBe(routine.markers);
  });

  it("runs no branch when the decision layer is unavailable (dead endpoint)", async () => {
    const cfg = config(DEAD_ENDPOINT);
    setRuntimeConfigSnapshot(cfg);
    const evaluator = bindExample(cfg);
    const result = await runRoute({
      evaluator,
      state: '{"message":"Checkout is failing for all customers right now."}',
      markerName: "down.txt",
    });
    console.log(JSON.stringify({ e2e: "outage", ...result }));
    expect(result.threw).toBe(true);
    expect(result.markers).toBe("");
  });

  it("runs no branch when the configured model is not the pinned revision", async () => {
    const cfg = config(ENDPOINT, "example/some-other-model");
    setRuntimeConfigSnapshot(cfg);
    const evaluator = bindExample(cfg);
    const result = await runRoute({
      evaluator,
      state: '{"message":"Checkout is failing for all customers right now."}',
      markerName: "mispin.txt",
    });
    expect(result.threw).toBe(true);
    expect(result.markers).toBe("");
  });
});
