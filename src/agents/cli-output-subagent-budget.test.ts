import { describe, expect, it } from "vitest";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "./cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

const { maxTurnRawChars, maxTurnLines } = CLI_STREAM_JSON_OUTPUT_LIMITS;
const AGENT_CALL = "agent-call-1";
// Half the raw budget per payload: two of them cross the raw budget while one
// line still fits under the pending-line budget.
const HALF_BUDGET = Math.ceil(maxTurnRawChars / 2) + 1;

function createParser(onProgress?: (id: string) => void) {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    onAttributedSubagentProgress: onProgress,
  });
}

function runTurn(parentToolUseId: string | null, records: number, chars: number, unit = "r") {
  const progress: string[] = [];
  const parser = createParser((id) => progress.push(id));
  const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
  const agentCall = {
    type: "tool_use",
    id: AGENT_CALL,
    name: "Agent",
    input: { prompt: "research" },
  };
  push({ type: "assistant", message: { id: "parent-call", content: [agentCall] } });
  for (let index = 0; index < records; index += 1) {
    push({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: `sub-${index}`, content: unit.repeat(chars) },
        ],
      },
      parent_tool_use_id: parentToolUseId,
    });
  }
  push({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: AGENT_CALL, content: "findings" }] },
  });
  push({
    type: "assistant",
    message: { id: "final-message", content: [{ type: "text", text: "completed" }] },
  });
  push({ type: "result", subtype: "success", result: "completed" });
  parser.finish();
  return { parser, progress };
}

describe("Claude subagent output budget", () => {
  it("keeps the parent reply after subagent traffic far beyond the raw limit", () => {
    // 12 MiB of forwarded subagent tool results, which the parser never keeps.
    const { parser, progress } = runTurn(AGENT_CALL, 300, 40 * 1024);
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("completed");
    expect(progress.length).toBe(300);
    expect(new Set(progress)).toEqual(new Set([AGENT_CALL]));
  });

  it("still bounds the same volume in the parent conversation", () => {
    // Enough 40 KiB records to cross the raw budget in the parent conversation.
    const parentRecords = Math.ceil(maxTurnRawChars / (40 * 1024)) + 2;
    const { parser } = runTurn(null, parentRecords, 40 * 1024);
    expect(parser.getErrorText()).toContain(`exceeded ${maxTurnRawChars} characters`);
    expect(parser.getOutput()?.text).toBe("");
  });

  it("charges retained child-attributed text deltas against the parent budget", () => {
    const parser = createParser();
    for (let index = 0; index < 2; index += 1) {
      parser.push(
        `${JSON.stringify({
          type: "stream_event",
          parent_tool_use_id: AGENT_CALL,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "r".repeat(HALF_BUDGET) },
          },
        })}\n`,
      );
    }
    parser.finish();
    expect(parser.getErrorText()).toContain(`exceeded ${maxTurnRawChars} characters`);
  });

  it("still bounds a subagent flood by frames", () => {
    const { parser } = runTurn(AGENT_CALL, maxTurnLines + 1, 1);
    expect(parser.getErrorText()).toContain(`exceeded ${maxTurnLines} lines`);
  });
});

it.each([
  {
    name: "mixed item",
    extra: {
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "retained" }],
      },
    },
  },
  { name: "non-string attribution", extra: { parent_tool_use_id: 1 } },
  { name: "empty attribution", extra: { parent_tool_use_id: " " } },
  { name: "oversized attribution", extra: { parent_tool_use_id: "x".repeat(129) } },
  { name: "padded attribution", extra: { parent_tool_use_id: " ".repeat(129) + AGENT_CALL } },
  { name: "unknown format", extra: { type: "unknown" } },
])("keeps the full charge for $name", ({ extra }) => {
  const parser = createParser();
  for (let index = 0; index < 2; index++) {
    parser.push(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: AGENT_CALL,
        message: { content: [{ type: "text", text: "x".repeat(HALF_BUDGET) }] },
        ...extra,
      }) + "\n",
    );
  }
  parser.finish();
  expect(parser.getErrorText()).toContain(`exceeded ${maxTurnRawChars} characters`);
  expect(parser.getOutput()?.text).toBe("");
});

it("rejects an individually oversized discarded child line", () => {
  const parser = createParser();
  parser.push(
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: AGENT_CALL,
      message: { content: [{ type: "text", text: "x".repeat(maxTurnRawChars + 1) }] },
    }) + "\n",
  );
  parser.finish();
  expect(parser.getErrorText()).toContain(`line exceeded ${maxTurnRawChars} characters`);
});

it("preserves unicode parent text after discarded child messages", () => {
  const parser = createParser();
  const answer = "你好 🦞 café";
  parser.push(
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: AGENT_CALL,
      message: { content: [{ type: "text", text: "🦞".repeat(1000) }] },
    }) + "\n",
  );
  parser.push(JSON.stringify({ type: "result", result: answer }) + "\n");
  parser.finish();
  expect(parser.getErrorText()).toBeNull();
  expect(parser.getOutput()?.text).toBe(answer);
});

it("discounts discarded multibyte child payloads without losing their progress", () => {
  // 300 * 20 Ki emoji = 12 Mi UTF-16 units and 24 Mi UTF-8 bytes before JSON envelopes.
  const { parser, progress } = runTurn(AGENT_CALL, 300, 20 * 1024, "🦞");
  expect(parser.getErrorText()).toBeNull();
  expect(parser.getOutput()?.text).toBe("completed");
  expect(progress).toHaveLength(300);
  expect(new Set(progress)).toEqual(new Set([AGENT_CALL]));
});
