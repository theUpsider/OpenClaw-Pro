import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import type {
  WorkerTranscriptMessage,
  WorkerTranscriptCommitRequestFrame,
} from "./schema/worker-admission.js";
import {
  validateWorkerInferenceStartRequestFrame,
  validateWorkerInferenceEventFrame,
  validateWorkerInferenceTerminalFrame,
} from "./schema/worker-inference.js";
import {
  WORKER_MESSAGE_MAX_TEXT_BYTES as MESSAGE,
  WORKER_CONTEXT_MAX_RESIDUAL_BYTES as RESIDUAL,
  WORKER_CONTEXT_MAX_TEXT_BYTES as CONTEXT,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES as REPLAY,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES as CONTROL,
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES as MEDIA,
  WORKER_PROTOCOL_MAX_NON_IMAGE_PAYLOAD_BYTES as DATA,
} from "./schema/worker-protocol-primitives.js";
import {
  isWorkerTextFrameWithinBudget,
  isWorkerTranscriptFrameWithinBudget,
} from "./worker-transcript-budget.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const identity = { runEpoch: 1, sessionId: "session", runId: "run", turnId: "turn" };
function user(text: string): WorkerTranscriptMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}
function assistant() {
  return {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "reason" },
      { type: "text" as const, text: "answer" },
    ],
    api: "api",
    provider: "provider",
    model: "model",
    stopReason: "stop" as const,
    timestamp: 1,
    usage: structuredClone(usage),
  };
}
function toolCall(id: string, command: string) {
  return {
    ...assistant(),
    content: [{ type: "toolCall" as const, id, name: "exec", arguments: { command } }],
    stopReason: "toolUse" as const,
  };
}
function toolResult(id: string, text: string): WorkerTranscriptMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "exec",
    content: [{ type: "text", text }],
    details: { exitCode: 0, durationMs: 1234, cwd: "/srv/exp/EXP-0000" },
    isError: false,
    timestamp: 1,
  };
}
/** A worker session after `calls` tool calls with `argumentBytes` of arguments each. */
function toolSession(calls: number, argumentBytes: number): WorkerTranscriptMessage[] {
  const messages: WorkerTranscriptMessage[] = [user("task")];
  for (let index = 0; index < calls; index += 1) {
    messages.push(toolCall(`call-${index}`, "x".repeat(argumentBytes)));
    messages.push(toolResult(`call-${index}`, "ok"));
  }
  return messages;
}
function terminal(message: unknown) {
  return {
    type: "event",
    event: "worker.inference.terminal",
    payload: { ...identity, seq: 2, outcome: { type: "done", message } },
  };
}
function replay(data: string) {
  return {
    v: 1 as const,
    type: "checkpoint",
    provider: "provider",
    api: "api",
    model: "model",
    data,
  };
}
function commit(messages: WorkerTranscriptMessage[]): WorkerTranscriptCommitRequestFrame {
  return {
    type: "req",
    id: "commit",
    method: "worker.transcript.commit",
    params: { runEpoch: 1, seq: 1, baseLeafId: null, messages },
  };
}
function start(messages: WorkerTranscriptMessage[], systemPrompt?: string) {
  return {
    type: "req",
    id: "start",
    method: "worker.inference.start",
    params: {
      ...identity,
      context: { messages, ...(systemPrompt === undefined ? {} : { systemPrompt }) },
      modelRef: { provider: "provider", model: "model" },
      options: {},
    },
  };
}

