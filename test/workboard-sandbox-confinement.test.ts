// Sandbox workspace-authority tests attest the Workboard tool surface from the plugin's real list.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The Workboard plugin owns this entry point and this list: the test drives the
// real caller so the confined surface it hands the sandbox is the shipped one.
import { resolveAgentWorkboardWorkspaceRuntime } from "../extensions/workboard/test-api.js";
import { resolveSandboxRuntimeStatusAsync } from "../src/agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceAuthority } from "../src/agents/sandbox/workspace-authority.js";
import { withPreparedSessionCapabilityRead } from "../src/agents/subagents/spawn/subagent-session-store.js";
import type { AgentSandboxConfig } from "../src/config/types.agents-shared.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

const SAFE_WORKBOARD_TOOLS = ["exec", "process", "read", "write", "edit", "apply_patch"];
const REQUIRED_WORKBOARD_TOOLS = ["workboard_heartbeat", "workboard_complete", "workboard_block"];

function configWithSandbox(sandbox: AgentSandboxConfig): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: "/workspace", sandbox: { scope: "session", ...sandbox } },
      entries: { main: { workspace: "/workspace" } },
    },
    tools: {
      sandbox: { tools: { allow: SAFE_WORKBOARD_TOOLS } },
    },
  };
}

/** The host callback the plugin calls; the real resolver supplies the confinement verdict. */
async function prepareWorkspaceAuthorityForTest(params: {
  config: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  confinedToolNames?: readonly string[];
  requiredToolNames?: readonly string[];
}) {
  const preparedRuntimeStatus = await resolveSandboxRuntimeStatusAsync({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return withPreparedSessionCapabilityRead(() =>
    resolveSandboxWorkspaceAuthority({
      config: params.config,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      confinedToolNames: params.confinedToolNames,
      requiredToolNames: params.requiredToolNames,
      preparedRuntimeStatus,
    }),
  );
}

describe("Workboard tool surface workspace confinement", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "workboard-sandbox-confinement",
      layout: "state-only",
    });
  });
  afterEach(async () => {
    await state.cleanup();
  });

  it("confines the shipped dispatch-mode surface instead of refusing it as unclassified", async () => {
    // The allow policy names the drifted tool on top of the ordinary worker surface,
    // so an unclassified name here is exactly the pre-fix failure.
    const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    config.tools!.sandbox!.tools!.allow = [
      ...SAFE_WORKBOARD_TOOLS,
      ...REQUIRED_WORKBOARD_TOOLS,
      "workboard_set_dispatch_mode",
    ];

    const runtime = await resolveAgentWorkboardWorkspaceRuntime({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      workspaceDir: "/workspace",
      prepareSandboxWorkspaceAuthority: prepareWorkspaceAuthorityForTest,
    });

    // The plugin passes its own WORKBOARD_TOOL_NAMES; the assertion is about the
    // verdict that list produces, not about a list this test built.
    expect(runtime.confinementError ?? "").not.toContain("unclassified");
    expect(runtime.confinementError ?? "").not.toContain("workboard_set_dispatch_mode");
  });

  it("still refuses a name that is genuinely outside the confined surface", async () => {
    const config = configWithSandbox({ mode: "all", workspaceAccess: "rw" });
    config.tools!.sandbox!.tools!.allow = [
      ...SAFE_WORKBOARD_TOOLS,
      ...REQUIRED_WORKBOARD_TOOLS,
      "workboard_shell",
    ];

    const runtime = await resolveAgentWorkboardWorkspaceRuntime({
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:workboard-card",
      workspaceDir: "/workspace",
      prepareSandboxWorkspaceAuthority: prepareWorkspaceAuthorityForTest,
    });

    expect(runtime.confinementError).toContain("workboard_shell");
  });
});
