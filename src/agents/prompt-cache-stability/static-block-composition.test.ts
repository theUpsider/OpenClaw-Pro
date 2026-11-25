import { splitSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
// Measurement: the system prompt's cached-prefix vs dynamic-suffix split, and the real bound on the
// skills catalog. Both asserted, so the numbers cannot silently drift.
//
// Why this matters: it corrects a reading in the incoming report. "275 SKILL.md = 1.36 MB of skill
// text" is the ON-DISK weight; the prompt catalog is separately budgeted. On-disk bytes are not prompt
// bytes, so the reducible prompt mass is the tool-description surface, not the skill bodies.
import { describe, expect, it } from "vitest";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";

const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000;

function syntheticSkills(count: number) {
  return Array.from({ length: count }, (_, i) =>
    createCanonicalFixtureSkill({
      name: `skill-${i}`,
      description: `Synthetic skill ${i} used to measure catalog footprint under the shared budget.`,
      filePath: `/skills/skill-${i}/SKILL.md`,
      baseDir: `/skills/skill-${i}`,
      source: "openclaw-workspace",
    }),
  );
}

describe("static prompt block composition", () => {
  it("bounds the skills catalog by entries and characters", () => {
    const rendered = formatSkillsForPromptBounded({ skills: syntheticSkills(275) });
    console.log(`skills catalog: 275 entries -> ${rendered.length} chars rendered`);

    // The catalog is budgeted, not unbounded: this is the property that matters for prompt weight.
    expect(rendered.length).toBeLessThanOrEqual(DEFAULT_MAX_SKILLS_PROMPT_CHARS);
    // The cap really truncates: fewer entries render than were supplied, and the note says so.
    const renderedEntries = rendered.match(/<skill>/g)?.length ?? 0;
    expect(renderedEntries).toBeGreaterThan(0);
    expect(renderedEntries).toBeLessThanOrEqual(DEFAULT_MAX_SKILLS_IN_PROMPT);
    expect(renderedEntries).toBeLessThan(275);
    expect(rendered).toContain("Skills truncated");
    // It is not collapsing to a single entry either.
    expect(renderedEntries).toBeGreaterThan(50);
  });

  it("reports and pins the cached-prefix vs dynamic-suffix split", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace/main/state/workspace-b",
      toolNames: ["read", "write", "edit", "exec", "process", "ls", "message", "sessions_spawn"],
      runtimeInfo: {
        agentId: "b",
        sessionKey: "agent:b:main",
        sessionId: "s",
        model: "ds41",
      },
      contextFiles: [
        { path: "/w/AGENTS.md", content: "A".repeat(20_291) },
        { path: "/w/SOUL.md", content: "S".repeat(7_173) },
        { path: "/w/MEMORY.md", content: "M".repeat(10_324) },
      ],
    });

    const split = splitSystemPromptCacheBoundary(prompt);
    // A real split, not the whole prompt reclassified as the prefix.
    expect(split).toBeDefined();
    const prefix = split!.stablePrefix;
    const suffix = split!.dynamicSuffix;
    expect(suffix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(prompt.length);
    expect(prefix.length).toBeGreaterThan(suffix.length);

    console.log(
      [
        `system prompt total:     ${prompt.length} chars`,
        `  cached stable prefix:  ${prefix.length} chars`,
        `  dynamic suffix:        ${suffix.length} chars`,
      ].join("\n"),
    );

    // Structural property the cache depends on: the injected 20k-char AGENTS.md body is in the
    // cached prefix, and the per-request Runtime line is not.
    expect(prefix).toContain("AAAA");
    expect(suffix).toContain("Runtime:");
    expect(prefix).not.toContain("Runtime:");
  });
});
