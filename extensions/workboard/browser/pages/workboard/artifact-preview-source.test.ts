import { describe, expect, it } from "vitest";
import { resolveArtifactPreviewPlan } from "./artifact-preview-source.ts";

const root = "/workspace/main/state/workspace-a";

describe("resolveArtifactPreviewPlan", () => {
  it("reads workspace-relative paths via the agent and the session", () => {
    expect(
      resolveArtifactPreviewPlan({ path: "./notes/a.md", sessionKey: "s1", agentId: "a" }),
    ).toEqual({
      kind: "attempts",
      attempts: [
        { method: "agents.workspace.get", params: { agentId: "a", path: "notes/a.md" } },
        {
          method: "sessions.files.get",
          params: { sessionKey: "s1", path: "notes/a.md", agentId: "a" },
        },
      ],
    });
  });

  it("maps an absolute path inside the confirmed root to its relative remainder", () => {
    expect(
      resolveArtifactPreviewPlan({
        path: `${root}/reports/a.md`,
        agentId: "a",
        confirmedRoot: `${root}/`,
      }),
    ).toEqual({
      kind: "attempts",
      attempts: [
        { method: "agents.workspace.get", params: { agentId: "a", path: "reports/a.md" } },
      ],
    });
  });

  it("does not read when the directory name suggests an agent but the root is not confirmed", () => {
    const path = `${root}/a.md`;
    expect(resolveArtifactPreviewPlan({ path, agentId: "a" })).toEqual({
      kind: "unsupported",
    });
    expect(
      resolveArtifactPreviewPlan({ path, agentId: "a", confirmedRoot: "/other/workspace" }),
    ).toEqual({ kind: "unsupported" });
    expect(
      resolveArtifactPreviewPlan({ path, agentId: "a", confirmedRoot: `${root}-x` }),
    ).toEqual({ kind: "unsupported" });
  });

  it("reports outside paths, traversal and workspace-prefix guesses as unsupported", () => {
    for (const path of ["/mnt/fileserver/Drive/a.md", "/home/user/a.md", "../a.md", "x/../a.md"]) {
      expect(
        resolveArtifactPreviewPlan({
          path,
          agentId: "a",
          sessionKey: "s",
          confirmedRoot: root,
        }),
      ).toEqual({ kind: "unsupported" });
    }
  });

  it("uses only the session without an agent, and nothing without either", () => {
    expect(resolveArtifactPreviewPlan({ path: "a.md", sessionKey: "s1" })).toEqual({
      kind: "attempts",
      attempts: [{ method: "sessions.files.get", params: { sessionKey: "s1", path: "a.md" } }],
    });
    expect(resolveArtifactPreviewPlan({ path: "a.md" })).toEqual({ kind: "unsupported" });
  });
});
