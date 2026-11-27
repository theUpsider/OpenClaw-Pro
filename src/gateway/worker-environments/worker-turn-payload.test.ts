import assert from "node:assert/strict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES as MAX_BYTES,
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES as MAX_MESSAGES,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  WORKER_CONTEXT_MAX_RESIDUAL_BYTES,
  WORKER_PROTOCOL_MAX_NON_IMAGE_PAYLOAD_BYTES,
  WORKER_MESSAGE_MAX_TEXT_BYTES,
} from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { buildRuntimeContextCustomMessage } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import { testWorkerDescriptor } from "../../node-host/node-worker-supervisor.test-support.js";
import {
  parseWorkerLaunchDescriptor,
  parseWorkerLaunchPlan,
  type WorkerLaunchPlan,
} from "../../worker/launch-descriptor.js";
import { parseNodeWorkerLaunchInput } from "../../worker/node-supervisor-protocol.js";
import { createWorkerImageHistory } from "../../worker/replay-images.test-support.js";
import { WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES } from "../../worker/worker-connection-endpoint.js";
import { parseWorkerProcessRequest } from "../../worker/worker-process-protocol.js";
import { measureNodeWorkerLaunchBytes } from "./node-launch-adapter.js";
import {
  fitLaunchDescriptorWithRuntimeIdentity,
  windowInitialMessages,
} from "./worker-turn-payload.js";

const runtimeIdentityToken = vi.hoisted(() => ({
  value: "fixture-runtime-identity-token",
  measure: vi.fn(() => Buffer.byteLength("fixture-runtime-identity-token", "utf8")),
  mint: vi.fn(
    async (_params: { operationalRunInstance: OperationalRunInstanceRef }) =>
      "fixture-runtime-identity-token",
  ),
}));

vi.mock("../agent-runtime-identity-token.js", () => ({
  measureAgentRuntimeIdentityTokenBytes: runtimeIdentityToken.measure,
  mintAgentRuntimeIdentityToken: runtimeIdentityToken.mint,
}));

const PROVIDER_REPLAY = {
  v: 1 as const,
  type: "openai-responses-compaction",
  data: "opaque-worker-replay",
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.6-luna",
  baseUrlHash: "ozhevd1smnk8s",
};
type Messages = WorkerLaunchPlan["assignment"]["initialMessages"];
let runInstance: OperationalRunInstanceRef;

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function userHistory(count: number, prefix: string, start = 1) {
  return Array.from({ length: count }, (_, index) =>
    userMessage(`${prefix}-${index}`, start + index),
  );
}

function assistantMessage(timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "visible" }],
    api: PROVIDER_REPLAY.api,
    provider: PROVIDER_REPLAY.provider,
    model: PROVIDER_REPLAY.model,
    providerReplay: structuredClone(PROVIDER_REPLAY),
    usage: { ...createZeroUsageFixture(), input: 1, output: 1, totalTokens: 2 },
    stopReason: "stop",
    timestamp,
  };
}

function toolResultMessage(details: unknown, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-replay",
    toolName: "read",
    content: [{ type: "text", text: "result" }],
    details,
    isError: false,
    timestamp,
  };
}

function buildDescriptor(messages: Messages, token = runtimeIdentityToken.value): WorkerLaunchPlan {
  const plan = testWorkerDescriptor("/tmp/workspace", "prompt", "turn");
  Object.assign(plan.assignment, {
    agentId: "main",
    operationalRunInstance: runInstance,
    agentRuntimeIdentityToken: token,
    runId: "run",
    suppressPromptTranscript: true,
    modelRef: { provider: "openai", model: "gpt-5.6-luna" },
    initialMessages: messages,
  });
  return plan;
}

