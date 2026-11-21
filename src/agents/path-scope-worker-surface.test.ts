import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { WorkerToolSurfaceSchema } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareCoreToolPolicy } from "./prepared-tool-surface.js";
import { prepareAgentToolSurfacePresentation } from "./tool-surface-plan.js";

/**
 * The worker placement sends this policy through a closed-object schema, so an unconditionally
 * present `pathScopePolicy` key fails the check and breaks every worker turn — with and without
 * rules configured. Both directions are pinned here.
 */
describe("prepared core tool policy in the worker surface", () => {
  it("omits the path rules key entirely when the model has none", () => {
    const policy = prepareCoreToolPolicy({ config: {} as OpenClawConfig });
    expect(Object.hasOwn(policy, "pathScopePolicy")).toBe(false);
  });

  it("omits the key when rules exist but not for this model", () => {
    const policy = prepareCoreToolPolicy({
      config: scopesFor("anthropic"),
      modelProvider: "openai",
      modelId: "gpt-6-astra",
    });
    expect(Object.hasOwn(policy, "pathScopePolicy")).toBe(false);
  });

  it("carries the resolved rules when the model has them", () => {
    const policy = prepareCoreToolPolicy({
      config: scopesFor("anthropic"),
      modelProvider: "anthropic",
      modelId: "claude-opus-5-5",
    });
    expect(policy.pathScopePolicy?.entries).toHaveLength(1);
    expect(
      Value.Check(WorkerToolSurfaceSchema, {
        generation: "gen-1",
        presentation: { ...workerPresentation(), forceDirectMessageTool: false },
        tools: [],
        policy,
      }),
    ).toBe(true);
  });
});

/**
 * The policy block above is what the check turns on; the presentation is filled from the same
 * builder the gateway uses, so a change there cannot make this test pass for the wrong reason.
 */
function workerPresentation() {
  return prepareAgentToolSurfacePresentation({
    config: {} as OpenClawConfig,
    agentId: "b",
    sessionKey: "agent:b:main",
    toolsEnabled: true,
    isRawModelRun: false,
    modelToolsEnabled: true,
  });
}

function scopesFor(provider: string): OpenClawConfig {
  return {
    tools: { pathScopes: { byModel: { [provider]: { entries: [{ path: "/srv/private" }] } } } },
  } as unknown as OpenClawConfig;
}
