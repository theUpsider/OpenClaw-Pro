import { describe, expect, it } from "vitest";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "./cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

const { maxTurnRawChars, maxTurnLines } = CLI_STREAM_JSON_OUTPUT_LIMITS;
// One payload just past half the raw budget: two of them cross the raw budget
// while a single one still fits under the pending-line budget.
const HALF_BUDGET_TEXT = Math.ceil(maxTurnRawChars / 2) + 1;
// JSON escaping doubles every quote, so a quarter-budget payload is needed to
// keep one line under the pending-line budget while two cross the raw budget.
const HALF_BUDGET_JSON = Math.ceil(maxTurnRawChars / 4) + 1;

function streamDelta(delta: Record<string, unknown>) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta },
    uuid: "11111111-1111-4111-8111-111111111111",
    session_id: "22222222-2222-4222-8222-222222222222",
    parent_tool_use_id: null,
  };
}

function createParser() {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    onThinkingDelta: () => {},
  });
}

describe("Claude partial-message output budgets", () => {
  it.each([
    { name: "envelope characters", count: 18_000, chars: 128, resultChars: 2_000_000 },
    { name: "delta frames", count: 20_001, chars: 1, resultChars: 0 },
  ])(
    "delivers completed tool turns beyond the raw $name limit",
    ({ count, chars, resultChars }) => {
      const inputs: unknown[] = [];
      const parser = createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
        onToolUseStart: (tool) => inputs.push(tool.args),
      });
      const push = (record: unknown) => parser.push(`${JSON.stringify(record)}\n`);
      const input = { value: "a".repeat(count * chars) };
      const tool = { type: "tool_use", id: "write-fixture", name: "Write", input };
      push({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { ...tool, input: {} } },
      });
      push(streamDelta({ type: "input_json_delta", partial_json: '{"value":"' }));
      const chunk = `${JSON.stringify(streamDelta({ type: "input_json_delta", partial_json: "a".repeat(chars) }))}\n`;
      for (let index = 0; index < count; index += 1) {
        parser.push(chunk);
      }
      push(streamDelta({ type: "input_json_delta", partial_json: '"}' }));
      push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
      push({ type: "assistant", message: { id: "tool-message", content: [tool] } });
      push({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: tool.id, content: "r".repeat(resultChars) },
          ],
        },
      });
      push({
        type: "assistant",
        message: { id: "final-message", content: [{ type: "text", text: "completed" }] },
      });
      push({ type: "result", subtype: "success", result: "completed" });
      parser.finish();

      expect(parser.getErrorText()).toBeNull();
      expect(parser.hasTerminalResult()).toBe(true);
      expect(parser.getOutput()?.text).toBe("completed");
      expect(inputs).toEqual([input]);
    },
  );

  it.each([
    { type: "text_delta", field: "text", payload: "a".repeat(HALF_BUDGET_TEXT) },
    { type: "input_json_delta", field: "partial_json", payload: '"'.repeat(HALF_BUDGET_JSON) },
  ])("still bounds encoded $type payloads", ({ type, field, payload }) => {
    const parser = createParser();
    const line = `${JSON.stringify(streamDelta({ type, [field]: payload }))}\n`;
    parser.push(line);
    expect(parser.getErrorText()).toBeNull();
    parser.push(line);
    expect(parser.getErrorText()).toContain(`exceeded ${maxTurnRawChars} characters`);
    expect(parser.getOutput()?.text).toBe("");
  });

  it.each([
    { type: "text_delta", text: "a" },
    { type: "thinking_delta", thinking: "a", estimated_tokens: null },
  ])("accepts a long $type stream without a terminal frame", (delta) => {
    const parser = createParser();
    parser.push(`${JSON.stringify(streamDelta(delta))}\n`.repeat(maxTurnLines + 1));
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()).not.toBeNull();
    if (delta.type === "text_delta") {
      expect(parser.getOutput()?.text).toBe("a".repeat(maxTurnLines + 1));
    }
  });

  it.each([
    { name: "empty deltas", record: streamDelta({ type: "text_delta", text: "" }) },
    {
      name: "unknown delta fields",
      record: streamDelta({ type: "text_delta", text: "a", extra: true }),
    },
    {
      name: "oversized metadata",
      record: { ...streamDelta({ type: "text_delta", text: "a" }), uuid: "u".repeat(129) },
    },
  ])("keeps the ordinary frame limit for $name", ({ record }) => {
    const parser = createParser();
    parser.push(`${JSON.stringify(record)}\n`.repeat(maxTurnLines + 1));
    expect(parser.getErrorText()).toContain(`exceeded ${maxTurnLines} lines`);
  });

  it("keeps the ordinary frame limit when a custom parser claims deltas", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      parseJsonlEvent: () => ({ kind: "text", text: "a" }),
      onAssistantDelta: () => {},
    });
    parser.push(
      `${JSON.stringify(streamDelta({ type: "text_delta", text: "a" }))}\n`.repeat(
        maxTurnLines + 1,
      ),
    );
    expect(parser.getErrorText()).toContain(`exceeded ${maxTurnLines} lines`);
  });

  it.each(["outer"])("still counts %s whitespace around a recognized delta", (location) => {
    const parser = createParser();
    const compact = JSON.stringify(streamDelta({ type: "text_delta", text: "a" }));
    const padding = " ".repeat(HALF_BUDGET_TEXT);
    const line =
      location === "outer" ? padding + compact : compact.replace('"event":', `"event":${padding}`);
    parser.push(`${line}\n${line}\n`);
    expect(parser.getErrorText()).toContain(`exceeded ${maxTurnRawChars} characters`);
  });

  it("bounds tiny nonempty delta floods even without ordinary frames", () => {
    const parser = createParser();
    const line = `${JSON.stringify(streamDelta({ type: "input_json_delta", partial_json: "a" }))}\n`;
    // Each frame is charged at least the 32-character fixed overhead, so
    // ceil(raw / 32) + 2 frames always cross the raw budget.
    const floodFrames = Math.ceil(maxTurnRawChars / 32) + 2;
    for (let index = 0; index < floodFrames && !parser.getErrorText(); index += 1) {
      parser.push(line);
    }
    expect(parser.getErrorText()).toContain("CLI JSONL output exceeded");
  });
});
