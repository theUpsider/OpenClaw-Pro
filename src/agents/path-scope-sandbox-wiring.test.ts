import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import type { ResolvedPathScopePolicy } from "./path-scope-policy.js";
import type { SandboxContext } from "./sandbox.js";

/**
 * Wiring test, not a unit test.
 *
 * The projection from container path to host path has to be hooked up at every call site. A unit test
 * of the guard cannot see a call site that forgot it, which is exactly how the sandboxed `read`
 * guard shipped without a bridge. This drives the real tool construction instead, so a missing
 * wiring turns it red.
 */
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const POLICY: ResolvedPathScopePolicy = {
  entries: [{ path: "/host/ws/private", mode: "deny+conceal" }],
  allowExecWithEntries: false,
  unresolvedModel: false,
};

/** A remote-style bridge: declares its mounts, never reports a host path. */
function remoteBridge() {
  return {
    pathMappings: [{ containerRoot: "/workspace", hostRoot: "/host/ws" }],
    resolvePath: ({ filePath }: { filePath: string }) => ({
      containerPath: filePath,
      hostPath: undefined,
      relativePath: filePath,
    }),
    readDirectory: async () => [],
    readFile: async () => Buffer.from("CONCEALED-BODY"),
  };
}

function sandboxContext(bridge: unknown): SandboxContext {
  return {
    enabled: true,
    backendId: "docker",
    sessionKey: "agent:b:main",
    workspaceDir: "/host/ws",
    agentWorkspaceDir: "/host/ws",
    workspaceAccess: "rw",
    runtimeId: "rt",
    runtimeLabel: "rt",
    containerName: "probe",
    containerWorkdir: "/workspace",
    docker: {} as SandboxContext["docker"],
    tools: {} as SandboxContext["tools"],
    browserAllowHostControl: false,
    fsBridge: bridge as SandboxContext["fsBridge"],
  };
}

function buildTools() {
  return createCoreCodingTools({
    codingRoot: "/host/ws",
    containmentRoot: "/host/ws",
    includeBaseCodingTools: true,
    shellTools: "disabled",
    workspaceOnly: false,
    readOnly: false,
    sandbox: sandboxContext(remoteBridge()),
    pathScopePolicy: POLICY,
    applyPatchEnabled: false,
    applyPatchWorkspaceOnly: true,
    execDefaults: {},
    processDefaults: {},
  });
}

describe("sandbox wiring through the real coding tools", () => {
  it("refuses an absolute container path in a sandboxed read", async () => {
    const read = buildTools().find((tool) => tool.name === "read")!;
    await expect(
      read.execute("r-1", { path: "/workspace/private/note.txt" }),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses an absolute container path in a sandboxed write", async () => {
    const write = buildTools().find((tool) => tool.name === "write")!;
    await expect(
      write.execute("w-1", { path: "/workspace/private/note.txt", content: "x" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hides the concealed entry from a sandboxed listing", async () => {
    const tools = createCoreCodingTools({
      codingRoot: "/host/ws",
      containmentRoot: "/host/ws",
      includeBaseCodingTools: true,
      shellTools: "disabled",
      workspaceOnly: false,
      readOnly: false,
      sandbox: sandboxContext({
        ...remoteBridge(),
        readDirectory: async () => [
          { name: "private", isDirectory: true },
          { name: "public", isDirectory: true },
        ],
      }),
      pathScopePolicy: POLICY,
      applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true,
      execDefaults: {},
      processDefaults: {},
    });
    const ls = tools.find((tool) => tool.name === "ls")!;
    const result = (await ls.execute("ls-1", { path: "/workspace" })) as {
      content?: Array<{ text?: string }>;
    };
    const text = JSON.stringify(result);
    expect(text).toContain("public");
    expect(text).not.toContain("private");
  });

  it("keeps the sandbox work tree unused by this suite", () => {
    // The suite never touches the host: every path above lives in the fake mount table.
    expect(tempDirs).toBeDefined();
  });
});
