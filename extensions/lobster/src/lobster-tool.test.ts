import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createLobsterTool } from "./lobster-tool.js";

afterEach(() => vi.unstubAllEnvs());

const requireRecord = createRequireRecord("record", "expected-label-record");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resumeToken(details: unknown, field = "requiresInput") {
  const envelope = requireRecord(details, "Lobster envelope");
  const request = requireRecord(envelope[field], field);
  if (typeof request.resumeToken !== "string") {
    throw new Error("expected a resume token");
  }
  return request.resumeToken;
}

describe("lobster plugin tool", () => {
  let tool: ReturnType<typeof createLobsterTool>;
  let dir: string;
  beforeEach(() => {
    tool = createLobsterTool();
    dir = tempDirs.make("openclaw-lobster-tool-");
    vi.stubEnv("LOBSTER_STATE_DIR", dir);
  });
  const run = async (pipeline: string) =>
    (await tool.execute("run", { action: "run", pipeline })).details;
  const resume = async (
    token: string,
    decision: { responseJson?: string; approve?: boolean; cancel?: boolean },
  ) => (await tool.execute("resume", { action: "resume", token, ...decision })).details;
  const inputStep = (id: string, prompt: string, responseSchema: object, defaults?: object) => ({
    id,
    input: { prompt, responseSchema, ...(defaults ? { defaults } : {}) },
  });

  it("resumes real pipeline input, preserves invalid answers, and still handles approvals", async () => {
    const first = await run('ask --prompt "Review draft?" | approve --prompt "Publish?"');
    expect(first).toMatchObject({
      status: "needs_input",
      requiresInput: { type: "input_request", prompt: "Review draft?" },
    });
    const token = resumeToken(first);
    await expect(resume(token, { responseJson: '{"decision":123}' })).rejects.toThrow(
      /schema validation/,
    );
    const responseJson = '{"decision":"approve","feedback":"Looks good"}';
    const second = await resume(token, { responseJson });
    expect(second).toMatchObject({ status: "needs_approval" });
    const approved = await resume(resumeToken(second, "requiresApproval"), { approve: true });
    expect(approved).toMatchObject({
      status: "ok",
      output: [{ decision: "approve", feedback: "Looks good" }],
    });
    await expect(resume(token, { responseJson: '{"decision":"reject"}' })).rejects.toThrow(
      /not found/i,
    );
  });

  it("resumes real workflow files through successive questions without repeating preparation", async () => {
    const seed = path.join(dir, "seed.json");
    await fs.writeFile(seed, JSON.stringify({ draft: "original" }));
    const file = path.join(dir, "review.lobster");
    await fs.writeFile(
      file,
      JSON.stringify({
        steps: [
          { id: "prepare", pipeline: "state.get seed | state.set prepared" },
          inputStep("review", "Review?", { type: "object" }, { feedback: "" }),
          inputStep("confirm", "Which label?", { type: "string" }),
          { id: "finish", pipeline: "state.get prepared" },
        ],
      }),
    );
    const first = await run(file);
    expect(first).toMatchObject({
      status: "needs_input",
      requiresInput: { defaults: { feedback: "" }, subject: { draft: "original" } },
    });
    await fs.writeFile(seed, JSON.stringify({ draft: "changed" }));
    const second = await resume(resumeToken(first), { responseJson: '{"feedback":"Keep it"}' });
    expect(second).toMatchObject({
      status: "needs_input",
      requiresInput: { prompt: "Which label?" },
    });
    // A new tool instance proves continuation comes from saved state, not the runner's memory.
    const continued = createLobsterTool();
    expect(continued.parameters).toBe(tool.parameters);
    const finished = await continued.execute("finish", {
      action: "resume",
      token: resumeToken(second),
      responseJson: '"reviewed"',
    });
    expect(finished.details).toMatchObject({ status: "ok", output: [{ draft: "original" }] });
  });

  it("cancels a real input checkpoint without executing its remaining steps", async () => {
    const token = resumeToken(await run("ask | state.set should-not-exist"));
    expect(await resume(token, { cancel: true })).toMatchObject({ status: "cancelled" });
    await expect(fs.stat(path.join(dir, "should-not-exist.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(resume(token, { responseJson: '{"decision":"approve"}' })).rejects.toThrow(
      /not found/i,
    );
  });

  it("registers ordinary execution without a task runtime and keeps sandbox gating", () => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register(createTestPluginApi({ registerTool }));
    const factory = registerTool.mock.calls[0]?.[0];
    if (typeof factory !== "function") {
      throw new Error("expected a registered Lobster tool factory");
    }
    expect(factory({ sandboxed: false })).toMatchObject({ name: "lobster" });
    expect(factory({ sandboxed: true })).toBeNull();
  });

<<<<<<< OURS/upstream-11.10
  it.each<[string, Record<string, unknown>, RegExp]>([
    ["missing action", {}, /action required/],
    ["unknown action", { action: "explode" }, /Unknown action/],
    ["absolute cwd", { action: "run", cwd: "/tmp" }, /cwd must be a relative path/],
    ["escaping cwd", { action: "run", pipeline: "noop", cwd: "../../etc" }, /must stay within/],
  ])("rejects %s", async (_name, params, error) => {
    await expect(tool.execute("invalid", params)).rejects.toThrow(error);
||||||| BASE/v11.4
  it("normalizes numeric string run limits before invoking the runner", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    vi.mocked(createEmbeddedLobsterRunner).mockReturnValueOnce(runner);
    const tool = createLobsterTool(fakeApi());
    await tool.execute("call-string-limits", {
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      timeoutMs: "1500",
      maxStdoutBytes: "4096",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
  });

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-absolute-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-escape-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "../../etc",
      }),
    ).rejects.toThrow(/must stay within/);
=======
  it("normalizes numeric string run limits before invoking the runner", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({
        ok: true,
        status: "ok",
        output: [],
        requiresApproval: null,
      }),
    };

    vi.mocked(createEmbeddedLobsterRunner).mockReturnValueOnce(runner);
    const tool = createLobsterTool(fakeApi());
    await tool.execute("call-string-limits", {
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      timeoutMs: "1500",
      maxStdoutBytes: "4096",
    });

    expect(runner.run).toHaveBeenCalledWith({
      action: "run",
      pipeline: "noop",
      argsJson: '{"since_hours":1}',
      cwd: process.cwd(),
      timeoutMs: 1500,
      maxStdoutBytes: 4096,
    });
  });

  it("hands the wrapped registry to the runner and rebuilds it per run", async () => {
    const runner = {
      run: vi
        .fn()
        .mockResolvedValue({ ok: true, status: "ok", output: [], requiresApproval: null }),
    };
    vi.mocked(createEmbeddedLobsterRunner).mockReturnValueOnce(runner);
    const tool = createLobsterTool(fakeApi(), fakeCtx({ agentId: "main" }));
    await tool.execute("call", { action: "run", pipeline: "noop" });

    const options = vi.mocked(createEmbeddedLobsterRunner).mock.calls.at(-1)?.[0];
    expect(typeof options?.createRegistry).toBe("function");
    // The provider defers to the loaded core, so it is callable more than once.
    expect(options?.createRegistry?.constructor).toBe(Function);
  });

  it("fails closed in the bridged command when the tool context carries no agent id", async () => {
    // Load the real core so the tool's registry provider can build a real command, then
    // prove the empty agent id reaches the bridge and refuses to evaluate.
    const { loadedLobsterCore } =
      await vi.importActual<typeof import("./lobster-runner.js")>("./lobster-runner.js");
    await createEmbeddedLobsterRunner().run({ action: "run", pipeline: "commands.list" });
    const core = loadedLobsterCore();
    expect(typeof core.createDefaultRegistry).toBe("function");

    const evaluate = vi.fn(async () => ({
      status: "ok" as const,
      result: { model: "m", answers: {} },
      provenance: { providerId: "p", rubricVersion: "r", runtimeGeneration: "g" },
    }));
    const { createLobsterRegistry } =
      await vi.importActual<typeof import("./decision-bridge.js")>("./decision-bridge.js");
    const registry = createLobsterRegistry(core.createDefaultRegistry(), {
      evaluate: evaluate as never,
      agentId: "",
      purpose: "test",
    });
    const command = registry.get("decision.evaluate");
    // The refusal is a terminal halt, not a throw: a step-level on_error could otherwise
    // recover a route that was never resolved.
    const result = await command!.run({
      input: (async function* () {})(),
      args: {
        "questions-json": JSON.stringify({ route: { type: "boolean" } }),
        "state-json": "{}",
        "min-probability": "0.9",
      },
      ctx: { signal: new AbortController().signal, stderr: { write: () => true } } as never,
    });
    expect(result?.halt).toBe(true);
    const items: unknown[] = [];
    for await (const item of result!.output as AsyncIterable<unknown>) {
      items.push(item);
    }
    expect(items[0]).toMatchObject({ status: "rejected" });
    expect(items[0]).not.toHaveProperty("route");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("requires action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(tool.execute("call-action-missing", {})).rejects.toThrow(/action required/);
  });

  it("rejects unknown action", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-action-unknown", {
        action: "explode",
      }),
    ).rejects.toThrow(/Unknown action/);
  });

  it("rejects absolute cwd", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-absolute-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/cwd must be a relative path/);
  });

  it("rejects cwd that escapes the gateway working directory", async () => {
    const tool = createLobsterTool(fakeApi());
    await expect(
      tool.execute("call-escape-cwd", {
        action: "run",
        pipeline: "noop",
        cwd: "../../etc",
      }),
    ).rejects.toThrow(/must stay within/);
>>>>>>> THEIRS/pro-main
  });
});
