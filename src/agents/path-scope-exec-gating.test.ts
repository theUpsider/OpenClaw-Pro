import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyModelProviderToolPolicy } from "./agent-tools.model-provider-policy.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

function stubTools(...names: string[]): AnyAgentTool[] {
  return names.map(
    (name) =>
      ({
        name,
        label: name,
        description: `${name} stub`,
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      }) as unknown as AnyAgentTool,
  );
}

const SURFACE = ["read", "write", "edit", "ls", "apply_patch", "exec", "process"];

/** Tools that take paths but are built outside the coding-tool factory. */
const PATH_TAKING = ["view_image", "pdf"];

describe("exec gating while path rules are active", () => {
  const withEntries = {
    tools: {
      pathScopes: {
        byModel: { anthropic: { entries: [{ path: "/srv/private" }] } },
      },
    },
  } as unknown as OpenClawConfig;

  const execAllowed = {
    tools: {
      pathScopes: {
        allowExecWithEntries: true,
        byModel: { anthropic: { entries: [{ path: "/srv/private" }] } },
      },
    },
  } as unknown as OpenClawConfig;

  it("removes exec and process by default when entries exist", () => {
    const tools = applyModelProviderToolPolicy(stubTools(...SURFACE), {
      config: withEntries,
      modelProvider: "anthropic",
      modelId: "probe",
    });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("exec");
    expect(names).not.toContain("process");
    // Filesystem tools stay: they enforce the rules at the path guard.
    for (const name of ["read", "write", "edit", "ls", "apply_patch"]) {
      expect(names).toContain(name);
    }
  });

  it("keeps exec and process when the operator allows them explicitly", () => {
    const names = applyModelProviderToolPolicy(stubTools(...SURFACE), {
      config: execAllowed,
      modelProvider: "anthropic",
      modelId: "probe",
    }).map((tool) => tool.name);
    expect(names).toContain("exec");
    expect(names).toContain("process");
  });

  it("leaves the surface untouched without entries for this model", () => {
    const names = applyModelProviderToolPolicy(stubTools(...SURFACE), {
      config: withEntries,
      modelProvider: "openai",
      modelId: "probe",
    }).map((tool) => tool.name);
    expect(names).toContain("exec");
    expect(names).toContain("process");
  });

  it("leaves the surface untouched without any pathScopes config", () => {
    const names = applyModelProviderToolPolicy(stubTools(...SURFACE), {
      config: {} as OpenClawConfig,
      modelProvider: "anthropic",
      modelId: "probe",
    }).map((tool) => tool.name);
    expect(names).toContain("exec");
    expect(names).toContain("process");
  });

  it("guards path-taking tools that are registered by their own factory", async () => {
    const guarded = applyModelProviderToolPolicy(stubTools(...PATH_TAKING), {
      config: withEntries,
      modelProvider: "anthropic",
      modelId: "probe",
      workspaceDir: "/srv/private",
    });
    const image = guarded.find((tool) => tool.name === "view_image")!;
    // A single `path` and each entry of `paths` must be refused; a batch cannot smuggle one past.
    await expect(
      image.execute("i-1", { path: path.join("/srv/private", "note.txt") }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      image.execute("i-2", { paths: ["/srv/allowed/ok.png", "/srv/private/secret.png"] }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(image.execute("i-3", { path: "/srv/allowed/ok.png" })).resolves.toBeDefined();

    const pdf = guarded.find((tool) => tool.name === "pdf")!;
    await expect(pdf.execute("p-1", { pdf: "/srv/private/doc.pdf" })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses the reference-prefix spellings the tools themselves strip", async () => {
    // `@` and `MEDIA:` are removed by the tools before they resolve, so a guard that only handled
    // plain paths would compare `<cwd>/@/abs` against a rule for `/abs` and never match.
    const guarded = applyModelProviderToolPolicy(stubTools("view_image"), {
      config: withEntries,
      modelProvider: "anthropic",
      modelId: "probe",
      workspaceDir: "/srv",
    });
    const image = guarded.find((tool) => tool.name === "view_image")!;
    for (const spelling of [
      "@/srv/private/a.png",
      "MEDIA:/srv/private/a.png",
      "@file:///srv/private/a.png",
    ]) {
      await expect(image.execute(`i-${spelling}`, { path: spelling })).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("does not guard those tools when no rules match the model", async () => {
    const tools = applyModelProviderToolPolicy(stubTools(...PATH_TAKING), {
      config: withEntries,
      modelProvider: "openai",
      modelId: "probe",
      workspaceDir: "/srv/private",
    });
    // Without a matching rule the tool keeps its own execute, so the concealed path is readable.
    const image = tools.find((tool) => tool.name === "view_image")!;
    await expect(image.execute("i-4", { path: "/srv/private/note.txt" })).resolves.toBeDefined();
  });
});
