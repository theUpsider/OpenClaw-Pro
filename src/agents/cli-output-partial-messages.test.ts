import { describe, expect, it } from "vitest";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "./cli-output-stream-limits.js";
import { chargeClaudeStreamJsonLine } from "./cli-output-stream-limits.js";
import {
  claudeBlockStart,
  claudeBlockStop,
  createClaudeParser,
} from "./cli-output.test-helpers.js";

const { maxTurnRawChars, maxTurnLines } = CLI_STREAM_JSON_OUTPUT_LIMITS;
// One payload just past half the raw budget: two of them cross the raw budget
// while a single one still fits under the pending-line budget.
const HALF_BUDGET_TEXT = Math.ceil(maxTurnRawChars / 2) + 1;
// JSON escaping doubles every quote, so a quarter-budget payload is needed to
// keep one line under the pending-line budget while two cross the raw budget.
const HALF_BUDGET_JSON = Math.ceil(maxTurnRawChars / 4) + 1;

const text = { type: "text_delta", text: "a" };
const input = { type: "input_json_delta", partial_json: "{" };
const thinking = { type: "thinking_delta", thinking: "a" };
const limits = {
  uuid: 128,
  session_id: 128,
  parent_tool_use_id: 128,
  api_message_id: 64,
  thinking_display: 32,
};
function frame(delta: Record<string, unknown>, metadata: Record<string, unknown> = {}) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta },
    session_id: "00000000-0000-4000-8000-000000000001",
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000002",
    api_message_id: `msg_${"0".repeat(24)}`,
    ...metadata,
  };
}
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const parserFor = (custom = false) =>
  createClaudeParser({
    onThinkingDelta: () => {},
    ...(custom ? { parseJsonlEvent: () => ({ kind: "text" as const, text: "a" }) } : {}),
  });

