// update_goal gate coverage: the truth table's "update_goal complete" column.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore as upsertAccessorSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry, SessionGoal } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AgentDefaultsBaseSchema } from "../../config/zod-schema.agent-defaults-base.js";
import { createGetGoalTool, createUpdateGoalTool } from "./goal-tools.js";

const SESSION_KEY = "agent:main:goal-gate";

async function createStoreConfig(): Promise<{ config: OpenClawConfig; template: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-goal-gate-tools-"));
  const template = path.join(dir, "{agentId}", "sessions.json");
  return { config: { session: { store: template } } as OpenClawConfig, template };
}

function armedConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    agents: {
      defaults: AgentDefaultsBaseSchema.parse({
        experimental: { goalCompletionVerification: true },
      }),
    },
  };
}

function goal(over: Partial<SessionGoal> = {}): SessionGoal {
  return {
    schemaVersion: 1,
    id: "goal-1",
    objective: "ship the verified fix",
    status: "active",
    createdAt: 1,
    updatedAt: 100,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
    verifyCompletion: true,
    ...over,
  };
}

async function seed(params: {
  storePath: string;
  sessionKey: string;
  goal?: SessionGoal;
}): Promise<void> {
  await upsertAccessorSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath }, {
    sessionId: "sess-1",
    updatedAt: 200,
    ...(params.goal ? { goal: params.goal } : {}),
  } satisfies SessionEntry);
}

function readGoal(storePath: string, sessionKey: string): SessionGoal | undefined {
  return loadSessionEntry({ sessionKey, storePath })?.goal;
}

// Session scope comes from tool options, matching production construction.
function updateGoalTool(config: OpenClawConfig) {
  return createUpdateGoalTool({
    config,
    agentSessionKey: SESSION_KEY,
    runSessionKey: SESSION_KEY,
  });
}

async function runUpdate(
  config: OpenClawConfig,
  status: "complete" | "blocked",
): Promise<Record<string, unknown>> {
  const tool = updateGoalTool(config);
  const result = await tool.execute("call-1", { status });
  // Goal tools report their structured payload through `details`.
  return result.details as Record<string, unknown>;
}

describe("update_goal completion gate", () => {
  it("refuses complete without a verdict while armed", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "main" });
    await seed({ storePath, sessionKey: SESSION_KEY, goal: goal() });
    const payload = await runUpdate(armedConfig(config), "complete");
    expect(payload.status).toBe("refused");
    expect(payload.reason).toBe("no-verdict");
    expect(String(payload.error)).toContain("no verifier verdict");
    expect(readGoal(storePath, SESSION_KEY)?.status).toBe("active");
  });
  it("accepts complete with a current passing verdict", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "main" });
    await seed({
      storePath,
      sessionKey: SESSION_KEY,
      goal: goal({
        verification: {
          outcome: "pass",
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: [],
          attempts: 1,
        },
      }),
    });
    const payload = await runUpdate(armedConfig(config), "complete");
    expect(payload.status).toBe("updated");
    expect(readGoal(storePath, SESSION_KEY)?.status).toBe("complete");
  });
  it.each([
    ["fail", "fail"],
    ["unknown", "unknown"],
    ["unverified", "unverified"],
  ] as const)("refuses complete on a current %s verdict and returns its gaps", async (outcome) => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "main" });
    await seed({
      storePath,
      sessionKey: SESSION_KEY,
      goal: goal({
        verification: {
          outcome,
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: ["integration test not run"],
          ...(outcome === "unverified" ? { error: "timeout" } : {}),
          attempts: 1,
        },
      }),
    });
    const payload = await runUpdate(armedConfig(config), "complete");
    expect(payload.status).toBe("refused");
    expect(payload.reason).toBe(outcome);
    expect(payload.missingPoints).toEqual(["integration test not run"]);
    expect(readGoal(storePath, SESSION_KEY)?.status).toBe("active");
  });
  it("refuses complete when the only verdict belongs to an older revision", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "main" });
    await seed({
      storePath,
      sessionKey: SESSION_KEY,
      goal: goal({
        updatedAt: 500,
        verification: {
          outcome: "pass",
          checkedAt: 150,
          checkedRevision: "goal-1:100:0",
          missingPoints: [],
          attempts: 1,
        },
      }),
    });
    const payload = await runUpdate(armedConfig(config), "complete");
    expect(payload.status).toBe("refused");
    expect(payload.reason).toBe("no-verdict");
  });
  it("leaves blocked unchanged while armed", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "main" });
    await seed({ storePath, sessionKey: SESSION_KEY, goal: goal() });
    const payload = await runUpdate(armedConfig(config), "blocked");
    expect(payload.status).toBe("updated");
    expect(readGoal(storePath, SESSION_KEY)?.status).toBe("blocked");
  });
  it("keeps today's behavior with the gate off", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "main" });
    await seed({ storePath, sessionKey: SESSION_KEY, goal: goal() });
    const payload = await runUpdate(config, "complete");
    expect(payload.status).toBe("updated");
    expect(readGoal(storePath, SESSION_KEY)?.status).toBe("complete");
  });
  it("does not arm a goal that was created without the per-goal opt-in", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "main" });
    await seed({
      storePath,
      sessionKey: SESSION_KEY,
      goal: goal({ verifyCompletion: undefined }),
    });
    const payload = await runUpdate(armedConfig(config), "complete");
    expect(payload.status).toBe("updated");
  });
  it("does not gate get_goal", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveSessionStorePathCore(template, { agentId: "main" });
    await seed({ storePath, sessionKey: SESSION_KEY, goal: goal() });
    const tool = createGetGoalTool({
      config: armedConfig(config),
      agentSessionKey: SESSION_KEY,
      runSessionKey: SESSION_KEY,
    });
    const result = await tool.execute("call-1", {});
    expect(result.details).toMatchObject({ status: "found" });
  });
});
