import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { formatSubagentModel, resolveSubagentFacts } from "./subagent-facts.ts";

function child(extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: "agent:worker:subagent:review",
    agentId: "worker",
    sessionId: "session-review",
    kind: "direct",
    classification: "subagent",
    status: "running",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    thinkingLevel: "high",
    subagentRole: "leaf",
    updatedAt: 1,
    ...extra,
  };
}

describe("resolveSubagentFacts", () => {
  it("reports agent, model, provider, thinking and role when all are present", () => {
    const facts = resolveSubagentFacts(child());
    expect(facts).toEqual({
      agentId: "worker",
      model: "gpt-5.6-sol",
      provider: "openai",
      thinking: "high",
      badge: { kind: "role", labelKey: "chat.subagentsPanel.roleLeaf" },
    });
    expect(formatSubagentModel(facts)).toBe("openai · gpt-5.6-sol");
  });

  it("prefers the active runtime model and pairs it with its own provider", () => {
    const facts = resolveSubagentFacts(
      child({ activeModel: "claude-opus-5-5", activeModelProvider: "anthropic" }),
    );
    expect([facts.model, facts.provider]).toEqual(["claude-opus-5-5", "anthropic"]);
    expect(
      resolveSubagentFacts(child({ activeModel: "claude-opus-5-5" })).provider,
    ).toBeUndefined();
  });

  it("leaves thinking unknown instead of inferring a level when thinkingLevel is missing", () => {
    expect(resolveSubagentFacts(child({ thinkingLevel: undefined })).thinking).toBeUndefined();
    expect(resolveSubagentFacts(child({ thinkingLevel: "  " })).thinking).toBeUndefined();
  });

  it("leaves model and provider unknown when the row has no model", () => {
    const facts = resolveSubagentFacts(child({ model: undefined }));
    expect([facts.model, facts.provider]).toEqual([undefined, undefined]);
    expect(formatSubagentModel(facts)).toBeUndefined();
  });

  it("falls back to the run status without a role and omits the badge without either", () => {
    expect(resolveSubagentFacts(child({ subagentRole: undefined })).badge).toEqual({
      kind: "status",
      labelKey: "sessionsView.statusRunning",
    });
    expect(
      resolveSubagentFacts(child({ subagentRole: undefined, status: undefined })).badge,
    ).toBeUndefined();
  });

  it("derives the agent from the session key when the row omits agentId", () => {
    expect(resolveSubagentFacts(child({ agentId: undefined })).agentId).toBe("worker");
  });
});