describe("Claude partial-message output budgets", () => {
  it.each([
    { name: "envelope characters", count: 18_000, chars: 128, resultChars: 2_000_000 },
    { name: "delta frames", count: 20_001, chars: 1, resultChars: 0 },
  ])("completes tool turns beyond raw $name limits", ({ count, chars, resultChars }) => {
    const inputs: unknown[] = [];
    const parser = createClaudeParser({ onToolUseStart: (tool) => inputs.push(tool.args) });
    const push = (record: unknown) => parser.push(line(record));
    const value = "a".repeat(count * chars),
      tool = { type: "tool_use", id: "write-fixture", name: "Write", input: { value } };
    push(claudeBlockStart({ ...tool, input: {} }, 0));
    push(frame({ ...input, partial_json: '{"value":"' }));
    parser.push(line(frame({ ...input, partial_json: "a".repeat(chars) })).repeat(count));
    push(frame({ ...input, partial_json: '"}' }));
    push(claudeBlockStop(0));
    push({ type: "assistant", message: { id: "tool-message", content: [tool] } });
    push({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: tool.id, content: "r".repeat(resultChars) }],
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
    expect(inputs).toEqual([{ value }]);
  });

  const records: Array<
    [string, Record<string, unknown>, Record<string, unknown>, number | null | "custom"]
  > = [
    ["current text", { ...text, text: "Ac" }, {}, 36],
    ["current tool input", { ...input, partial_json: '{"pa' }, {}, 39],
    [
      "thinking token estimate",
      { ...thinking, estimated_tokens: 50 },
      { thinking_display: "updates" },
      58,
    ],
    ["null metadata", text, { api_message_id: null, thinking_display: null }, 35],
    [
      "display without API id",
      thinking,
      { api_message_id: undefined, thinking_display: "updates" },
      35,
    ],
    ["captured 2.1.296 text", { ...text, text: "x" }, {}, 35],
    [
      "captured 2.1.310 thinking",
      { ...thinking, thinking: "xxx", estimated_tokens: null },
      { thinking_display: "updates" },
      62,
    ],
    ["unfinished legacy text", text, { api_message_id: undefined }, 35],
    [
      "unfinished legacy thinking",
      { ...thinking, estimated_tokens: null },
      { api_message_id: undefined },
      60,
    ],
    ["empty text", { ...text, text: "" }, {}, null],
    ["unknown delta field", { ...text, extra: true }, {}, null],
    ["unknown record field", text, { request_id: "req_1" }, null],
    ["display on text", text, { thinking_display: "updates" }, null],
    ["display on tool input", input, { thinking_display: "updates" }, null],
    ["custom parser", text, {}, "custom"],
  ];
  for (const [key, cap] of Object.entries(limits)) {
    const delta = key === "thinking_display" ? thinking : text;
    records.push([`${key} at cap`, delta, { [key]: "m".repeat(cap) }, 35]);
    records.push([`${key} over cap`, delta, { [key]: "m".repeat(cap + 1) }, null]);
    records.push([`${key} wrong type`, delta, { [key]: 7 }, null]);
  }
  it.each(records)(
    "accounts for %s within the character budget",
    (_name, delta, metadata, chars) => {
      const raw = JSON.stringify(frame(delta, metadata)),
        custom = chars === "custom";
      if (!custom) {
        expect(chargeClaudeStreamJsonLine(JSON.parse(raw), raw)).toEqual({
          chars: chars ?? raw.length,
          countsFrame: false,
        });
      }
      const parser = parserFor(custom);
      parser.push(`${raw}\n`.repeat(20_001));
      parser.finish();
      expect(parser.getErrorText()).toBeNull();
      if (
        typeof chars === "number" &&
        !metadata.parent_tool_use_id &&
        typeof delta.text === "string"
      ) {
        expect(parser.getOutput()?.text).toBe(delta.text.repeat(20_001));
      }
    },
  );

  it.each([
    ["encoded text", () => line(frame({ ...text, text: "a".repeat(HALF_BUDGET_TEXT) }))],
    ["encoded tool input", () => line(frame({ ...input, partial_json: '"'.repeat(HALF_BUDGET_JSON) }))],
    ["outer whitespace", () => " ".repeat(4_300_000) + line(frame(text))],
  ] as const)("bounds %s before retaining output", (_name, makeChunk) => {
    const parser = parserFor(),
      chunk = makeChunk();
    parser.push(chunk);
    expect(parser.getErrorText()).toBeNull();
    parser.push(chunk);
    expect(parser.getErrorText()).toContain(`exceeded ${maxTurnRawChars} characters`);
    expect(parser.getOutput()?.text).toBe("");
  });

  it.each([
<<<<<<< OURS/upstream-11.10
    ["legacy tool input", input, { api_message_id: undefined }],
    [
      "maximal current thinking",
      thinking,
      Object.fromEntries(Object.entries(limits).map(([key, cap]) => [key, "m".repeat(cap)])),
    ],
  ] as const)("bounds tiny %s floods without ordinary frames", (_name, delta, metadata) => {
    const parser = parserFor(),
      chunk = line(frame(delta, metadata));
    let frames = 0;
    for (; frames < 240_000 && !parser.getErrorText(); frames += 1) {
      parser.push(chunk);
||||||| BASE/v11.4
    { type: "text_delta", text: "a" },
    { type: "thinking_delta", thinking: "a", estimated_tokens: null },
  ])("accepts a long $type stream without a terminal frame", (delta) => {
    const parser = createParser();
    parser.push(`${JSON.stringify(streamDelta(delta))}\n`.repeat(20_001));
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()).not.toBeNull();
    if (delta.type === "text_delta") {
      expect(parser.getOutput()?.text).toBe("a".repeat(20_001));
=======
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
>>>>>>> THEIRS/pro-main
    }
<<<<<<< OURS/upstream-11.10
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
    expect(frames).toBe(233_017);
||||||| BASE/v11.4
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
    parser.push(`${JSON.stringify(record)}\n`.repeat(20_001));
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
  });

  it("keeps the ordinary frame limit when a custom parser claims deltas", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      parseJsonlEvent: () => ({ kind: "text", text: "a" }),
      onAssistantDelta: () => {},
    });
    parser.push(
      `${JSON.stringify(streamDelta({ type: "text_delta", text: "a" }))}\n`.repeat(20_001),
    );
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
  });

  it.each(["outer"])("still counts %s whitespace around a recognized delta", (location) => {
    const parser = createParser();
    const compact = JSON.stringify(streamDelta({ type: "text_delta", text: "a" }));
    const padding = " ".repeat(4_300_000);
    const line =
      location === "outer" ? padding + compact : compact.replace('"event":', `"event":${padding}`);
    parser.push(`${line}\n${line}\n`);
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
  });

  it("bounds tiny nonempty delta floods even without ordinary frames", () => {
    const parser = createParser();
    const line = `${JSON.stringify(streamDelta({ type: "input_json_delta", partial_json: "a" }))}\n`;
    for (let index = 0; index < 262_145 && !parser.getErrorText(); index += 1) {
      parser.push(line);
    }
    expect(parser.getErrorText()).toContain("CLI JSONL output exceeded");
=======
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
>>>>>>> THEIRS/pro-main
  });
});