function launchInput(plan: WorkerLaunchPlan): Parameters<typeof measureNodeWorkerLaunchBytes>[1] {
  return {
    environmentSession: 1,
    launchId: plan.assignment.turnId,
    gatewayNamespace: "fixture-gateway",
    expectedBundleHash: plan.admission.handshake.bundleHash,
    placementGeneration: 1,
    descriptor: plan,
  };
}

function measureLaunch(plan: WorkerLaunchPlan): number {
  return measureNodeWorkerLaunchBytes("fixture-node", launchInput(plan));
}

function fit(messages: Messages, parsed = false) {
  return fitLaunchDescriptorWithRuntimeIdentity({
    build: (token, initialMessages) => {
      const plan = buildDescriptor(initialMessages, token);
      return parsed ? parseWorkerLaunchPlan(plan) : plan;
    },
    measure: measureLaunch,
    messages,
    runtimeIdentity: {
      agentId: "main",
      sessionKey: "worker:session",
      operationalRunInstance: runInstance,
    },
  });
}

function completeWindow(messages: AgentMessage[], promptMessages = 1) {
  const projected = windowInitialMessages(messages, promptMessages);
  assert(projected.kind === "complete", "expected complete projection");
  return projected.messages;
}

function toolResultAt(messages: Messages, index: number) {
  const message = messages[index];
  assert(message?.role === "toolResult", "expected tool result");
  return message;
}

function replayPayload() {
  return completeWindow([assistantMessage(1), toolResultMessage({ payload: "" }, 2)]);
}

function measuredDescriptor(messages: Messages) {
  return parseWorkerLaunchPlan(buildDescriptor(messages));
}

async function launched(messages: Messages, parsed = false) {
  const result = await fit(messages, parsed);
  assert(result.kind === "launch", "expected launch plan");
  return result.plan;
}

beforeEach(() => {
  vi.clearAllMocks();
  runInstance = createTestAdmittedRunContext("run").operationalRunInstance;
});

describe("windowInitialMessages", () => {
  it.each([{}, { source: "openclaw-runtime-context", runtimeContextCarrier: false }])(
    "rejects invalid runtime carrier metadata %j",
    (details) => {
      expect(() =>
        windowInitialMessages([
          {
            role: "custom",
            customType: "openclaw.runtime-context",
            content: "retained context",
            display: false,
            details,
            timestamp: 1,
          },
        ]),
      ).toThrow("Invalid worker runtime context");
    },
  );

  it.each([false, true])(
    "retains hidden runtime context before the provider replay anchor (structured: %s)",
    (structured) => {
      const context = buildRuntimeContextCustomMessage(
        "Active exec sessions: none",
        structured
          ? [{ kind: "conversation-data", text: "Active exec sessions: none" }]
          : undefined,
      );
      assert(context, "Expected runtime context");
      const history = [userMessage("previous turn", 1), context, assistantMessage(3)];
      expect(windowInitialMessages(history)).toEqual({ kind: "complete", messages: history });
    },
  );

  it("pins the newest replay carrier when the normal cutoff would pass it", () => {
    const result = completeWindow([
      userMessage("old", 1),
      assistantMessage(2),
      ...userHistory(MAX_MESSAGES - 2, "suffix", 3),
    ]);
    expect(result).toHaveLength(MAX_MESSAGES - 1);
    expect(result[0]).toMatchObject({ role: "assistant", providerReplay: PROVIDER_REPLAY });
  });

  it("reserves two context slots for the complete current prompt", () => {
    const result = completeWindow(userHistory(MAX_MESSAGES, "history"), 2);
    expect(result).toHaveLength(MAX_MESSAGES - 2);
    expect(result[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "history-2" }],
    });
  });

  it("rejects replay that cannot leave two current-prompt slots", () => {
    const history = [assistantMessage(1), ...userHistory(MAX_MESSAGES - 2, "suffix", 2)];
    expect(windowInitialMessages(history, 2)).toEqual({
      kind: "provider-replay-unavailable",
      details: {
        reason: "provider-replay-message-limit",
        messageCount: MAX_MESSAGES - 1,
      },
    });
  });
});

