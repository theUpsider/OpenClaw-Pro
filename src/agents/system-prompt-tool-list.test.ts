// Prompt-cache prefix stability for the `## Tooling` mirror.
//
// The mirror sits in the dynamic suffix, AHEAD of the conversation history, so any
// change to it invalidates the whole cached body (measured 90.11% on real traffic,
// report prompt-wire-drivers-2026-11-08 §5). The most common real movement is a
// per-turn tool-admission flip ("15 -> 13 tools; removed computer, openclaw",
// 56/56 of which moved both the tail array and the mirror).
//
// These tests pin the contract: the mirror renders the session's available tool
// surface, not this turn's admitted subset, so an admission flip cannot move
// bytes ahead of the history block. The tail `tools:[...]` array stays the
// authority for what is callable this turn.
import { describe, expect, it } from "vitest";
import { buildSystemPromptToolLines } from "./system-prompt-tool-list.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const SESSION_TOOLS = [
  "read",
  "write",
  "edit",
  "exec",
  "process",
  "web_search",
  "message",
  "openclaw",
  "gateway",
  "sessions_list",
  "sessions_spawn",
  "image_generate",
  "computer",
];

// One turn admits the whole surface; the next drops the two oscillating tools.
const ADMITTED_A = SESSION_TOOLS;
const ADMITTED_B = SESSION_TOOLS.filter((tool) => !["computer", "openclaw"].includes(tool));

const promptParams = (toolNames: string[]) =>
  ({
    workspaceDir: "/tmp/openclaw-tooling-mirror",
    toolNames,
    capabilityToolNames: SESSION_TOOLS,
    contextFiles: [{ path: "/tmp/openclaw-tooling-mirror/AGENTS.md", content: "Rules.\n" }],
    promptMode: "full",
  }) satisfies Parameters<typeof buildAgentSystemPrompt>[0];

const toolLines = (params: { visible: string[]; available: string[]; codeModeActive?: boolean }) =>
  buildSystemPromptToolLines({
    visibleTools: new Map(params.visible.map((name) => [name, name])),
    availableTools: new Set(params.available),
    codeModeActive: params.codeModeActive,
    promptSurface: "openclaw_main",
    acpSpawnRuntimeEnabled: true,
  });

describe("Tooling mirror renders the session surface, not the turn's admission", () => {
  // The whole point of the change: a per-turn admission flip must not move any
  // byte of the system prompt, because the system prompt sits ahead of the
  // conversation history in the cached prefix.
  it("keeps the system prompt byte-identical when only the admitted subset narrows", () => {
    const first = buildAgentSystemPrompt(promptParams(ADMITTED_A));
    const next = buildAgentSystemPrompt(promptParams(ADMITTED_B));

    expect(next).toBe(first);
  });

  it("still lists the tools that left this turn's admitted subset", () => {
    const next = buildAgentSystemPrompt(promptParams(ADMITTED_B));

    expect(next).toContain("- computer:");
    expect(next).toContain("- openclaw: Gateway restart/system setup/config");
  });

  it("keeps the mirror line set stable across a narrow-to-wide admission change", () => {
    const narrow = toolLines({ visible: ADMITTED_B, available: SESSION_TOOLS });
    const wide = toolLines({ visible: ADMITTED_A, available: SESSION_TOOLS });

    expect(narrow).toEqual(wide);
  });

  // A bare capability name has no curated summary: the deferred-schema directory
  // stays its only listing, so the mirror cannot duplicate that catalog.
  it("does not list capability-only names that have no curated summary", () => {
    const lines = toolLines({
      visible: ["read", "tool_search"],
      available: ["read", "tool_search", "some_deferred_tool", "another_deferred_tool"],
    });

    expect(lines).toContain("- read: Read files");
    expect(lines).not.toContain("- some_deferred_tool");
    expect(lines).not.toContain("- another_deferred_tool");
  });

  // Visibility still owns names the session has no curated guidance for.
  it("keeps listing visible tools without a curated summary", () => {
    const lines = toolLines({ visible: ["read", "some_plugin_tool"], available: ["read"] });

    expect(lines).toContain("- some_plugin_tool");
  });

  it("still tracks a genuine session-capability change", () => {
    const withoutExec = toolLines({
      visible: ["read"],
      available: ["read"],
    });
    const withExec = toolLines({ visible: ["read"], available: ["read", "exec"] });

    // Array toContain is exact-element, so compare rendered lines by prefix.
    expect(withoutExec.some((line) => line.startsWith("- exec:"))).toBe(false);
    expect(withExec.some((line) => line.startsWith("- exec:"))).toBe(true);
  });
});
