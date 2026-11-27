import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECISION_REJECTION_MARKER } from "./decision-bridge.js";
import { resolveLobsterCwd } from "./lobster-runner.js";
import { createLobsterTool } from "./lobster-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = { ok: true, status: "ok" as const, output: [], requiresApproval: null };

async function createWorkflow() {
  const cwd = tempDirs.make("openclaw-lobster-runner-");
  const filePath = path.join(cwd, "workflow.lobster");
  await fs.writeFile(filePath, "steps: []\n", "utf8");
  return { cwd, filePath };
}

it("resolves relative Lobster paths inside the repo root", () => {
  for (const relative of ["extensions/lobster", "demo ", " demo", "demo\t"]) {
    expect(resolveLobsterCwd(relative)).toBe(path.resolve(process.cwd(), relative));
  }
});

describe("createEmbeddedLobsterRunner", () => {
  const runRequest = vi.fn<(params: { ctx?: { signal?: AbortSignal } }) => Promise<unknown>>();
  const resumeRequest = vi.fn<() => Promise<unknown>>();
  let tool: ReturnType<typeof createLobsterTool>;
  const run = async (overrides: Record<string, unknown> = {}) =>
    (
      await tool.execute("test", {
        action: "run",
        pipeline: "exec --json=true echo hi",
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
        ...overrides,
      })
    ).details;
  beforeEach(() => {
    runRequest.mockReset();
    resumeRequest.mockReset();
    vi.doMock("@clawdbot/lobster/core", () => ({
      runToolRequest: runRequest,
      resumeToolRequest: resumeRequest,
    }));
    tool = createLobsterTool();
  });

  it("applies a numeric-string output limit through the tool to embedded workflows", async () => {
    runRequest.mockResolvedValue({ ...success, output: ["x".repeat(1024)] });
    const { cwd } = await createWorkflow();
    await fs.writeFile(path.join(cwd, " workflow.lobster"), "steps: []\n");
    const currentDirectory = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      for (const pipeline of ["workflow.lobster", " workflow.lobster"]) {
        await expect(run({ pipeline, maxStdoutBytes: "1024" })).rejects.toThrow(
          "lobster runtime result exceeded maxStdoutBytes",
        );
        expect(runRequest).toHaveBeenLastCalledWith(
          expect.objectContaining({ filePath: path.join(cwd, pipeline) }),
        );
      }
    } finally {
      currentDirectory.mockRestore();
    }
  });

  it("runs inline pipelines with file-like arguments through the embedded runtime", async () => {
    runRequest.mockResolvedValue({ ...success, protocolVersion: 1, output: [{ hello: "world" }] });
    const pipeline = "exec --json=true cat data.json";
    const envelope = await run({ pipeline });
    expect(runRequest.mock.calls[0]?.[0].ctx).toMatchObject({ mode: "tool" });
    expect(runRequest.mock.calls[0]?.[0].ctx?.signal).toBeInstanceOf(AbortSignal);
    expect(envelope).toEqual({ ...success, output: [{ hello: "world" }] });
  });

  it.each(["missing.lobster", "workflow.lobster"])(
    "rejects invalid workflow request: %s",
    async (pipeline) => {
      const { cwd } = await createWorkflow();
      const rejection = expect(
        run({ pipeline: path.join(cwd, pipeline), argsJson: "{bad" }),
      ).rejects;
      if (pipeline === "missing.lobster") {
        await rejection.toMatchObject({ code: "ENOENT", path: path.join(cwd, pipeline) });
      } else {
        await rejection.toThrow("run --args-json must be valid JSON");
      }
      expect(runRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects an input request without a resumable checkpoint", async () => {
    runRequest.mockResolvedValue({ ...success, status: "needs_input" });
    await expect(run()).rejects.toThrow("Lobster input request is missing its resume token");
  });

  it("forwards approvalId through resume when token is absent", async () => {
    const { runtime, runner } = createRunner();
    runtime.resumeToolRequest.mockResolvedValue(success);

    await runner.run(
      runParams({ action: "resume", pipeline: undefined, approvalId: "dbc98d05", approve: true }),
    );

    expect(runtime.resumeToolRequest).toHaveBeenCalledExactlyOnceWith({
      approvalId: "dbc98d05",
      approved: true,
      ctx: toolContext(),
    });
  });

  it("forwards a per-call registry into the embedded context for run and resume", async () => {
    const { runtime } = createRunner();
    runtime.runToolRequest.mockResolvedValue(success);
    runtime.resumeToolRequest.mockResolvedValue({ ...success, status: "cancelled" });
    const registry = { get: () => undefined, list: () => [] };
    const createRegistry = vi.fn(() => registry);
    const withRegistry = createEmbeddedLobsterRunner({
      loadRuntime: async () => runtime,
      createRegistry,
    });

    await withRegistry.run(runParams());
    await withRegistry.run(
      runParams({ action: "resume", pipeline: undefined, token: "resume-token", approve: true }),
    );

    // Rebuilt per invocation: no call inherits another invocation's registry.
    expect(createRegistry).toHaveBeenCalledTimes(2);
    expect(runtime.runToolRequest.mock.calls[0]?.[0].ctx?.registry).toBe(registry);
    expect(runtime.resumeToolRequest.mock.calls[0]?.[0].ctx?.registry).toBe(registry);
  });

  it("keeps the core default registry when no provider is supplied", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue(success);

    await runner.run(runParams());

    expect(runtime.runToolRequest.mock.calls[0]?.[0].ctx?.registry).toBeUndefined();
  });

  it("refuses to report a stopped bridge rejection as a successful run", async () => {
    const { runtime, runner } = createRunner();
    // The inline-pipeline path reports a non-approval halt as `ok` with the halted item as
    // output; an unresolved decision must not look like a completed step. The marker is the real
    // symbol, which is what the bridge attaches.
    const item: Record<string | symbol, unknown> = { status: "rejected", reason: "transport" };
    item[DECISION_REJECTION_MARKER] = true;
    runtime.runToolRequest.mockResolvedValue({ ...success, output: [item] });

    await expect(runner.run(runParams())).rejects.toThrow(/rejected the decision: transport/);
  });

  it("does not mistake ordinary workflow JSON for a bridge rejection", async () => {
    const { runtime, runner } = createRunner();
    // A plain JSON field with the same name must not be read as bridge control data: the real
    // marker is a symbol that JSON can never produce.
    runtime.runToolRequest.mockResolvedValue({
      ...success,
      output: [{ status: "ok", decisionBridgeRejection: true, reason: "business data" }],
    });

    const envelope = await runner.run(runParams());
    expect(envelope.status).toBe("ok");
    expect(envelope.output).toEqual([
      { status: "ok", decisionBridgeRejection: true, reason: "business data" },
    ]);
  });

  it("fails the run instead of the process when a sink exceeds its cap", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockImplementation(async ({ ctx }) => {
      ctx.stderr?.write("x".repeat(4096));
      return success;
    });

    await expect(runner.run(runParams({ maxStdoutBytes: 1024 }))).rejects.toThrow(
      /stderr exceeded maxStdoutBytes/,
    );
  });

  it("loads the embedded runtime once per runner", async () => {
    const { runtime, loadRuntime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue(success);
    runtime.resumeToolRequest.mockResolvedValue({ ...success, status: "cancelled" });

    await runner.run(runParams());
    await runner.run(
      runParams({ action: "resume", pipeline: undefined, token: "resume-token", approve: false }),
    );
  });

  it.each<[Record<string, unknown>, RegExp]>([
    [{ action: "run", pipeline: undefined }, /pipeline required/],
    [{ token: undefined, approve: true }, /token or approvalId required/],
    [{}, /exactly one/],
    [{ responseJson: "{bad" }, /responseJson must be valid JSON/],
    [{ approve: true, responseJson: "null" }, /exactly one/],
    [{ cancel: false }, /cancel must be true/],
  ])("rejects invalid arguments before touching state: %j", async (params, error) => {
    await expect(run({ action: "resume", token: "resume-token", ...params })).rejects.toThrow(
      error,
    );
    expect(runRequest).not.toHaveBeenCalled();
    expect(resumeRequest).not.toHaveBeenCalled();
  });

  it("applies a numeric-string timeout through the tool and aborts embedded work", async () => {
    runRequest.mockImplementation(
      ({ ctx: context }) =>
        new Promise((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => {
            reject(
              toErrorObject(context.signal?.reason ?? new Error("aborted"), "Non-Error rejection"),
            );
          });
        }),
    );
    await expect(run({ timeoutMs: "200" })).rejects.toThrow(/timed out|aborted/);
  });
});
