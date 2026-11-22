import { hash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../packages/ai/src/host.js";
import { createOpenAICompletionsTransportStreamFn } from "../../packages/ai/src/transports/openai-completions-transport.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { wrapStreamFnWithProviderPromptState } from "../agents/embedded-agent-runner/provider-prompt-state.js";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { Agent, type AgentOptions } from "../agents/runtime/index.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createInstalledSkillTools } from "../agents/tools/installed-skill-tools.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { runAgentExecWithMock } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

// Runs the real agent loop, native read, subscriber, serialization and exec projection.
// Only command bootstrap and external HTTP I/O are fixtures; no external model executes.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalHost = getAiTransportHost();
const model = makeProviderModelFixture<"openai-completions">({
  id: "fixture-model",
  api: "openai-completions",
  provider: "fixture-self-hosted",
  baseUrl: "https://provider.invalid/v1",
});
const body = "---\r\nname: guide\r\n---\r\n\r\nFollow the complete café 🦞 workflow.\r\n";
const toolCallId = "read-guide";

afterEach(() => {
  configureAiTransportHost(originalHost);
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

function response(first: boolean) {
  const delta = first
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: toolCallId,
            type: "function",
            function: { name: "skills_read", arguments: '{"name":"guide"}' },
          },
        ],
      }
    : { role: "assistant", content: "done" };
  return new Response(
    `data: ${JSON.stringify({
      id: "fixture-response",
      object: "chat.completion.chunk",
      created: 0,
      model: model.id,
      choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function run(params: {
  receipt?: boolean;
  onPayload?: AgentOptions["onPayload"];
  afterRead?: (file: string) => Promise<void>;
  content?: string;
}) {
  const cwd = tempDirs.make("openclaw-skill-exposure-");
  const file = path.join(cwd, "SKILL.md");
  await writeFile(file, params.content ?? body);
  const wires: string[] = [];
  configureAiTransportHost({
    ...originalHost,
    buildModelFetch: () => async (input, init) => {
      wires.push(await new Request(input, init).text());
      return response(wires.length === 1);
    },
  });
  const runtime = createTestRuntime();
  const result = await runAgentExecWithMock(
    "Read guide, then finish.",
    {
      cwd,
      isolated: true,
      authEnvOnly: true,
      json: true,
      skillExposureReceipt: params.receipt,
    },
    runtime,
    async (opts) => {
      const runId = opts.runId ?? "opt-out-fixture";
      const tools = createInstalledSkillTools(
        [
          {
            name: "guide",
            description: "Guide",
            location: "skill://guide",
            source: { filePath: file },
          },
        ],
        opts.skillExposure ? runId : undefined,
      );
      const { emit, subscription } = createSubscribedSessionHarness({
        runId,
        onAgentToolResult: opts.onAgentToolResult,
      });
      const agent = new Agent({
        initialState: { model, tools, systemPrompt: "Read the named skill." },
        getApiKey: () => "synthetic-fixture-key",
        streamFn: wrapStreamFnWithProviderPromptState({
          streamFn: createOpenAICompletionsTransportStreamFn(),
          state: {},
          effectiveContextTokenBudget: 16_000,
          ...(opts.skillExposure
            ? { skillExposure: { runId, collector: opts.skillExposure } }
            : {}),
        }),
        onPayload: params.onPayload,
        afterToolCall: async () => {
          await params.afterRead?.(file);
          return undefined;
        },
      });
      const unsubscribeAgent = agent.subscribe(emit);
      try {
        await opts.onActiveModelSelected?.({ provider: model.provider, model: model.id });
        await agent.prompt({ role: "user", content: opts.message, timestamp: 0 });
        await subscription.waitForPendingEvents();
        const assistant = agent.state.messages.findLast((message) => message.role === "assistant");
        if (assistant?.role !== "assistant" || assistant.stopReason !== "stop") {
          throw new Error("Fixture agent did not complete");
        }
        return {
          payloads: [{ text: "done" }],
          meta: {
            durationMs: 0,
            agentMeta: {
              sessionId: expectDefined(opts.sessionId, "exec session ID"),
              provider: model.provider,
              model: model.id,
            },
          },
        };
      } finally {
        unsubscribeAgent();
        subscription.unsubscribe();
      }
    },
  );
  return { ...result, wires, runtime };
}

it("receipts exact served instructions after serialization without changing request bytes", async () => {
  const plain = await run({});
  const observed = await run({ receipt: true });
  expect(plain.envelope).not.toHaveProperty("loadedSkills");
  expect(plain.envelope).not.toHaveProperty("skillExposure");
  expect(observed.exitCode).toBe(0);
  expect(observed.wires).toEqual(plain.wires);
  expect(observed.wires).toHaveLength(2);
  expect(observed.envelope.skillExposure).toEqual({
    version: 1,
    status: "available",
    scope: "native-skills-read/openai-completions",
  });
  expect(observed.envelope.loadedSkills).toEqual([
    {
      name: "guide",
      sha256: hash("sha256", body),
      bytes: Buffer.byteLength(body),
      toolCallId,
      runId: expect.any(String),
      requestIndex: 2,
      requestSha256: hash("sha256", expectDefined(observed.wires[1], "second serialized request")),
    },
  ]);
  expect(observed.runtime.log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(observed.runtime.log.mock.calls[0]?.[0]))).toEqual(observed.envelope);
  const evidence = JSON.stringify({
    loadedSkills: observed.envelope.loadedSkills,
    skillExposure: observed.envelope.skillExposure,
  });
  expect(evidence).not.toContain("café");
  expect(evidence).not.toContain("skill://guide");
  expect(evidence).not.toContain("synthetic-fixture-key");
});

it("accepts a whole provider reply even when the sanitized observer view shortens its text", async () => {
  const content = "Whole instructions.\n" + "x".repeat(9000);
  const result = await run({ receipt: true, content });
  expect(result.envelope.skillExposure?.status).toBe("available");
  expect(result.envelope.loadedSkills).toEqual([
    expect.objectContaining({ name: "guide", sha256: hash("sha256", content) }),
  ]);
});

it("hashes the read snapshot even if the backing file changes before the next request", async () => {
  const result = await run({
    receipt: true,
    afterRead: async (file) => {
      await writeFile(file, "replacement after read");
      expect(await readFile(file, "utf8")).toBe("replacement after read");
    },
  });
  expect(result.envelope.loadedSkills).toEqual([
    expect.objectContaining({ name: "guide", sha256: hash("sha256", body) }),
  ]);
});

it.each(["different body", "truncated", "budget notice", "dedup notice", "toJSON"])(
  "does not use details.content as proof when the serialized tool text is %s",
  async (mode) => {
    const result = await run({
      receipt: true,
      onPayload(payload) {
        if (!payload || typeof payload !== "object" || !("messages" in payload)) {
          throw new Error("Expected Chat Completions payload");
        }
        const request = payload as { messages: Array<{ role: string; content: unknown }> };
        for (const message of request.messages) {
          if (message.role !== "tool") {
            continue;
          }
          message.content =
            mode === "toJSON"
              ? { toJSON: () => "different serialization" }
              : mode === "truncated"
                ? String(message.content).slice(0, -10)
                : mode;
        }
      },
    });
    expect(result.envelope.skillExposure?.status).toBe("available");
    expect(result.envelope.loadedSkills).toEqual([]);
  },
);

it("does not receipt a rejected oversized native read", async () => {
  const result = await run({ receipt: true, content: "x".repeat(256 * 1024 + 1) });
  expect(result.exitCode).toBe(0);
  expect(result.envelope.skillExposure?.status).toBe("available");
  expect(result.envelope.loadedSkills).toEqual([]);
});

it("reports unavailable when command bootstrap never reaches a trusted request owner", async () => {
  const result = await runAgentExecWithMock(
    "inspect",
    { json: true, skillExposureReceipt: true, timeout: "invalid", isolated: true },
    createTestRuntime(),
    async () => {
      throw new Error("Unexpected agent execution");
    },
  );
  expect(result.envelope).toMatchObject({
    status: "error",
    loadedSkills: [],
    skillExposure: { status: "unavailable", reason: "no_serialized_request" },
  });
});

it("requires JSON before touching config or starting a run", async () => {
  const result = await runAgentExecWithMock(
    "inspect",
    { skillExposureReceipt: true },
    createTestRuntime(),
    async () => {
      throw new Error("Unexpected agent execution");
    },
  );
  expect(result.envelope.error?.message).toBe("--skill-exposure-receipt requires --json.");
});
