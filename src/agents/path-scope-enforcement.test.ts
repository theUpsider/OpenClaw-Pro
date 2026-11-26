import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { resolvePathScopePolicy } from "./path-scope-policy.js";
import { prepareCoreToolPolicy } from "./prepared-tool-surface.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CANARY = "pscanary7f3a91";

type Harness = {
  tools: ReturnType<typeof createCoreCodingTools>;
  root: string;
  concealed: string;
  straightDenied: string;
  plain: string;
};

/**
 * Build the shipped filesystem tools for one run, with the path rules of `modelProvider` applied.
 * The harness never reaches into the guard: it drives the tools the model would call.
 */
async function buildHarness(params: {
  modelProvider?: string;
  modelId?: string;
  prepopulate: boolean;
  /** When set, rules are configured under this key instead of the session's own model key. */
  ruleKey?: string;
}): Promise<Harness> {
  const parent = await fs.realpath(tempDirs.make("pathscope-enforce-"));
  const root = path.join(parent, "workspace");
  const concealed = path.join(root, "concealed-dir");
  const straightDenied = path.join(root, "refused-dir");
  const plain = path.join(root, "plain-dir");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(plain, { recursive: true });
  await fs.writeFile(path.join(plain, "note.txt"), "plain content");
  // `refused-dir` exists in both fixtures: `deny` refuses access but stays listed, so it must not
  // become the difference the A/B comparison measures.
  await fs.mkdir(straightDenied, { recursive: true });
  await fs.writeFile(path.join(straightDenied, "note.txt"), "refused body");
  if (params.prepopulate) {
    await fs.mkdir(concealed, { recursive: true });
    await fs.writeFile(path.join(concealed, `note-${CANARY}.txt`), `secret body ${CANARY}`);
  }
  const config = {
    tools: {
      pathScopes: {
        byModel: {
          [params.ruleKey ?? params.modelProvider ?? "anthropic"]: {
            entries: [
              { path: concealed, mode: "deny+conceal" },
              { path: straightDenied, mode: "deny" },
            ],
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
  const policy = prepareCoreToolPolicy({
    config,
    modelProvider: params.modelProvider ?? "anthropic",
    modelId: params.modelId ?? "probe-model",
    workspaceOnly: false,
  });
  const tools = createCoreCodingTools({
    ...policy,
    codingRoot: root,
    containmentRoot: root,
    includeBaseCodingTools: true,
    shellTools: "patch-only",
    applyPatchEnabled: true,
    pathScopePolicy: resolvePathScopePolicy({
      cfg: config,
      modelProvider: params.modelProvider ?? "anthropic",
      modelId: params.modelId ?? "probe-model",
      cwd: root,
    }),
    execDefaults: {},
    processDefaults: {},
  });
  return { tools, root, concealed, straightDenied, plain };
}

function toolNamed(tools: Harness["tools"], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`tool ${name} is not registered`);
  }
  return tool;
}

async function textOf(result: unknown): Promise<string> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return JSON.stringify(result);
  }
  return content
    .map((block) => (block as { text?: string }).text ?? JSON.stringify(block))
    .join("\n");
}

describe("path scope enforcement at the shipped filesystem tools", () => {
  it("hides a concealed directory from ls and refuses reads and writes ENOENT-shaped", async () => {
    const harness = await buildHarness({ prepopulate: true });
    const listing = await textOf(
      await toolNamed(harness.tools, "ls").execute("ls-1", { path: harness.root }),
    );
    expect(listing).not.toContain("concealed-dir");
    // `deny` alone refuses access but leaves the name discoverable; only `deny+conceal` hides it.
    expect(listing).toContain("refused-dir");
    expect(listing).toContain("plain-dir");

    const write = toolNamed(harness.tools, "write");
    await expect(
      write.execute("w-1", { path: path.join(harness.concealed, "new.txt"), content: "x" }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Reads of the concealed path fail in the same shape as a missing file.
    const read = toolNamed(harness.tools, "read");
    const refusal = await read
      .execute("r-1", { path: path.join(harness.concealed, `note-${CANARY}.txt`) })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    expect(refusal.ok).toBe(false);
    const refusalText = JSON.stringify((refusal as { error: unknown }).error);
    expect(refusalText).toMatch(/ENOENT/);
  });

  it("keeps a deny-only path refused while still listing it", async () => {
    const harness = await buildHarness({ prepopulate: true });
    const listing = await textOf(
      await toolNamed(harness.tools, "ls").execute("ls-2", { path: harness.root }),
    );
    // `deny` refuses access but leaves the name discoverable, unlike `deny+conceal`.
    expect(listing).toContain("refused-dir");
    expect(listing).not.toContain("concealed-dir");
    const read = toolNamed(harness.tools, "read");
    await expect(
      read.execute("r-2", { path: path.join(harness.straightDenied, "note.txt") }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers identically whether the concealed path exists or not", async () => {
    const present = await buildHarness({ prepopulate: true });
    const absent = await buildHarness({ prepopulate: false });
    // Only the concealed target differs between the fixtures; the workspace root keeps the same
    // visible siblings, so any difference in the answers comes from the concealment itself.
    const outcome = async (harness: Harness) => ({
      listing: (
        await textOf(await toolNamed(harness.tools, "ls").execute("ls-3", { path: harness.root }))
      )
        .split("\n")
        .toSorted()
        .join("\n"),
      readError: await toolNamed(harness.tools, "read")
        .execute("r-3", { path: path.join(harness.concealed, `note-${CANARY}.txt`) })
        .then(
          () => "READ-SUCCEEDED",
          (error: unknown) => (error as { code?: string }).code ?? "",
        ),
      writeError: await toolNamed(harness.tools, "write")
        .execute("w-3", { path: path.join(harness.concealed, "made.txt"), content: "x" })
        .then(
          () => "WRITE-SUCCEEDED",
          (error: unknown) => (error as { code?: string }).code ?? "",
        ),
    });
    expect(await outcome(present)).toEqual(await outcome(absent));
  });

  it("never surfaces the canary token in any model-visible output", async () => {
    const harness = await buildHarness({ prepopulate: true });
    const seen: string[] = [];
    const record = async (value: unknown) => seen.push(JSON.stringify(value));
    // Operations that never name the concealed path: the token must not appear from discovery.
    for (const [name, args] of [
      ["ls", { path: harness.root }],
      ["read", { path: path.join(harness.root, "plain-dir") }],
      ["read", { path: path.join(harness.concealed, `wrong-name-${CANARY}x.txt`) }],
    ] as const) {
      await toolNamed(harness.tools, name)
        .execute(`${name}-${args.path}`, args)
        .then(record, record);
    }
    const all = seen.join("\n");
    expect(all.includes(CANARY)).toBe(false);
    expect(all.includes("concealed-dir")).toBe(false);
  });

  it("answers a covered path exactly like a genuinely absent one", async () => {
    const harness = await buildHarness({ prepopulate: true });
    const read = toolNamed(harness.tools, "read");
    const missing = path.join(harness.root, "plain-dir", "absent-name.txt");
    const covered = path.join(harness.concealed, "absent-name.txt");
    // Same tool, same kind of input: one path is covered, the other is simply not there. Only the
    // path the caller itself supplied may appear in the message, so the shapes must match.
    const shapeOf = async (target: string) =>
      read.execute("r-shape", { path: target }).then(
        () => ({ message: "SUCCEEDED", code: "" }),
        (error: unknown) => ({
          message: ((error as Error).message ?? String(error)).replace(target, "<requested>"),
          code: (error as { code?: string }).code ?? "",
        }),
      );
    expect(await shapeOf(covered)).toEqual(await shapeOf(missing));
  });

  it("leaves an unrestricted model and an unconfigured run untouched", async () => {
    // Rules exist for `anthropic` only; the same tools under `openai` must behave as before.
    const other = await buildHarness({
      prepopulate: true,
      modelProvider: "openai",
      ruleKey: "anthropic",
    });
    const listing = await textOf(
      await toolNamed(other.tools, "ls").execute("ls-4", { path: other.root }),
    );
    expect(listing).toContain("concealed-dir");
    expect(listing).toContain("refused-dir");
    const read = toolNamed(other.tools, "read");
    const result = await read.execute("r-4", {
      path: path.join(other.concealed, `note-${CANARY}.txt`),
    });
    expect(await textOf(result)).toContain(CANARY);
  });

  it("refuses a patch that names a covered path without writing the allowed half", async () => {
    const harness = await buildHarness({ prepopulate: true });
    const allowed = path.join(harness.plain, "patched.txt");
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${allowed}`,
      "+allowed body",
      `*** Add File: ${path.join(harness.concealed, "added.txt")}`,
      "+hidden body",
      "*** End Patch",
    ].join("\n");
    const applyPatch = toolNamed(harness.tools, "apply_patch");
    await expect(applyPatch.execute("p-1", { input: patch })).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The batch is refused as a whole: the allowed target must not exist afterwards.
    await expect(fs.stat(allowed)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("issues byte-identical tool definitions with and without path rules", async () => {
    const withRules = await buildHarness({ prepopulate: true });
    const withoutRules = await buildHarness({
      prepopulate: true,
      modelProvider: "unconfigured",
      ruleKey: "anthropic",
    });
    const project = (harness: Harness) =>
      toToolDefinitions(harness.tools).map((definition) => ({
        name: definition.name,
        description: definition.description,
      }));
    expect(project(withRules)).toEqual(project(withoutRules));
  });
});

describe("read-tool fallbacks under path rules", () => {
  it("refuses a typographic-quote spelling that the variant search would rewrite", async () => {
    const harness = await buildHarness({ prepopulate: true });
    const read = toolNamed(harness.tools, "read");
    // A straight-quote name resolves to the typographic variant under the read tool's search; the
    // admission hook runs on the resolved file, so the rewrite cannot route around the rule.
    const variant = path
      .join(harness.concealed, `note-${CANARY}.txt`)
      .replace(".txt", "\u2019.txt");
    await expect(read.execute("r-var", { path: variant })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not offer a concealed file through the did-you-mean list", async () => {
    const harness = await buildHarness({ prepopulate: true });
    const read = toolNamed(harness.tools, "read");
    // A misspelt sibling of a concealed file: the near-miss path itself may echo back (the caller
    // supplied it), but the concealed file's real name must never be suggested to the model.
    const nearMiss = path.join(harness.concealed, `note-${CANARY}x.txt`);
    const outcome = await read.execute("r-sug", { path: nearMiss }).then(
      (value) => JSON.stringify(value),
      (error: unknown) => (error as Error).message ?? String(error),
    );
    expect(outcome).not.toContain(`note-${CANARY}.txt`);
    expect(outcome).not.toContain("Did you mean");
  });
});
