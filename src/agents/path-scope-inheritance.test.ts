import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mergeInheritedPathScope, type ResolvedPathScopePolicy } from "./path-scope-policy.js";
import { resolvePathScopeSpawnRefusal } from "./spawn-requester-policy.js";

function policy(
  entries: Array<{ path: string; mode?: "deny" | "deny+conceal" }>,
  allowExecWithEntries = false,
): ResolvedPathScopePolicy {
  return Object.freeze({
    entries: entries.map((entry) =>
      Object.freeze({ path: entry.path, mode: entry.mode ?? ("deny+conceal" as const) }),
    ),
    allowExecWithEntries,
    unresolvedModel: false,
  });
}

describe("path scope inheritance into child runs", () => {
  it("unions the inherited rules with the child's own rules", () => {
    const merged = mergeInheritedPathScope(
      policy([{ path: "/srv/parent" }]),
      policy([{ path: "/srv/child", mode: "deny" }]),
    );
    expect(merged?.entries.map((entry) => entry.path).toSorted()).toEqual([
      "/srv/child",
      "/srv/parent",
    ]);
  });

  it("keeps the stronger mode when parent and child cover the same path", () => {
    const merged = mergeInheritedPathScope(
      policy([{ path: "/srv/shared" }]),
      policy([{ path: "/srv/shared", mode: "deny" }]),
    );
    expect(merged?.entries).toHaveLength(1);
    expect(merged?.entries[0]?.mode).toBe("deny+conceal");
  });

  it("keeps the shell removed when only one side allows it", () => {
    // Inheriting must not widen: an inherited restrictive default cannot be lifted by the child.
    const merged = mergeInheritedPathScope(
      policy([{ path: "/srv/parent" }], false),
      policy([{ path: "/srv/child" }], true),
    );
    expect(merged?.allowExecWithEntries).toBe(false);
  });

  it("returns the other side when one side has no rules", () => {
    const inherited = policy([{ path: "/srv/parent" }]);
    expect(mergeInheritedPathScope(inherited, undefined)).toBe(inherited);
    expect(mergeInheritedPathScope(undefined, inherited)).toBe(inherited);
    expect(mergeInheritedPathScope(undefined, undefined)).toBeUndefined();
  });

  it("refuses a spawn that cannot carry the rules", () => {
    const config = {
      tools: {
        pathScopes: { byModel: { anthropic: { entries: [{ path: "/srv/parent" }] } } },
      },
    } as unknown as OpenClawConfig;
    const agentId = "b";
    // A missing requester model is resolved through the selector, not treated as fail-closed.
    expect(
      resolvePathScopeSpawnRefusal({
        config,
        requesterAgentIdOverride: agentId,
        requesterModel: { model: "m" },
      }),
    ).toBeUndefined();
    // Same provider: the child inherits the very rules, so the spawn may proceed.
    expect(
      resolvePathScopeSpawnRefusal({
        config,
        requesterAgentIdOverride: agentId,
        requesterModel: { provider: "anthropic", model: "m" },
      }),
    ).toBeUndefined();
    // Another provider with no entries of its own: the spawn is refused, not started unguarded.
    expect(
      resolvePathScopeSpawnRefusal({
        config,
        requesterAgentIdOverride: agentId,
        requesterModel: { provider: "anthropic", model: "m" },
        modelOverride: "example/ds41",
      }),
    ).toMatch(/would not carry/);
    // A child on another provider passes once its own entries cover the parent's path.
    const covering = {
      tools: {
        pathScopes: {
          byModel: {
            anthropic: { entries: [{ path: "/srv/parent" }] },
            example: { entries: [{ path: "/srv/parent" }, { path: "/srv/example" }] },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolvePathScopeSpawnRefusal({
        config: covering,
        requesterAgentIdOverride: agentId,
        requesterModel: { provider: "anthropic", model: "m" },
        modelOverride: "example/ds41",
      }),
    ).toBeUndefined();
    // Unrelated entries on the child's provider are not coverage: the parent's path stays open.
    const unrelated = {
      tools: {
        pathScopes: {
          byModel: {
            anthropic: { entries: [{ path: "/srv/parent" }] },
            example: { entries: [{ path: "/srv/somewhere-else" }] },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      resolvePathScopeSpawnRefusal({
        config: unrelated,
        requesterAgentIdOverride: agentId,
        requesterModel: { provider: "anthropic", model: "m" },
        modelOverride: "example/ds41",
      }),
    ).toMatch(/would not carry/);
  });

  it("never refuses a spawn when the parent has no rules", () => {
    expect(resolvePathScopeSpawnRefusal({})).toBeUndefined();
  });
});
