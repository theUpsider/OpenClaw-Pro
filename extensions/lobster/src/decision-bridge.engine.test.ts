import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLobsterRegistry,
  type DecisionEvaluator,
  type LobsterRegistry,
} from "./decision-bridge.js";

/**
 * Engine-level regression: a decision rejection must survive a step's own `on_error`/`retry`.
 *
 * This drives the REAL `@clawdbot/lobster/core` engine (the same module the plugin loads at
 * runtime), because the failure mode lives in the engine's error handling, not in the command:
 * `on_error: continue` swallows an ordinary throw and lets a later *negated* condition run on a
 * route that was never resolved. Only a halted stage is rethrown before `on_error` applies.
 */

type CoreModule = {
  createDefaultRegistry: () => LobsterRegistry;
  runWorkflowFile: (params: {
    filePath: string;
    ctx?: Record<string, unknown>;
  }) => Promise<{ status: string; output: unknown[] }>;
};

async function loadCore(): Promise<CoreModule> {
  const specifier = ["@clawdbot", "lobster", "core"].join("/");
  return (await import(specifier)) as CoreModule;
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runWorkflow(params: {
  evaluate: DecisionEvaluator;
  stepExtra: Record<string, unknown>;
  markerPath: string;
}): Promise<{ threw: boolean; branchRan: boolean; evaluatorCalls: number }> {
  const core = await loadCore();
  const dir = tempDirs.make("openclaw-lobster-bridge-");
  const workflowPath = path.join(dir, "route.lobster");
  const questions = JSON.stringify({ r: { type: "boolean" } });
  writeFileSync(
    workflowPath,
    JSON.stringify({
      name: "bridge-fail-closed",
      steps: [
        {
          id: "route",
          pipeline: `decision.evaluate --questions-json '${questions}' --state-json '{}' --min-probability 0.9`,
          ...params.stepExtra,
        },
        {
          id: "later",
          command: `echo ran >> ${params.markerPath}`,
          // A negated condition is the dangerous form: it can fire on a step that never
          // produced a route at all.
          condition: "$route.json.route != 'true'",
        },
      ],
    }),
  );
  const calls = { count: 0 };
  const registry = createLobsterRegistry(core.createDefaultRegistry(), {
    evaluate: (...args) => {
      calls.count += 1;
      return params.evaluate(...args);
    },
    agentId: "main",
    purpose: "test",
  });
  const ctx = {
    cwd: dir,
    env: { ...process.env, LOBSTER_STATE_DIR: path.join(dir, "state") },
    mode: "tool",
    stdout: { write: () => true },
    stderr: { write: () => true },
    registry,
  };
  rmSync(params.markerPath, { force: true });
  try {
    await core.runWorkflowFile({ filePath: workflowPath, ctx });
  } catch {
    return { threw: true, branchRan: markerRan(params.markerPath), evaluatorCalls: calls.count };
  }
  return { threw: false, branchRan: markerRan(params.markerPath), evaluatorCalls: calls.count };
}

function markerRan(markerPath: string): boolean {
  if (!existsSync(markerPath)) {
    return false;
  }
  return readFileSync(markerPath, "utf8").length > 0;
}

const unavailable: DecisionEvaluator = async () => ({ status: "unavailable", reason: "transport" });
const answer =
  (probabilityTrue: number): DecisionEvaluator =>
  async () => ({
    status: "ok",
    result: { model: "fixture", answers: { r: { type: "boolean", probabilityTrue } } },
    provenance: { providerId: "fixture", rubricVersion: "r", runtimeGeneration: "g" },
  });

describe("decision bridge fail-closed through the real engine", () => {
  const markerPath = path.join(tmpdir(), `openclaw-lobster-bridge-marker-${process.pid}.txt`);

  it("keeps an unavailable decision terminal under on_error: continue", async () => {
    const outcome = await runWorkflow({
      evaluate: unavailable,
      stepExtra: { on_error: "continue" },
      markerPath,
    });
    expect(outcome.threw).toBe(true);
    expect(outcome.branchRan).toBe(false);
  });

  it("keeps an ambiguous answer terminal under retry", async () => {
    const outcome = await runWorkflow({
      evaluate: answer(0.5),
      stepExtra: { retry: { max: 3, delay_ms: 10 } },
      markerPath,
    });
    expect(outcome.threw).toBe(true);
    expect(outcome.branchRan).toBe(false);
    // A retried decision would be a second evaluation of the same state; the halt must suppress
    // the retry entirely, so the evaluator is called exactly once.
    expect(outcome.evaluatorCalls).toBe(1);
  });

  it("keeps an unavailable decision terminal under retry", async () => {
    const outcome = await runWorkflow({
      evaluate: unavailable,
      stepExtra: { retry: { max: 3, delay_ms: 10 } },
      markerPath,
    });
    expect(outcome.threw).toBe(true);
    expect(outcome.branchRan).toBe(false);
    expect(outcome.evaluatorCalls).toBe(1);
  });

  it("still runs the matching branch for an accepted route", async () => {
    const outcome = await runWorkflow({ evaluate: answer(0.05), stepExtra: {}, markerPath });
    expect(outcome.threw).toBe(false);
    expect(outcome.branchRan).toBe(true);
  });
});
