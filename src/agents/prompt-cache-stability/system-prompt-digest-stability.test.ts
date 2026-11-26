import {
  splitSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "@openclaw/ai/internal/shared";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
// Acceptance check (b): the system prompt's cached prefix is a pure function of its inputs.
//
// Determinism here must be proven on a FRESH module instance per case. `system-prompt.ts` memoizes the
// rendered stable prefix in a module-level Map keyed on the prompt inputs, and that key deliberately
// excludes per-request identity. Two calls that differ only in `sessionId` therefore return the SAME
// memoized string, which would mask exactly the leak this file is meant to catch. So every case below
// resets the module registry and re-imports the builder; only then does a body-only leak become visible.
import { beforeEach, describe, expect, it, vi } from "vitest";

type BuildPrompt = typeof import("../system-prompt.js").buildAgentSystemPrompt;
type PromptParams = Parameters<BuildPrompt>[0];

// A single graph import for the assertions that do not depend on a cold memo. Only the leak cases
// re-import, because `system-prompt.ts` memoizes the rendered prefix under a key that deliberately
// excludes per-request identity — so without a cold module a body-only leak is invisible.
import { buildAgentSystemPrompt } from "../system-prompt.js";

/** Re-import the builder with an empty module-level memo, then render. */
async function renderFresh(overrides: Partial<PromptParams> = {}) {
  vi.resetModules();
  const fresh = (await import("../system-prompt.js")) as { buildAgentSystemPrompt: BuildPrompt };
  return fresh.buildAgentSystemPrompt(params(overrides));
}

function runtimeInfo(sessionId = "0193f0aa-0000-7000-8000-000000000000") {
  return {
    agentId: "b",
    sessionKey: "agent:b:main",
    sessionId,
    model: "ds41",
    defaultModel: "ds41",
    host: "gateway",
    os: "Linux",
    arch: "x64",
    node: "v26.12.1",
    shell: "bash",
    repoRoot: "/workspace/pro",
  };
}

function params(overrides: Partial<PromptParams> = {}): PromptParams {
  return {
    workspaceDir: "/workspace/main/state/workspace-b",
    toolNames: ["read", "write", "exec", "message", "sessions_spawn", "sessions_yield"],
    runtimeInfo: runtimeInfo(),
    contextFiles: [
      { path: "/w/AGENTS.md", content: "# AGENTS.md\n\nStable project rules.\n" },
      { path: "/w/SOUL.md", content: "# SOUL.md\n\nStable persona.\n" },
    ],
    ...overrides,
  } as PromptParams;
}

function splitOf(prompt: string) {
  const split = splitSystemPromptCacheBoundary(prompt);
  return { prefix: split?.stablePrefix ?? prompt, suffix: split?.dynamicSuffix ?? "" };
}

describe("system prompt digest stability", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("has a cache boundary", () => {
    expect(buildAgentSystemPrompt(params())).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
  });

  it("renders a byte-identical stable prefix and suffix for repeated builds", () => {
    const builds = Array.from({ length: 5 }, () => buildAgentSystemPrompt(params()));
    const first = splitOf(builds[0]!);
    for (const build of builds.slice(1)) {
      const next = splitOf(build);
      expect(sha256Hex(next.prefix)).toBe(sha256Hex(first.prefix));
      expect(sha256Hex(next.suffix)).toBe(sha256Hex(first.suffix));
    }
  });

  it("is sensitive to real inputs (so the suite cannot pass vacuously)", () => {
    const a = splitOf(buildAgentSystemPrompt(params()));
    const b = splitOf(
      buildAgentSystemPrompt(
        params({
          contextFiles: [
            { path: "/w/AGENTS.md", content: "# AGENTS.md\n\nA genuinely different rule set.\n" },
            { path: "/w/SOUL.md", content: "# SOUL.md\n\nStable persona.\n" },
          ],
        }),
      ),
    );
    expect(sha256Hex(b.prefix)).not.toBe(sha256Hex(a.prefix));
  });

  it("is independent of build order (no cross-build mutable state)", () => {
    const a = splitOf(buildAgentSystemPrompt(params()));
    splitOf(
      buildAgentSystemPrompt(
        params({
          contextFiles: [{ path: "/w/AGENTS.md", content: "# AGENTS.md\n\nDIFFERENT.\n" }],
        }),
      ),
    );
    const b = splitOf(buildAgentSystemPrompt(params()));
    expect(sha256Hex(b.prefix)).toBe(sha256Hex(a.prefix));
    expect(sha256Hex(b.suffix)).toBe(sha256Hex(a.suffix));
  });

  it("keeps per-request session identity out of the cached prefix", async () => {
    const SESSION_A = "aaaaaaaa-0000-7000-8000-000000000000";
    const SESSION_B = "bbbbbbbb-0000-7000-8000-000000000000";
    const one = splitOf(await renderFresh({ runtimeInfo: runtimeInfo(SESSION_A) }));
    const two = splitOf(await renderFresh({ runtimeInfo: runtimeInfo(SESSION_B) }));

    // The prefix must not move and must not carry the identity...
    expect(sha256Hex(two.prefix)).toBe(sha256Hex(one.prefix));
    expect(one.prefix).not.toContain(SESSION_A);
    expect(two.prefix).not.toContain(SESSION_B);
    // ...and each render must be a real render, not one memoized string served twice. Both carries of
    // the identity must be absent across both renders, so a memo miss cannot hide a leak.
    expect(one.prefix).not.toContain(SESSION_B);
    expect(two.prefix).not.toContain(SESSION_A);
  });

  it("keeps session-only identity (key and url, not just id) out of the cached prefix", async () => {
    const withIdentity = (sessionKey: string, sessionUrl: string) =>
      renderFresh({
        runtimeInfo: {
          ...runtimeInfo(),
          sessionKey,
          sessionUrl,
        } as NonNullable<PromptParams["runtimeInfo"]>,
      });
    const KEY_A = "agent:b:dashboard:11111111-1111-7111-8111-111111111111";
    const KEY_B = "agent:b:dashboard:22222222-2222-7222-8222-222222222222";
    const one = splitOf(
      await withIdentity(KEY_A, "https://gateway.example.ts.net/chat/b/a"),
    );
    const two = splitOf(
      await withIdentity(KEY_B, "https://gateway.example.ts.net/chat/b/b"),
    );
    expect(sha256Hex(two.prefix)).toBe(sha256Hex(one.prefix));
    for (const marker of [KEY_A, KEY_B, "11111111-1111-7111-8111-111111111111"]) {
      expect(one.prefix).not.toContain(marker);
      expect(two.prefix).not.toContain(marker);
    }
  });

  it("places per-request host facts below the cache boundary, not above", () => {
    const { prefix, suffix } = splitOf(buildAgentSystemPrompt(params()));
    // Host facts belong to the dynamic suffix: present there, absent from the cached prefix.
    expect(suffix).toContain("node=v26.12.1");
    expect(prefix).not.toContain("v26.12.1");
    // Changing a host fact must move the suffix and leave the cached prefix alone. Host facts are
    // absent from the memo key, so this compares two real renders of the same key.
    const other = splitOf(
      buildAgentSystemPrompt(
        params({
          runtimeInfo: {
            ...runtimeInfo(),
            host: "different-host",
            node: "v99.0.0",
          } as NonNullable<PromptParams["runtimeInfo"]>,
        }),
      ),
    );
    expect(sha256Hex(other.prefix)).toBe(sha256Hex(prefix));
    expect(other.suffix).toContain("node=v99.0.0");
  });
});
