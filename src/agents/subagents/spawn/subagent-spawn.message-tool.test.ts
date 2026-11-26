import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const registerSubagentRunMock = vi.fn();
let store: Record<string, Record<string, unknown>> = {};
let depth = 0;
let agentConfigs: Record<string, unknown> = {};
let config = createSubagentSpawnTestConfig("/tmp/workspace-main");
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
const parentKey = "agent:main:subagent:parent";

function agentRequest(): Record<string, unknown> | undefined {
  return callGatewayMock.mock.calls.find(([call]) => call.method === "agent")?.[0]?.params;
}

function childEntry(result: Awaited<ReturnType<typeof spawnSubagentDirect>>) {
  expect(result.status).toBe("accepted");
  const entry = store[result.childSessionKey!];
  expect(entry).toBeDefined();
  return entry!;
}

function withSubagentDefaults(subagents: Record<string, unknown>) {
  config = createSubagentSpawnTestConfig("/tmp/workspace-main", {
    agents: { defaults: { workspace: "/tmp/workspace-main", subagents } },
  });
}

describe("spawnSubagentDirect message tool opt-in", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      loadSessionStoreMock,
      updateSessionStoreMock,
      registerSubagentRunMock,
      resolveAgentConfig: (_cfg, agentId) => agentConfigs[agentId],
      getSubagentDepthFromSessionStore: (key) => (key === parentKey ? depth : 0),
      resetModules: false,
    }));
  });

  beforeEach(async () => {
    await resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    loadSessionStoreMock.mockReset().mockReturnValue({});
    registerSubagentRunMock.mockReset();
    updateSessionStoreMock.mockReset();
    store = {};
    depth = 0;
    agentConfigs = {};
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      onStore: (value) => {
        store = value;
      },
    });
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    config = createSubagentSpawnTestConfig("/tmp/workspace-main");
  });

  it.each([
    { name: "omitted", allowMessaging: undefined },
    { name: "false", allowMessaging: false },
  ])("keeps the message tool off when allowMessaging is $name", async ({ allowMessaging }) => {
    const entry = childEntry(
      await spawnSubagentDirect({ task: "work", allowMessaging }, { agentSessionKey: "main" }),
    );
    expect(agentRequest()?.disableMessageTool).toBe(true);
    expect(entry).not.toHaveProperty("subagentMessageToolEnabled");
  });

  it("opens both gates for one child with allowMessaging: true", async () => {
    const entry = childEntry(
      await spawnSubagentDirect(
        { task: "dm the user", allowMessaging: true },
        { agentSessionKey: "main" },
      ),
    );
    expect(agentRequest()?.disableMessageTool).toBe(false);
    expect(entry.subagentMessageToolEnabled).toBe(true);
  });

  it("resolves explicit param > requester agent config > defaults", async () => {
    withSubagentDefaults({ messageTool: { enabled: true } });
    childEntry(await spawnSubagentDirect({ task: "a" }, { agentSessionKey: "main" }));
    expect(agentRequest()?.disableMessageTool).toBe(false);

    callGatewayMock.mockClear();
    childEntry(
      await spawnSubagentDirect({ task: "b", allowMessaging: false }, { agentSessionKey: "main" }),
    );
    expect(agentRequest()?.disableMessageTool).toBe(true);

    callGatewayMock.mockClear();
    agentConfigs = { main: { subagents: { messageTool: { enabled: false } } } };
    childEntry(await spawnSubagentDirect({ task: "c" }, { agentSessionKey: "main" }));
    expect(agentRequest()?.disableMessageTool).toBe(true);
  });

  it("does not let a subagent grant messaging it was not granted itself", async () => {
    withSubagentDefaults({ maxSpawnDepth: 3 });
    depth = 1;
    loadSessionStoreMock.mockReturnValue({
      [parentKey]: { sessionId: "parent", updatedAt: 1, spawnDepth: 1 },
    });
    const result = await spawnSubagentDirect(
      { task: "escalate", allowMessaging: true },
      { agentSessionKey: parentKey },
    );
    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("allowMessaging"),
    });
    expect(agentRequest()).toBeUndefined();

    loadSessionStoreMock.mockReturnValue({
      [parentKey]: {
        sessionId: "parent",
        updatedAt: 1,
        spawnDepth: 1,
        subagentMessageToolEnabled: true,
      },
    });
    const entry = childEntry(
      await spawnSubagentDirect(
        { task: "relay", allowMessaging: true },
        { agentSessionKey: parentKey },
      ),
    );
    expect(agentRequest()?.disableMessageTool).toBe(false);
    expect(entry.subagentMessageToolEnabled).toBe(true);
  });
});