describe("fitLaunchDescriptor", () => {
  it.each(["residual", "non-image"] as const)(
    "reserves the managed wrapper and maximal typed endpoint for the %s budget",
    async (budget) => {
      const operationalRunInstance = createTestAdmittedRunContext("run").operationalRunInstance;
      const projected = windowInitialMessages([
        assistantMessage(1, true),
        ...(budget === "non-image"
          ? Array.from({ length: 8 }, (_, index) =>
              userMessage(
                "x".repeat(WORKER_MESSAGE_MAX_TEXT_BYTES - (index === 0 ? 19 : 0)),
                index + 2,
              ),
            )
          : []),
        toolResultMessage({ payload: "" }, 11),
      ]);
      if (projected.kind !== "complete") {
        throw new Error("expected context");
      }
      const messages = projected.messages;
      const owner = messages[0];
      const result = messages.at(-1);
      if (owner?.role !== "assistant" || !owner.providerReplay || result?.role !== "toolResult") {
        throw new Error("expected replay and tool result");
      }
      const prefix = "wss://worker.invalid/";
      const suffix = "/__openclaw__/worker";
      const endpoint = {
        kind: "websocket" as const,
        url: prefix + "\0".repeat(4096 - prefix.length - suffix.length) + suffix,
        tlsFingerprint: "a".repeat(64),
        cloudflareAccess: {
          clientId: "i" + "\0".repeat(4095),
          clientSecret: "s" + "\0".repeat(4095),
        },
      };
      const endpointBytes = Buffer.byteLength(JSON.stringify(endpoint));
      const build = (token: string, history: typeof messages) =>
        buildDescriptor(history, token, operationalRunInstance);
      const frame = () => ({
        type: "turn",
        turnId: "turn",
        descriptor: {
          ...build(runtimeIdentityToken.value, messages),
          connectionEndpoint: endpoint,
        },
        idleRetention: true,
        canonicalWorkspace: true,
      });
      const initialBytes = Buffer.byteLength(JSON.stringify(frame()));
      if (budget === "residual") {
        const dataBytes =
          "visible".length + "result".length + "prompt".length + PROVIDER_REPLAY.data.length;
        result.details = {
          payload: "x".repeat(
            WORKER_CONTEXT_MAX_RESIDUAL_BYTES - initialBytes + endpointBytes + dataBytes,
          ),
        };
      } else {
        owner.providerReplay.data += "x".repeat(
          WORKER_PROTOCOL_MAX_NON_IMAGE_PAYLOAD_BYTES -
            initialBytes -
            (WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES - endpointBytes),
        );
      }
      const fit = () =>
        fitLaunchDescriptorWithRuntimeIdentity({
          build,
          measure: measureLaunch,
          messages,
          runtimeIdentity: {
            agentId: "main",
            sessionKey: "worker:session",
            operationalRunInstance,
          },
        });
      const fitted = await fit();
      expect(fitted.kind).toBe("launch");
      if (fitted.kind !== "launch") {
        throw new Error("expected fitted plan");
      }
      const admitted = { ...frame(), descriptor: { ...fitted.plan, connectionEndpoint: endpoint } };
      expect(parseWorkerLaunchDescriptor(admitted.descriptor)).toEqual(admitted.descriptor);
      expect(parseWorkerProcessRequest(admitted)).toEqual(admitted);
      if (budget === "residual") {
        result.details = { payload: "x".repeat(WORKER_CONTEXT_MAX_RESIDUAL_BYTES) };
      } else {
        owner.providerReplay.data += "x".repeat(
          WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES - endpointBytes + 1,
        );
      }
      expect(() => parseWorkerProcessRequest(frame())).toThrow();
      await expect(fit()).resolves.toMatchObject({ kind: "provider-replay-unavailable" });
    },
  );

  it.each([0, 1])("fits the complete transport bound at cap %+i byte(s)", async (delta) => {
    const projected = windowInitialMessages([
      assistantMessage(1, true),
      toolResultMessage({ payload: "" }, 2),
    ]);
    if (projected.kind !== "complete" || projected.messages[1]?.role !== "toolResult") {
      throw new Error("expected replay context");
    }
    const operationalRunInstance = createTestAdmittedRunContext("run").operationalRunInstance;
    const build = (token: string, messages: typeof projected.messages) =>
      parseWorkerLaunchPlan(buildDescriptor(messages, token, operationalRunInstance));
    const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
    projected.messages[1].content.push(image);
    const targetBytes = WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES + delta;
    const emptyBytes = measureLaunch(build(runtimeIdentityToken.value, projected.messages));
    image.data += "x".repeat(targetBytes - emptyBytes);
    const candidate = build(runtimeIdentityToken.value, projected.messages);
    expect(measureLaunch(candidate)).toBe(targetBytes);
    const fitted = await fitLaunchDescriptorWithRuntimeIdentity({
      build,
      measure: measureLaunch,
      messages: projected.messages,
      runtimeIdentity: { agentId: "main", sessionKey: "worker:session", operationalRunInstance },
    });
    expect(fitted.kind).toBe(delta > 0 ? "provider-replay-unavailable" : "launch");
    expect(runtimeIdentityToken.mint).toHaveBeenCalledTimes(delta > 0 ? 0 : 1);
    if (fitted.kind === "launch") {
      expect(fitted.plan.assignment.operationalRunInstance).toEqual(runInstance);
      expect(fitted.plan.assignment.initialMessages[0]).toMatchObject({
        providerReplay: PROVIDER_REPLAY,
      });
    } else {
      expect(fitted).toMatchObject({
        reason: "provider-replay-launch-payload-limit",
        limitBytes: MAX_BYTES,
      });
    }
  });

  it.each(["nested escaping", "maximal endpoint"])(
    "fits the actual near-ceiling launch transport: %s",
    async (scenario) => {
      const operationalRunInstance = createTestAdmittedRunContext("run").operationalRunInstance;
      const projected = windowInitialMessages([
        assistantMessage(1, true),
        toolResultMessage({ payload: "" }, 2),
      ]);
      if (projected.kind !== "complete") {
        throw new Error("expected complete projection");
      }
      const messages = projected.messages;
      const result = messages[1];
      if (result?.role !== "toolResult") {
        throw new Error("expected tool result");
      }
      const build = (identityToken: string, initialMessages: typeof messages) =>
        buildDescriptor(initialMessages, identityToken, operationalRunInstance);
      const image = { type: "image" as const, mimeType: "image/png", data: "" };
      result.content.push(image);
      const owner = messages[0];
      if (owner?.role !== "assistant" || !owner.providerReplay) {
        throw new Error("expected replay owner");
      }
      owner.providerReplay.data =
        scenario === "nested escaping" ? '"\\\0\n'.repeat(500_000) : "opaque";
      const emptyBytes = Buffer.byteLength(
        JSON.stringify(build(runtimeIdentityToken.value, messages)),
      );
      image.data = "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES - 4_608 - emptyBytes);
      const candidate = parseWorkerLaunchPlan(build(runtimeIdentityToken.value, messages));
      const input = {
        environmentSession: 1,
        launchId: candidate.assignment.turnId,
        gatewayNamespace: "fixture-gateway",
        expectedBundleHash: candidate.admission.handshake.bundleHash,
        placementGeneration: 1,
        descriptor: candidate,
      };
      const paramsJSON = JSON.stringify(input);
      parseNodeWorkerLaunchInput(paramsJSON);
      const suffix = "/__openclaw__/worker";
      const prefix = "wss://worker.invalid/";
      const descriptor = {
        ...candidate,
        connectionEndpoint: {
          kind: "websocket" as const,
          url: prefix + "x".repeat(4_096 - prefix.length - suffix.length) + suffix,
          tlsFingerprint: "a".repeat(64),
          cloudflareAccess: { clientId: "i".repeat(4_096), clientSecret: "s".repeat(4_096) },
        },
      };
      expect(() => parseWorkerLaunchDescriptor(descriptor)).toThrow(
        "invalid worker launch descriptor",
      );
      const line = JSON.stringify({
        type: "turn",
        turnId: candidate.assignment.turnId,
        descriptor,
      });
      expect(() => parseWorkerProcessRequest(JSON.parse(line))).toThrow(
        "invalid worker launch descriptor",
      );

    await expect(fit(messages)).resolves.toMatchObject({ kind: "provider-replay-unavailable" });
    expect(runtimeIdentityToken.mint).not.toHaveBeenCalled();
  });

  it("retains history when pruning one processed image fits the exact node transport bound", async () => {
    const messages = createWorkerImageHistory().slice(0, 5);
    const latest = toolResultAt(messages, 4);
    const latestImage = latest.content.find((part) => part.type === "image");
    if (!latestImage) {
      throw new Error("expected latest image");
    }
    latestImage.data += "x".repeat(100_000);
    const expected = structuredClone(messages);
    toolResultAt(expected, 2).content[1] = {
      type: "text",
      text: "[image data removed - already processed by model]",
    };
    const padding = MAX_BYTES - measureLaunch(measuredDescriptor(expected));
    latestImage.data += "x".repeat(padding);
    expected[4] = structuredClone(latest);
    expect(measureLaunch(measuredDescriptor(expected))).toBe(MAX_BYTES);
    const original = structuredClone(messages);
    const plan = await launched(messages, true);
    expect(plan.assignment.initialMessages).toEqual(expected);
    expect(measureLaunch(plan)).toBe(MAX_BYTES);
    expect(messages).toEqual(original);
  });

  it("drops complete old turns while retaining the replay anchor", async () => {
    const imageMessage = (timestamp: number) => ({
      role: "toolResult" as const,
      toolCallId: "call",
      toolName: "read",
      timestamp,
      isError: false,
      content: [
        { type: "image" as const, data: "x".repeat(13 * 1024 * 1024), mimeType: "image/png" },
      ],
    });
    const messages = completeWindow([
      userMessage("old turn", 1),
      imageMessage(2),
      assistantMessage(3),
      userMessage("new turn", 4),
      imageMessage(5),
      assistantMessage(6),
    ]);
    const plan = await launched(messages);
    parseWorkerLaunchPlan(plan);
    expect(plan.assignment.initialMessages.map((message) => message.timestamp)).toEqual([4, 5, 6]);
    expect(plan.assignment.initialMessages[2]).toMatchObject({
      role: "assistant",
      providerReplay: PROVIDER_REPLAY,
    });
    expect(plan.assignment.agentRuntimeIdentityToken).toBe(runtimeIdentityToken.value);
    expect(plan.assignment.operationalRunInstance).toBe(runInstance);
    expect(runtimeIdentityToken.mint).toHaveBeenCalledOnce();
    expect(runtimeIdentityToken.mint.mock.calls[0]?.[0].operationalRunInstance).toBe(runInstance);
  });

  it("drops a non-user prefix directly to the replay owner", async () => {
    const messages = completeWindow([
      toolResultMessage({ payload: "x".repeat(MAX_BYTES) }, 1),
      assistantMessage(2),
    ]);
    const plan = await launched(messages);
    expect(plan.assignment.initialMessages).toEqual([
      expect.objectContaining({ role: "assistant", providerReplay: PROVIDER_REPLAY }),
    ]);
    expect(plan.assignment.operationalRunInstance).toBe(runInstance);
    expect(runtimeIdentityToken.mint.mock.calls[0]?.[0].operationalRunInstance).toBe(runInstance);
  });
});
