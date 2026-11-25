// Regression for the spawn-gate bypass found by the path-scope verification stand:
// on the Gateway runtime path the session tools receive `config: undefined` (the
// `sessionConfigSource: "runtime"` sentinel), and the path-scope gate read that raw option as
// "no rules can exist", so a restricted requester could start an unguarded child.
//
// The check drives the real spawn tool without a `config` option — the shape
// `src/gateway/tool-resolution.ts` hands it — with only the runtime config snapshot carrying
// `tools.pathScopes`. The refusal must fire there exactly as it does when `config` is pinned.
import "./sessions-spawn-tool.mocks.test-support.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");
let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
let acpRuntimeRegistry: typeof import("../../acp/runtime/registry.js");

/** One `deny+conceal` rule on `restricted`, and nothing on `unguarded`. */
const RESTRICTED_CONFIG = {
  agents: {
    defaults: { model: "restricted/primary" },
    entries: { b: {} },
  },
  tools: {
    pathScopes: {
      byModel: {
        restricted: { entries: [{ path: "/srv/private", mode: "deny+conceal" }] },
      },
    },
  },
} as unknown as OpenClawConfig;

describe("sessions_spawn path-scope gate on the runtime config path", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
    acpRuntimeRegistry = await import("../../acp/runtime/registry.js");
  });

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    // Register a healthy backend so an ACP call reaches the policy gate rather than failing on a
    // missing backend — otherwise the case would be red for the wrong reason.
    acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
    acpRuntimeRegistry.registerAcpRuntimeBackend({
      id: "acpx",
      healthy: () => true,
      runtime: {
        ensureSession: vi.fn(async () => ({
          sessionKey: "agent:codex:acp:1",
          backend: "acpx",
          runtimeSessionName: "codex",
        })),
        async *runTurn() {},
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    });
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      context: "isolated",
      childSessionKey: "agent:b:subagent:1",
      runId: "run-subagent",
    });
    hoisted.spawnAcpDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:b:acp:1",
      runId: "run-acp",
    });
  });

  afterEach(() => {
    acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
    clearRuntimeConfigSnapshot();
  });

  /**
   * The runtime-path shape: `config` omitted, exactly as
   * `openclaw-tools.ts` passes `sessionConfig = undefined` under `sessionConfigSource: "runtime"`.
   */
  function runtimeTool(overrides: Record<string, unknown> = {}) {
    return createSessionsSpawnTool({
      agentSessionKey: "agent:b:main",
      requesterAgentIdOverride: "b",
      requesterModel: { provider: "restricted", model: "primary" },
      ...overrides,
    } as Parameters<typeof createSessionsSpawnTool>[0]);
  }

  it("refuses an unguarded child when only the runtime config carries the rules", async () => {
    // The live snapshot is the only place these rules exist — the option is absent, not pinned.
    setRuntimeConfigSnapshot(RESTRICTED_CONFIG);

    const result = await runtimeTool().execute("runtime-bypass", {
      task: "read the concealed directory",
      model: "unguarded/child",
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringMatching(/would not carry/),
    });
    // The refusal must beat every side effect of starting the child.
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    // The refusal reaches the model, so it must not name the concealed path.
    expect(JSON.stringify(result.details)).not.toContain("/srv/private");
  });

  it("still admits a child whose provider carries the same rule", async () => {
    // Control in the other direction: resolving the config must not turn every spawn into a refusal.
    setRuntimeConfigSnapshot({
      ...(RESTRICTED_CONFIG as Record<string, unknown>),
      tools: {
        pathScopes: {
          byModel: {
            restricted: { entries: [{ path: "/srv/private", mode: "deny+conceal" }] },
            unguarded: { entries: [{ path: "/srv/private", mode: "deny+conceal" }] },
          },
        },
      },
    } as unknown as OpenClawConfig);

    const result = await runtimeTool().execute("runtime-covered", {
      task: "work inside the boundary",
      model: "unguarded/child",
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledOnce();
  });

  it("refuses a restricted requester's ACP child on the runtime config path", async () => {
    setRuntimeConfigSnapshot(RESTRICTED_CONFIG);

    const result = await runtimeTool().execute("runtime-acp", {
      task: "delegate over ACP",
      runtime: "acp",
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringMatching(/ACP child run does not enforce/),
    });
    // Without the fix the gate never sees the rules, this call reaches the backend, and the
    // unguarded ACP child starts — the bypass at the exact point the verification stand found.
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("keeps an unrestricted runtime session spawning freely", async () => {
    // A runtime snapshot without any path rules must not be read as a restriction.
    setRuntimeConfigSnapshot({ agents: { defaults: { model: "unguarded/primary" } } });

    const result = await runtimeTool({
      requesterModel: { provider: "unguarded", model: "primary" },
    }).execute("runtime-open", { task: "ordinary delegation", model: "unguarded/child" });

    expect(result.details).toMatchObject({ status: "accepted" });
  });
});
