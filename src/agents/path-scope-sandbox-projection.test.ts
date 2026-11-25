import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { ResolvedPathScopePolicy } from "./path-scope-policy.js";
import { wrapToolWithPathScopeGuard } from "./path-scope-tool-guard.js";

/**
 * A sandbox addresses container paths while the rules name host paths. Every guard site must map one
 * to the other through the bridge; a site that forgets it compares two namespaces and matches
 * nothing, which silently opens the concealed path instead of refusing it.
 */
const POLICY: ResolvedPathScopePolicy = {
  entries: [{ path: "/host/ws/private", mode: "deny+conceal" }],
  allowExecWithEntries: false,
  unresolvedModel: false,
};

function stubRead(): AnyAgentTool {
  return {
    name: "read",
    label: "read",
    description: "stub",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "READ-SUCCEEDED" }] }),
  } as unknown as AnyAgentTool;
}

function bridgeWithoutHostPath() {
  return {
    // A remote bridge declares its mounts but reports no host path.
    pathMappings: [{ containerRoot: "/workspace", hostRoot: "/host/ws" }],
    resolvePath: ({ filePath }: { filePath: string }) => ({
      containerPath: filePath,
      hostPath: undefined,
      relativePath: filePath,
    }),
  };
}

describe("sandbox path projection in the tool guard", () => {
  it("refuses a container path that maps to a covered host path", async () => {
    const guarded = wrapToolWithPathScopeGuard(stubRead(), {
      pathScopePolicy: POLICY,
      resolutionCwd: "/workspace",
      bridge: bridgeWithoutHostPath() as never,
    });
    await expect(
      guarded.execute("r-1", { path: "/workspace/private/note.txt" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still allows a container path that maps outside the rules", async () => {
    const guarded = wrapToolWithPathScopeGuard(stubRead(), {
      pathScopePolicy: POLICY,
      resolutionCwd: "/workspace",
      bridge: bridgeWithoutHostPath() as never,
    });
    await expect(
      guarded.execute("r-2", { path: "/workspace/public/note.txt" }),
    ).resolves.toBeDefined();
  });

  it("keeps the container spelling when the bridge maps nothing", async () => {
    // An unmapped path must not become `undefined`; the guard falls back to the value it was given.
    const guarded = wrapToolWithPathScopeGuard(stubRead(), {
      pathScopePolicy: POLICY,
      resolutionCwd: "/workspace",
      bridge: {
        pathMappings: [],
        resolvePath: () => ({ containerPath: "/elsewhere", hostPath: undefined }),
      } as never,
    });
    await expect(guarded.execute("r-3", { path: "/elsewhere/note.txt" })).resolves.toBeDefined();
  });
});
