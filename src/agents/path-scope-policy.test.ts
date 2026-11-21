import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ToolsSchema } from "../config/zod-schema.agent-runtime.js";
import {
  canonicalizeScopePath,
  findCoveringScopeEntry,
  isPathConcealed,
  isPathDenied,
  resolvePathScopePolicy,
} from "./path-scope-policy.js";

function parseTools(tools: unknown) {
  return ToolsSchema.safeParse(tools);
}

describe("tools.pathScopes schema", () => {
  it("accepts a provider key and a provider/model key with literal paths", () => {
    const result = parseTools({
      pathScopes: {
        allowExecWithEntries: false,
        byModel: {
          anthropic: { entries: [{ path: "/srv/private", mode: "deny+conceal" }] },
          "openai/gpt-6-astra": { entries: [{ path: "~/secrets" }] },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a glob path, an empty path and an unknown mode", () => {
    const glob = parseTools({
      pathScopes: { byModel: { anthropic: { entries: [{ path: "/srv/*" }] } } },
    });
    expect(glob.success).toBe(false);

    const empty = parseTools({
      pathScopes: { byModel: { anthropic: { entries: [{ path: "  " }] } } },
    });
    expect(empty.success).toBe(false);

    const mode = parseTools({
      pathScopes: { byModel: { anthropic: { entries: [{ path: "/srv/a", mode: "hidden" }] } } },
    });
    expect(mode.success).toBe(false);
  });

  it("rejects a relative path and an unknown key", () => {
    const relative = parseTools({
      pathScopes: { byModel: { anthropic: { entries: [{ path: "secrets" }] } } },
    });
    expect(relative.success).toBe(false);

    const unknownKey = parseTools({ pathScopes: { conceal: false } });
    expect(unknownKey.success).toBe(false);
  });

  it("leaves an unconfigured block unrestricted", () => {
    const result = parseTools({});
    expect(result.success).toBe(true);
    const cfg = { tools: result.success ? result.data : {} } as OpenClawConfig;
    expect(
      resolvePathScopePolicy({ cfg, modelProvider: "anthropic", modelId: "anything" }),
    ).toBeUndefined();
  });
});

describe("resolvePathScopePolicy", () => {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pathscope-"));

  function configWith(tools: Record<string, unknown>): OpenClawConfig {
    return { tools } as OpenClawConfig;
  }

  it("unions provider and provider/model rules instead of replacing", () => {
    const cfg = configWith({
      pathScopes: {
        byModel: {
          anthropic: { entries: [{ path: `${privateDir}/provider-only` }] },
          "anthropic/claude-opus-5-5": {
            entries: [{ path: `${privateDir}/model-only`, mode: "deny" }],
          },
        },
      },
    });
    const policy = resolvePathScopePolicy({
      cfg,
      modelProvider: "anthropic",
      modelId: "claude-opus-5-5",
    });
    expect(policy?.entries.map((entry) => entry.path).toSorted()).toEqual(
      [`${privateDir}/model-only`, `${privateDir}/provider-only`].toSorted(),
    );
  });

  it("lets deny+conceal win over deny on the same path", () => {
    const cfg = configWith({
      pathScopes: {
        byModel: {
          anthropic: { entries: [{ path: privateDir, mode: "deny" }] },
        },
      },
    });
    const merged = resolvePathScopePolicy({ cfg, modelProvider: "anthropic", modelId: "m" });
    expect(merged?.entries).toHaveLength(1);
    expect(merged?.entries[0]?.mode).toBe("deny");
    // A narrower refuse-and-hide rule over the same location escalates the merged rule.
    const cfg2 = configWith({
      pathScopes: {
        byModel: {
          anthropic: {
            entries: [
              { path: privateDir, mode: "deny" },
              { path: path.join(privateDir, "inner"), mode: "deny+conceal" },
            ],
          },
        },
      },
    });
    const policy2 = resolvePathScopePolicy({ cfg: cfg2, modelProvider: "anthropic", modelId: "m" });
    // The narrower refuse-and-hide rule keeps its mode for its own subtree; the broader rule stays
    // for everything else under it.
    expect(isPathConcealed(policy2, path.join(privateDir, "inner"))).toBe(true);
    expect(isPathConcealed(policy2, path.join(privateDir, "other"))).toBe(false);
    expect(isPathDenied(policy2, path.join(privateDir, "other"))).toBe(true);
  });

  it("keeps the stronger mode on a duplicated path", () => {
    const cfg = configWith({
      pathScopes: {
        byModel: {
          anthropic: {
            entries: [
              { path: privateDir, mode: "deny" },
              { path: privateDir, mode: "deny+conceal" },
            ],
          },
        },
      },
    });
    const policy = resolvePathScopePolicy({ cfg, modelProvider: "anthropic", modelId: "m" });
    expect(policy?.entries).toHaveLength(1);
    expect(policy?.entries[0]?.mode).toBe("deny+conceal");
  });

  it("unions the per-agent block with the global block", () => {
    const cfg = {
      tools: {
        pathScopes: { byModel: { anthropic: { entries: [{ path: `${privateDir}/global` }] } } },
      },
      agents: {
        entries: {
          work: {
            tools: {
              pathScopes: {
                byModel: { anthropic: { entries: [{ path: `${privateDir}/agent` }] } },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = resolvePathScopePolicy({
      cfg,
      agentId: "work",
      modelProvider: "anthropic",
      modelId: "m",
    });
    expect(policy?.entries).toHaveLength(2);
  });

  it("reports an unresolved model instead of reading a lookup miss as no rule", () => {
    const cfg = configWith({
      pathScopes: { byModel: { anthropic: { entries: [{ path: privateDir }] } } },
    });
    const policy = resolvePathScopePolicy({ cfg });
    expect(policy).toBeDefined();
    expect(policy?.unresolvedModel).toBe(true);
  });

  it("keeps a configured model without matching rules distinguishable from an absent config", () => {
    const cfg = configWith({
      pathScopes: { byModel: { anthropic: { entries: [{ path: privateDir }] } } },
    });
    const other = resolvePathScopePolicy({ cfg, modelProvider: "openai", modelId: "gpt-6-astra" });
    expect(other).toBeDefined();
    expect(other?.entries).toHaveLength(0);
    expect(other?.allowExecWithEntries).toBe(true);
  });

  it("resolves ~ and .. to the same location as the absolute spelling", () => {
    const home = os.homedir();
    expect(canonicalizeScopePath("~/x")).toBe(canonicalizeScopePath(path.join(home, "x")));
    expect(canonicalizeScopePath(path.join(privateDir, "a", "..", "b"))).toBe(
      canonicalizeScopePath(path.join(privateDir, "b")),
    );
  });

  it("covers a subtree but not a same-named sibling", () => {
    const cfg = configWith({
      pathScopes: {
        byModel: { anthropic: { entries: [{ path: path.join(privateDir, "secret") }] } },
      },
    });
    const policy = resolvePathScopePolicy({ cfg, modelProvider: "anthropic", modelId: "m" });
    expect(isPathDenied(policy, path.join(privateDir, "secret"))).toBe(true);
    expect(isPathDenied(policy, path.join(privateDir, "secret", "deeper", "note.txt"))).toBe(true);
    expect(isPathDenied(policy, path.join(privateDir, "secret-canary"))).toBe(false);
  });

  it("resolves a file URL spelling to the configured location", () => {
    const target = path.join(privateDir, "url-secret");
    const cfg = configWith({
      pathScopes: { byModel: { anthropic: { entries: [{ path: target }] } } },
    });
    const policy = resolvePathScopePolicy({ cfg, modelProvider: "anthropic", modelId: "m" });
    // The filesystem tools expand `file://`; a guard that did not would miss this spelling.
    expect(isPathDenied(policy, `file://${target}/note.txt`)).toBe(true);
    expect(canonicalizeScopePath(`file://${target}`)).toBe(canonicalizeScopePath(target));
  });

  it("resolves a symlinked spelling to the configured location", () => {
    const target = path.join(privateDir, "linked-secret");
    const link = path.join(privateDir, "alias");
    fs.mkdirSync(target, { recursive: true });
    if (!fs.existsSync(link)) {
      fs.symlinkSync(target, link, "dir");
    }
    const cfg = configWith({
      pathScopes: { byModel: { anthropic: { entries: [{ path: target }] } } },
    });
    const policy = resolvePathScopePolicy({ cfg, modelProvider: "anthropic", modelId: "m" });
    expect(isPathDenied(policy, path.join(link, "note.txt"))).toBe(true);
    expect(findCoveringScopeEntry(policy, link)?.path).toBe(canonicalizeScopePath(target));
  });

  it("separates concealed rules from refuse-only rules", () => {
    const cfg = configWith({
      pathScopes: {
        byModel: {
          anthropic: {
            entries: [
              { path: path.join(privateDir, "hidden"), mode: "deny+conceal" },
              { path: path.join(privateDir, "visible"), mode: "deny" },
            ],
          },
        },
      },
    });
    const policy = resolvePathScopePolicy({ cfg, modelProvider: "anthropic", modelId: "m" });
    expect(isPathConcealed(policy, path.join(privateDir, "hidden"))).toBe(true);
    expect(isPathConcealed(policy, path.join(privateDir, "visible"))).toBe(false);
    expect(isPathDenied(policy, path.join(privateDir, "visible"))).toBe(true);
  });
});
