import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSpawnRequesterRefusal } from "./spawn-requester-policy.js";

const WITH_RULES = {
  tools: {
    pathScopes: { byModel: { anthropic: { entries: [{ path: "/srv/private" }] } } },
  },
} as unknown as OpenClawConfig;

describe("spawn gate while path rules are active", () => {
  it("resolves the requester's model instead of refusing on a missing report", () => {
    // A call path that reports no model (worker executor, HTTP invoke) names the agent, so the model
    // is resolved through the selector. Refusing here would block every worker spawn.
    const error = resolveSpawnRequesterRefusal({
      config: WITH_RULES,
      requesterAgentIdOverride: "b",
      requesterModel: { model: "some-model" },
    });
    expect(error).toBeUndefined();
  });

  it("refuses an ACP child while rules are active", () => {
    // The ACP harness has no path-rule code, so a restricted requester must not start one.
    expect(
      resolveSpawnRequesterRefusal({
        config: WITH_RULES,
        requesterAgentIdOverride: "b",
        requesterModel: { provider: "anthropic", model: "claude-opus-5-5" },
        agentRuntime: "acp",
      }),
    ).toMatch(/ACP child run does not enforce/);
  });
  it("allows the child when the requester's provider is known", () => {
    expect(
      resolveSpawnRequesterRefusal({
        config: WITH_RULES,
        requesterAgentIdOverride: "b",
        requesterModel: { provider: "anthropic", model: "claude-opus-5-5" },
      }),
    ).toBeUndefined();
  });

  it("never gates a spawn when the requester has no rules for its model", () => {
    expect(
      resolveSpawnRequesterRefusal({
        config: WITH_RULES,
        requesterAgentIdOverride: "b",
        requesterModel: { provider: "openai", model: "gpt-6-astra" },
      }),
    ).toBeUndefined();
    expect(
      resolveSpawnRequesterRefusal({
        config: {} as OpenClawConfig,
        requesterAgentIdOverride: "b",
      }),
    ).toBeUndefined();
  });

  it("refuses a child on a provider that carries no rules of its own", () => {
    // Handing the work to an unguarded provider is the delegation bypass this gate closes.
    expect(
      resolveSpawnRequesterRefusal({
        config: WITH_RULES,
        requesterAgentIdOverride: "b",
        requesterModel: { provider: "anthropic", model: "claude-opus-5-5" },
        modelOverride: "example/ds41",
      }),
    ).toMatch(/would not carry/);
  });

  it("refuses a child whose rules do not cover the parent's", () => {
    // Unrelated entries on the child's provider look like protection while the parent's path stays
    // readable for the child, so the spawn must not pass on "has some rules" alone.
    const unrelated = {
      tools: {
        pathScopes: {
          byModel: {
            anthropic: { entries: [{ path: "/srv/private" }] },
            example: { entries: [{ path: "/srv/somewhere-else" }] },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveSpawnRequesterRefusal({
        config: unrelated,
        requesterAgentIdOverride: "b",
        requesterModel: { provider: "anthropic", model: "claude-opus-5-5" },
        modelOverride: "example/ds41",
      }),
    ).toMatch(/would not carry/);
  });

  it("allows the child when its provider covers the parent's rules", () => {
    // The child's own entry covers the parent's path, so nothing of the parent's stays open.
    const covering = {
      tools: {
        pathScopes: {
          byModel: {
            anthropic: { entries: [{ path: "/srv/private" }] },
            example: { entries: [{ path: "/srv/private" }, { path: "/srv/example" }] },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveSpawnRequesterRefusal({
        config: covering,
        requesterAgentIdOverride: "b",
        requesterModel: { provider: "anthropic", model: "claude-opus-5-5" },
        modelOverride: "example/ds41",
      }),
    ).toBeUndefined();
  });

  it("never names a concealed path in the refusal", () => {
    // The refusal reaches the model, so naming a hidden path would defeat the rule entirely.
    const error = resolveSpawnRequesterRefusal({
      config: WITH_RULES,
      requesterAgentIdOverride: "b",
      requesterModel: { provider: "anthropic", model: "claude-opus-5-5" },
      modelOverride: "example/ds41",
    });
    expect(error).toMatch(/would not carry/);
    expect(error).not.toContain("/srv/private");
  });

  it("does not mistake a configured subagents.model for the requester's own model", () => {
    // The agent's primary is restricted; `subagents.model` points at a provider with no rules. A gate
    // that resolved the requester through the subagent selector would see "no rules" and let the
    // child run unrestricted.
    const config = {
      agents: {
        defaults: { model: "anthropic/claude-opus-5-5" },
        entries: {
          b: { subagents: { model: "example/ds41" } },
        },
      },
      tools: {
        pathScopes: { byModel: { anthropic: { entries: [{ path: "/srv/private" }] } } },
      },
    } as unknown as OpenClawConfig;
    const error = resolveSpawnRequesterRefusal({
      config,
      requesterAgentIdOverride: "b",
      // No reported model: the worker path resolves it from config.
      modelOverride: "example/ds41",
    });
    expect(error).toMatch(/would not carry/);
    expect(error).not.toContain("/srv/private");
  });

  it("refuses a bare child model id that names no provider", () => {
    // The selector leaves a non-alias bare id unresolved, so splitting it would invent a provider
    // and compare against rules the child will never run. It is refused instead.
    expect(
      resolveSpawnRequesterRefusal({
        config: WITH_RULES,
        requesterAgentIdOverride: "b",
        requesterModel: { provider: "anthropic", model: "claude-opus-5-5" },
        modelOverride: "claude-opus-5-5",
      }),
    ).toMatch(/names no provider/);
  });

  it("refuses an unknown provider in the refusal without naming the rule", () => {
    const error = resolveSpawnRequesterRefusal({
      config: WITH_RULES,
      requesterAgentIdOverride: "b",
      requesterModel: { provider: "anthropic", model: "claude-opus-5-5" },
      modelOverride: "example/ds41",
    });
    expect(error).toMatch(/would not carry/);
    // The message reaches the model, so the rule paths must not appear in it.
    expect(error).not.toContain("/srv/private");
  });

  it("keeps the sender-restriction verdict in the same gate", () => {
    // The pre-existing rule must still answer first when it applies.
    const error = resolveSpawnRequesterRefusal({
      inheritedToolPolicySource: "sender",
      requesterAgentId: "b",
      targetAgentId: "other-agent",
      config: WITH_RULES,
      requesterAgentIdOverride: "b",
      requesterModel: { provider: "anthropic" },
    });
    expect(error).toMatch(/hidden helpers/);
  });
});