describe("worker data-plane wire budgets", () => {
  it.each(["x", "é", "😀", '"', "\\", "\u0001"])(
    "counts UTF-8 and JSON escaping for %j",
    (unit) => {
      const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
      const text = unit.repeat(Math.floor(MESSAGE / unitBytes)) + "x".repeat(MESSAGE % unitBytes);
      expect(isWorkerTranscriptFrameWithinBudget(commit([user(text)]))).toBe(true);
      expect(isWorkerTranscriptFrameWithinBudget(commit([user(text + "x")]))).toBe(false);
    },
  );

  it("combines text, reasoning and signatures per message while excluding replay", () => {
    const message = {
      ...assistant(),
      content: [
        { type: "text" as const, text: "x".repeat(MESSAGE - 3), textSignature: "s" },
        { type: "thinking" as const, thinking: "r", thinkingSignature: "s" },
      ],
      providerReplay: replay("x".repeat(REPLAY)),
    };
    expect(isWorkerTranscriptFrameWithinBudget(commit([message]))).toBe(true);
    const textPart = expectDefined(message.content[0]);
    if (textPart.type !== "text") {
      throw new Error("expected text fixture");
    }
    textPart.text += "x";
    expect(isWorkerTranscriptFrameWithinBudget(commit([message]))).toBe(false);
  });

  it("bounds aggregate context text, including the system prompt", () => {
    const messages = Array.from({ length: 7 }, () => user("x".repeat(MESSAGE)));
    expect(validateWorkerInferenceStartRequestFrame(start(messages, "x".repeat(MESSAGE)))).toBe(
      true,
    );
    expect(validateWorkerInferenceStartRequestFrame(start(messages, "x".repeat(MESSAGE + 1)))).toBe(
      false,
    );
    expect(CONTEXT).toBe(8 * MESSAGE);
  });

  it("bounds replay independently and counts all replay data in the frame", () => {
    const first = { ...assistant(), providerReplay: replay("x".repeat(REPLAY / 2)) };
    const second = { ...assistant(), providerReplay: replay("x".repeat(REPLAY / 2)) };
    expect(isWorkerTranscriptFrameWithinBudget(commit([first, second]))).toBe(true);
    second.providerReplay.data += "x";
    expect(isWorkerTranscriptFrameWithinBudget(commit([first, second]))).toBe(false);
    expect(
      isWorkerTranscriptFrameWithinBudget(
        commit([{ ...assistant(), providerReplay: replay("\\".repeat(REPLAY / 2 + 1)) }]),
      ),
    ).toBe(false);
  });

  it.each(["details", "arguments", "replay-metadata"])(
    "retains exactly 64 KiB residual control for %s outside conversation frames",
    (carrier) => {
      const message: WorkerTranscriptMessage =
        carrier === "details"
          ? {
              role: "toolResult",
              toolCallId: "call",
              toolName: "read",
              content: [{ type: "text", text: "x".repeat(MESSAGE) }],
              details: { text: "" },
              isError: false,
              timestamp: 1,
            }
          : carrier === "arguments"
            ? {
                ...assistant(),
                content: [{ type: "toolCall", id: "call", name: "read", arguments: { text: "" } }],
              }
            : {
                ...assistant(),
                content: [],
                providerReplay: { ...replay("r".repeat(MESSAGE)), id: "" },
              };
      const frame = commit([message]);
      const allowed = carrier === "arguments" ? 0 : MESSAGE;
      const padding = CONTROL - (Buffer.byteLength(JSON.stringify(frame)) - allowed);
      const setPadding = (length: number) => {
        if (message.role === "toolResult") {
          message.details = { text: "x".repeat(length) };
        } else if (message.role === "assistant" && message.providerReplay) {
          message.providerReplay.id = "x".repeat(length);
        } else if (message.role === "assistant" && message.content[0]?.type === "toolCall") {
          message.content[0].arguments.text = "x".repeat(length);
        }
      };
      const messages = [message];
      setPadding(padding);
      expect(isWorkerTextFrameWithinBudget(frame, { messages })).toBe(true);
      setPadding(padding + 1);
      expect(isWorkerTextFrameWithinBudget(frame, { messages })).toBe(false);
      // A conversation frame admits the same residual, which grows with every tool call.
      expect(isWorkerTextFrameWithinBudget(frame, { messages, residual: "context" })).toBe(true);
      expect(isWorkerTranscriptFrameWithinBudget(frame)).toBe(true);
    },
  );

  it.each(["details", "arguments"])(
    "retains exactly the context residual for %s in conversation frames",
    (carrier) => {
      const message: WorkerTranscriptMessage =
        carrier === "details"
          ? {
              role: "toolResult",
              toolCallId: "call",
              toolName: "read",
              content: [{ type: "text", text: "x".repeat(MESSAGE) }],
              details: { text: "" },
              isError: false,
              timestamp: 1,
            }
          : {
              ...assistant(),
              content: [{ type: "toolCall", id: "call", name: "read", arguments: { text: "" } }],
            };
      const frame = commit([message]);
      const allowed = carrier === "arguments" ? 0 : MESSAGE;
      const padding = RESIDUAL - (Buffer.byteLength(JSON.stringify(frame)) - allowed);
      const setPadding = (length: number) => {
        if (message.role === "toolResult") {
          message.details = { text: "x".repeat(length) };
        } else if (message.role === "assistant" && message.content[0]?.type === "toolCall") {
          message.content[0].arguments.text = "x".repeat(length);
        }
      };
      setPadding(padding);
      expect(isWorkerTranscriptFrameWithinBudget(frame)).toBe(true);
      setPadding(padding + 1);
      expect(isWorkerTranscriptFrameWithinBudget(frame)).toBe(false);
      expect(RESIDUAL).toBe(4 * 1024 * 1024);
    },
  );

  it("keeps per-field schema limits for replay metadata in conversation frames", () => {
    const message = {
      ...assistant(),
      content: [],
      providerReplay: { ...replay("r"), id: "x".repeat(CONTROL) },
    };
    expect(isWorkerTranscriptFrameWithinBudget(commit([message]))).toBe(true);
    message.providerReplay.id += "x";
    expect(isWorkerTranscriptFrameWithinBudget(commit([message]))).toBe(false);
  });

  it("admits long tool-using conversations in inference, transcript and terminal frames", () => {
    // 400 tool calls with 1 KiB of arguments each, far beyond 64 KiB of residual; a worker
    // used to fail after about 20 tool calls.
    const session = toolSession(400, 1024);
    expect(validateWorkerInferenceStartRequestFrame(start(session, "system"))).toBe(true);
    expect(isWorkerTextFrameWithinBudget(start(session), { messages: session })).toBe(false);
    // A transcript commit carries at most one batch (64 messages).
    const batch = toolSession(31, 4096);
    expect(isWorkerTranscriptFrameWithinBudget(commit(batch))).toBe(true);
    expect(isWorkerTextFrameWithinBudget(commit(batch), { messages: batch })).toBe(false);
    const large = toolCall("call-large", "x".repeat(512 * 1024));
    expect(isWorkerTranscriptFrameWithinBudget(commit([large]))).toBe(true);
    expect(validateWorkerInferenceTerminalFrame(terminal(large))).toBe(true);
  });

  it("still rejects conversations whose residual exceeds the context residual", () => {
    expect(validateWorkerInferenceStartRequestFrame(start(toolSession(3, RESIDUAL / 4)))).toBe(
      true,
    );
    expect(validateWorkerInferenceStartRequestFrame(start(toolSession(5, RESIDUAL / 4)))).toBe(
      false,
    );
    expect(isWorkerTranscriptFrameWithinBudget(commit(toolSession(5, RESIDUAL / 4)))).toBe(false);
    const oversized = toolCall("call-oversized", "x".repeat(RESIDUAL));
    expect(validateWorkerInferenceTerminalFrame(terminal(oversized))).toBe(false);
  });

  it("bounds complete non-image data independently of text and replay allowances", () => {
    const messages = Array.from({ length: 8 }, () => user("x".repeat(MESSAGE)));
    messages.push({ ...assistant(), content: [], providerReplay: replay("") });
    const frame = start(messages);
    const overhead = Buffer.byteLength(JSON.stringify(frame)) - CONTEXT;
    const replayMessage = expectDefined(messages.at(-1));
    if (replayMessage.role !== "assistant" || !replayMessage.providerReplay) {
      throw new Error("fixture");
    }
    replayMessage.providerReplay.data = "x".repeat(DATA - CONTEXT - overhead);
    expect(validateWorkerInferenceStartRequestFrame(frame)).toBe(true);
    replayMessage.providerReplay.data += "x";
    expect(validateWorkerInferenceStartRequestFrame(frame)).toBe(false);
  });

  it("retains the 25 MiB complete media ceiling", () => {
    const message = {
      role: "user" as const,
      content: [{ type: "image" as const, data: "", mimeType: "image/png" }],
      timestamp: 1,
    };
    const frame = commit([message]);
    const overhead = Buffer.byteLength(JSON.stringify(frame));
    expectDefined(message.content[0]).data = "x".repeat(MEDIA - overhead);
    expect(isWorkerTranscriptFrameWithinBudget(frame)).toBe(true);
    expectDefined(message.content[0]).data += "x";
    expect(isWorkerTranscriptFrameWithinBudget(frame)).toBe(false);
  });

  it("admits typed stream reasoning and terminals, rejecting tool/control and unknown carriers", () => {
    const large = "x".repeat(128 * 1024);
    const event = {
      type: "event",
      event: "worker.inference.event",
      payload: {
        ...identity,
        seq: 1,
        event: { type: "thinking_delta", contentIndex: 0, delta: large },
      },
    };
    expect(validateWorkerInferenceEventFrame(event)).toBe(true);
    expect(
      validateWorkerInferenceEventFrame({
        ...event,
        payload: { ...event.payload, event: { ...event.payload.event, type: "toolcall_delta" } },
      }),
    ).toBe(false);
    expect(validateWorkerInferenceEventFrame({ ...event, extra: large })).toBe(false);
    expect(
      validateWorkerInferenceStartRequestFrame({ ...start([user(large)]), method: "unknown" }),
    ).toBe(false);
    expect(
      validateWorkerInferenceStartRequestFrame({
        ...start([user(large)]),
        params: { ...start([]).params, details: { text: large } },
      }),
    ).toBe(false);
    expect(
      validateWorkerInferenceTerminalFrame({
        type: "event",
        event: "worker.inference.terminal",
        payload: {
          ...identity,
          seq: 2,
          outcome: {
            type: "done",
            message: {
              ...assistant(),
              content: [
                { type: "thinking", thinking: large },
                { type: "text", text: large },
              ],
              providerReplay: replay(large),
            },
          },
        },
      }),
    ).toBe(true);
  });
});
