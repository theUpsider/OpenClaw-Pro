import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DECISION_REJECTION_MARKER } from "./decision-bridge.js";
import {
  createEmbeddedLobsterRunner,
  resolveLobsterCwd,
  type LobsterRunnerParams,
} from "./lobster-runner.js";

type RuntimeLoader = NonNullable<
  NonNullable<Parameters<typeof createEmbeddedLobsterRunner>[0]>["loadRuntime"]
>;
type Runtime = Awaited<ReturnType<RuntimeLoader>>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = {
  ok: true,
  protocolVersion: 1,
  status: "ok" as const,
  output: [],
  requiresApproval: null,
};

function createRunner() {
  const runtime = {
    runToolRequest: vi.fn<Runtime["runToolRequest"]>(),
    resumeToolRequest: vi.fn<Runtime["resumeToolRequest"]>(),
  };
  const loadRuntime = vi.fn().mockResolvedValue(runtime);
  return { runtime, loadRuntime, runner: createEmbeddedLobsterRunner({ loadRuntime }) };
}

function runParams(overrides: Partial<LobsterRunnerParams> = {}): LobsterRunnerParams {
  return {
    action: "run",
    pipeline: "exec --json=true echo hi",
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxStdoutBytes: 4096,
    ...overrides,
  };
}

async function createWorkflow(name = "workflow.lobster") {
  const cwd = tempDirs.make("openclaw-lobster-runner-");
  const filePath = path.join(cwd, name);
  await fs.writeFile(filePath, "steps: []\n", "utf8");
  return { cwd, filePath };
}

const toolContext = (cwd = process.cwd()) =>
  expect.objectContaining({ cwd, mode: "tool", signal: expect.any(AbortSignal) });

describe("resolveLobsterCwd", () => {
  it("keeps relative paths inside the repo root", () => {
    expect(resolveLobsterCwd("extensions/lobster")).toBe(
      path.resolve(process.cwd(), "extensions/lobster"),
    );
  });
});

describe("createEmbeddedLobsterRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds the model-visible result for an embedded workflow request", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({
      ...success,
      output: Array.from({ length: 115 }, () => ({ a: 1 })),
    });
    const { cwd, filePath } = await createWorkflow();

    await expect(
      runner.run(runParams({ pipeline: filePath, cwd, maxStdoutBytes: 1024 })),
    ).rejects.toThrow("lobster runtime result exceeded maxStdoutBytes");
  });

  it("runs inline pipelines with file-like arguments through the embedded runtime", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({ ...success, output: [{ hello: "world" }] });
    const pipeline = "exec --json=true cat data.json";

    const envelope = await runner.run(runParams({ pipeline }));

    expect(runtime.runToolRequest).toHaveBeenCalledExactlyOnceWith({
      pipeline,
      ctx: toolContext(),
    });
    expect(runtime.runToolRequest.mock.calls[0]?.[0].filePath).toBeUndefined();
    expect(envelope).toEqual({
      ok: true,
      status: "ok",
      output: [{ hello: "world" }],
      requiresApproval: null,
    });
  });

  it("surfaces missing workflow path errors", async () => {
    const { runtime, runner } = createRunner();
    const cwd = tempDirs.make("openclaw-lobster-runner-");

    await expect(runner.run(runParams({ pipeline: "missing.lobster", cwd }))).rejects.toMatchObject(
      {
        code: "ENOENT",
        path: path.join(cwd, "missing.lobster"),
      },
    );
    expect(runtime.runToolRequest).not.toHaveBeenCalled();
  });

  it("returns a parse error when workflow args are invalid JSON", async () => {
    const { runtime, runner } = createRunner();
    const { cwd } = await createWorkflow();

    await expect(
      runner.run(runParams({ pipeline: "workflow.lobster", argsJson: "{bad", cwd })),
    ).rejects.toThrow("run --args-json must be valid JSON");
    expect(runtime.runToolRequest).not.toHaveBeenCalled();
  });

  it("rejects an input request without a resumable checkpoint", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockResolvedValue({ ...success, status: "needs_input" });

    await expect(runner.run(runParams())).rejects.toThrow(
      "Lobster input request is missing its resume token",
    );
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

    expect(loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("requires a pipeline for run", async () => {
    const { runner } = createRunner();

    await expect(runner.run(runParams({ pipeline: undefined }))).rejects.toThrow(
      /pipeline required/,
    );
  });

  it("requires a checkpoint and a decision for resume", async () => {
    const { runner } = createRunner();

    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, approve: true })),
    ).rejects.toThrow(/token or approvalId required/);
    await expect(
      runner.run(runParams({ action: "resume", pipeline: undefined, token: "resume-token" })),
    ).rejects.toThrow(/exactly one/);
  });

  it.each([{ responseJson: "{bad" }, { approve: true, responseJson: "null" }, { cancel: false }])(
    "rejects invalid or ambiguous resume arguments before touching state: %j",
    async (decision) => {
      const { runtime, runner } = createRunner();
      await expect(
        runner.run(runParams({ action: "resume", token: "resume-token", ...decision })),
      ).rejects.toThrow();
      expect(runtime.resumeToolRequest).not.toHaveBeenCalled();
    },
  );

  it("aborts long-running embedded work", async () => {
    const { runtime, runner } = createRunner();
    runtime.runToolRequest.mockImplementation(
      async ({ ctx }) =>
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve(success), 500);
          ctx?.signal?.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(
              toLintErrorObject(ctx.signal?.reason ?? new Error("aborted"), "Non-Error rejection"),
            );
          });
        }),
    );

    await expect(runner.run(runParams({ timeoutMs: 200 }))).rejects.toThrow(/timed out|aborted/);
  });
});
