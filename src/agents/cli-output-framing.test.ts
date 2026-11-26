import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { describe, expect, it, vi } from "vitest";
import type { CliToolResultDelta, CliToolUseStartDelta } from "./cli-output-contracts.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "./cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import {
  claudeBlockStart,
  claudeBlockStop,
  claudeInputJsonDelta,
  claudeMessageStart,
  createClaudeParser,
  createClaudeBackend,
  joinJsonlFrames,
} from "./cli-output.test-helpers.js";

const { maxPendingLineChars, maxTurnRawChars, maxTurnLines } = CLI_STREAM_JSON_OUTPUT_LIMITS;
// Fixtures derive from the exported budget so these tests keep asserting the same
// properties (two lines cross the raw budget; one line crosses the pending-line
// budget; a frame flood crosses the line budget) at any configured size.
// A line just past half the raw budget stays under the pending-line budget, so a
// second line can cross the raw budget without any single line being refused.
const OVER_BUDGET_LINE_CHARS = Math.ceil(maxTurnRawChars / 2) + 1;
const OVER_LINE_CHARS = maxPendingLineChars + 1;
const OVER_LINE_HALF_CHARS = Math.ceil(maxPendingLineChars / 2) + 1;

function toolResultFrame(
  toolUseId: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
    ...extra,
  };
}

function imageResultFrame(id: string, data: string, extra: Record<string, unknown> = {}) {
  return toolResultFrame(
    id,
    [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
    extra,
  );
}

describe("createCliJsonlStreamingParser framing", () => {
  it("frames coalesced Claude image and PDF lines before omitting retained binary bytes", () => {
    const results: CliToolResultDelta[] = [];
    const pluginLines: string[] = [];
    const parser = createClaudeParser({
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return null;
      },
      onToolResult: (result) => results.push(result),
    });
    const base64 = "a".repeat(4_300_000);
    const rawLines: string[] = [];
    for (const [type, mediaType] of [
      ["image", "image/png"],
      ["document", "application/pdf"],
    ] as const) {
      rawLines.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `read-${type}`,
                is_error: type === "document",
                content: [
                  { type: "text", text: `Read ${type}` },
                  {
                    type,
                    title: `${type} attachment`,
                    source: { type: "base64", media_type: mediaType, data: base64 },
                  },
                  {
                    type: "image",
                    source: { type: "url", url: "https://example.test/keep.png" },
                  },
                  {
                    type: "document",
                    source: { type: "text", media_type: "text/plain", data: "keep text" },
                  },
                ],
              },
            ],
          },
        }),
      );
    }
    const resultLine = JSON.stringify({ type: "result", result: "both attachments read" });
    parser.push(`${[...rawLines, resultLine].join("\n")}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("both attachments read");
    expect(results).toHaveLength(2);
    expect(pluginLines).toEqual([...rawLines, resultLine]);
    for (const [index, type, mediaType] of [
      [0, "image", "image/png"],
      [1, "document", "application/pdf"],
    ] as const) {
      expect(results[index]).toEqual({
        toolCallId: `read-${type}`,
        name: "",
        isError: type === "document",
        result: [
          { type: "text", text: `Read ${type}` },
          {
            type,
            title: `${type} attachment`,
            source: { type: "base64", media_type: mediaType },
            omitted: true,
            bytes: 3_225_000,
          },
          { type: "image", source: { type: "url", url: "https://example.test/keep.png" } },
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: "keep text" },
          },
        ],
      });
    }
  });

  it.each([
    { name: "echoed media bytes", padded: false },
    { name: "surrounding raw whitespace", padded: true },
  ])("counts $name claimed by Claude plugin parsers before dispatch", ({ padded }) => {
    const pluginLines: string[] = [];
    const assistantDeltas: string[] = [];
    const parser = createClaudeParser({
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return { kind: "text", text: "claimed" };
      },
      onAssistantDelta: (delta) => assistantDeltas.push(delta.delta),
    });
    const semanticLine = JSON.stringify(
      imageResultFrame("claimed-image", padded ? "YQ==" : "a".repeat(OVER_BUDGET_LINE_CHARS)),
    );
    const rawLine = padded ? `${" ".repeat(OVER_BUDGET_LINE_CHARS)}${semanticLine}` : semanticLine;

    parser.push(`${rawLine}\n${rawLine}\n`);

    expect(pluginLines).toEqual([semanticLine, semanticLine]);
    expect(assistantDeltas).toEqual(["claimed"]);
    expect(parser.getErrorText()).toContain("JSONL output exceeded");
  });

  it("charges blank Claude frames without invoking hooks", () => {
    const parseJsonlEvent = vi.fn(() => null);
<<<<<<< OURS/upstream-11.10
    const parser = createClaudeParser({ parseJsonlEvent });
    parser.push("\r\n".repeat(20_001));
    parser.finish();
||||||| BASE/v11.4
    const createParser = () =>
      createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        parseJsonlEvent,
        onAssistantDelta: () => {},
      });
    const completeParser = createParser();
    completeParser.push("\r\n".repeat(20_000));
    completeParser.finish();

    expect(completeParser.getErrorText()).toBeNull();
    expect(parseJsonlEvent).not.toHaveBeenCalled();

    const overflowParser = createParser();
    overflowParser.push("\n".repeat(20_001));
=======
    const createParser = () =>
      createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        parseJsonlEvent,
        onAssistantDelta: () => {},
      });
    const completeParser = createParser();
    completeParser.push("\r\n".repeat(maxTurnLines));
    completeParser.finish();

    expect(completeParser.getErrorText()).toBeNull();
    expect(parseJsonlEvent).not.toHaveBeenCalled();

    const overflowParser = createParser();
    overflowParser.push("\n".repeat(maxTurnLines + 1));
>>>>>>> THEIRS/pro-main

<<<<<<< OURS/upstream-11.10
    expect(parser.getErrorText()).toBeNull();
||||||| BASE/v11.4
    expect(overflowParser.getErrorText()).toContain("exceeded 20000 lines");
=======
    expect(overflowParser.getErrorText()).toContain(`exceeded ${maxTurnLines} lines`);
>>>>>>> THEIRS/pro-main
    expect(parseJsonlEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "whitespace-only records",
      createLine: () => " ".repeat(OVER_BUDGET_LINE_CHARS),
    },
    {
      name: "padding around valid JSON",
      createLine: () => `${" ".repeat(OVER_BUDGET_LINE_CHARS)}{}`,
    },
    {
      name: "tool-result IDs",
      createLine: () => JSON.stringify(toolResultFrame("i".repeat(4_300_000), [])),
    },
    {
      name: "mixed tool-result and user content",
      createLine: () =>
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "mixed", content: "x".repeat(4_300_000) },
              { type: "text", text: "note" },
            ],
          },
<<<<<<< OURS/upstream-11.10
        }),
||||||| BASE/v11.4
        }).replace('"message":', `"message":${" ".repeat(4_300_000)}`),
=======
        }).replace('"message":', `"message":${" ".repeat(OVER_BUDGET_LINE_CHARS)}`),
>>>>>>> THEIRS/pro-main
    },
  ])("charges $name against the Claude raw-output budget", ({ createLine }) => {
    const parser = createClaudeParser();
    const line = createLine();

    parser.push(`${line}\n${line}\n`);

    expect(parser.getErrorText()).toContain(`JSONL output exceeded ${maxTurnRawChars} characters`);
  });

  it("accepts a turn whose retained stream exceeds the former 8 MiB budget", () => {
    // Regression guard for the raised budget: one long CLI turn used to abort as
    // soon as its streamed JSONL crossed 8 MiB. Hold the new budget well above the
    // old one so only a deliberate reduction can fail this.
    expect(maxTurnRawChars).toBeGreaterThan(8 * 1024 * 1024);
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });
    const chunkChars = 512 * 1024;
    const line = `${JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "a".repeat(chunkChars) },
      },
    })}\n`;
    // 32 MiB: safely above the old 8 MiB cap and well below the new one.
    const frames = Math.ceil((32 * 1024 * 1024) / chunkChars);
    for (let index = 0; index < frames; index += 1) {
      parser.push(line);
    }
    parser.push(
      `${JSON.stringify({
        type: "assistant",
        message: { id: "final-message", content: [{ type: "text", text: "done" }] },
      })}\n`,
    );
    parser.push(`${JSON.stringify({ type: "result", subtype: "success", result: "done" })}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toContain("done");
  });

  it("normalizes empty Claude image data without treating zero omitted bytes as unchanged", () => {
    const results: CliToolResultDelta[] = [];
    const parser = createClaudeParser({
      onToolResult: (result) => results.push(result),
    });

    parser.push(`${JSON.stringify(imageResultFrame("empty-image", ""))}\n`);

    expect(results[0]?.result).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png" },
        omitted: true,
        bytes: 0,
      },
    ]);
  });

  it.each(["media", "text"] as const)(
    "delivers repeated %s tool results without losing the final reply",
    (kind) => {
      const results: CliToolResultDelta[] = [];
      const parser = createClaudeParser({ onToolResult: (result) => results.push(result) });
      const data = "A".repeat(600_000);
      const text = kind === "media" ? "Cursor Position: (1, 2)" : "x".repeat(120_000);
      const content = [
        { type: "text", text },
        ...(kind === "media"
          ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }]
          : []),
      ];
      for (let index = 0; index < 40; index += 1) {
        parser.push(
          `${JSON.stringify(
            toolResultFrame(`result-${index}`, content, { tool_use_result: content }),
          )}\n`,
        );
      }
      parser.push(`${JSON.stringify({ type: "result", result: "done" })}\n`);
      parser.finish();
      expect(parser.getErrorText()).toBeNull();
      expect(parser.getOutput()?.text).toBe("done");
      const expected = [
        { type: "text", text },
        ...(kind === "media"
          ? [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg" },
                omitted: true,
                bytes: estimateBase64DecodedBytes(data),
              },
            ]
          : []),
      ];
      expect(results.map((result) => result.result)).toEqual(
        Array.from({ length: 40 }, () => expected),
      );
    },
  );

  it("omits the base64 file payload Claude echoes for built-in image reads", () => {
    const parser = createClaudeParser();
    const base64 = "A".repeat(600_000);
    const readLine = (index: number) =>
      `${JSON.stringify(
        imageResultFrame(`read-${index}`, base64, {
          tool_use_result: { type: "image", file: { base64, type: "image/png", originalSize: 1 } },
        }),
      )}\n`;

    for (let index = 0; index < 20; index += 1) {
      parser.push(readLine(index));
    }

    expect(parser.getErrorText()).toBeNull();
  });

  it.each([
    {
      name: "image",
      field: "images",
      metadata: { mediaType: "image/png" },
    },
    {
      name: "document",
      field: "documents",
      metadata: {},
    },
  ] as const)(
    "omits Agent SDK REPL $name output from retained accounting",
    ({ field, metadata }) => {
      const parser = createClaudeParser();
      const base64 = "A".repeat(600_000);
      const replLine = () =>
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [] },
          tool_use_result: {
            code: "return await Read({ file_path });",
            result: {},
            stdout: "",
            stderr: "",
            [field]: [{ base64, ...metadata }],
          },
        })}\n`;

      for (let index = 0; index < 20; index += 1) {
        parser.push(replLine());
      }

      expect(parser.getErrorText()).toBeNull();
    },
  );

  it("normalizes a deeply nested record without exhausting the stack", () => {
    const parser = createClaudeParser();
    // Built as text: JSON.stringify is itself recursive and cannot serialize this.
    const depth = 50_000;
    const nested = `${'{"nested":'.repeat(depth)}${JSON.stringify({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    })}${"}".repeat(depth)}`;
    const toolResult = `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"deep","content":""}]},"tool_use_result":${nested}}`;
    const assistant = `{"type":"assistant","message":{"id":"deep","content":[${nested}]}}`;

    expect(() => parser.push(`${toolResult}\n${assistant}\n`)).not.toThrow();
    expect(parser.getErrorText()).toBeNull();
    // An assistant snapshot too deep to re-serialize keeps raw accounting.
    parser.push(`${assistant}\n`.repeat(16));
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
  });

  it("keeps the reply of a turn with thousands of small tool calls", () => {
    // Envelope metadata as Claude Code 2.1.322 emits it; ids are synthetic.
    const meta = { session_id: "s".repeat(36), uuid: "u".repeat(36), timestamp: "t".repeat(24) };
    const results: string[] = [];
    const parser = createClaudeParser({
      onToolResult: (result) => results.push(result.toolCallId),
    });
    for (let call = 0; call < 4_500; call += 1) {
      const tool = { type: "tool_use", id: `toolu_${call}`, name: "read", input: { path: "a" } };
      const text = [{ type: "text", text: "hello" }];
      parser.push(
        joinJsonlFrames(
          { type: "system", subtype: "status", status: "requesting", ...meta },
          claudeMessageStart(`msg_${call}`),
          claudeBlockStart({ ...tool, input: {} }, 0),
          claudeBlockStop(0),
          { type: "assistant", message: { id: `msg_${call}`, content: [tool] }, ...meta },
          toolResultFrame(tool.id, text, { ...meta, tool_use_result: text }),
          "",
        ),
      );
    }
    parser.push(joinJsonlFrames({ type: "result", subtype: "success", result: "done" }, ""));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(results).toHaveLength(4_500);
    expect(parser.getOutput()?.text).toBe("done");
  });

  it("still enforces raw Claude line and retained-text limits", () => {
    const createParser = createClaudeParser;
    const oversizedLineParser = createParser();
    oversizedLineParser.push(
      `${JSON.stringify(imageResultFrame("oversized-image", "a".repeat(OVER_LINE_CHARS)))}\n`,
    );
    expect(oversizedLineParser.getErrorText()).toContain("JSONL line exceeded");

    const growingPartialLineParser = createParser();
    growingPartialLineParser.push("a".repeat(OVER_LINE_HALF_CHARS));
    expect(growingPartialLineParser.getErrorText()).toBeNull();
    growingPartialLineParser.push("a".repeat(OVER_LINE_HALF_CHARS));
    expect(growingPartialLineParser.getErrorText()).toContain("JSONL line exceeded");

    const oversizedTextParser = createParser();
    // Assistant snapshots are retained and still spend the turn budget.
    for (const messageId of ["first", "second"]) {
      oversizedTextParser.push(
        `${JSON.stringify({
          type: "assistant",
          message: { id: messageId, content: [{ type: "text", text: "a".repeat(OVER_BUDGET_LINE_CHARS) }] },
        })}\n`,
      );
    }
    expect(oversizedTextParser.getErrorText()).toContain("JSONL output exceeded");

<<<<<<< OURS/upstream-11.10
    // Discarded tool-result payloads, metadata, and padding over 1 KiB count as frames.
    const discarded = "x".repeat(1_100);
    for (const line of [
      JSON.stringify(toolResultFrame("payload", [{ type: "text", text: discarded }])),
      JSON.stringify(toolResultFrame("metadata", [], { extra: discarded })),
      `${JSON.stringify(toolResultFrame("padding", []))}${" ".repeat(1_100)}`,
    ]) {
      const excessiveLinesParser = createParser();
      excessiveLinesParser.push(`${line}\n`.repeat(20_000));
      expect(excessiveLinesParser.getErrorText()).toBeNull();
      excessiveLinesParser.push(`${line}\n`);
      expect(excessiveLinesParser.getErrorText()).toContain("exceeded 20000 lines");
    }
||||||| BASE/v11.4
    const excessiveLinesParser = createParser();
    excessiveLinesParser.push("{}\n".repeat(20_001));
    expect(excessiveLinesParser.getErrorText()).toContain("exceeded 20000 lines");
=======
    const excessiveLinesParser = createParser();
    excessiveLinesParser.push("{}\n".repeat(maxTurnLines + 1));
    expect(excessiveLinesParser.getErrorText()).toContain(`exceeded ${maxTurnLines} lines`);
>>>>>>> THEIRS/pro-main
  });

  it.each([
    { providerId: "codex-cli", jsonlDialect: undefined },
    { providerId: "pi-cli", jsonlDialect: undefined },
    { providerId: "google-gemini-cli", jsonlDialect: "gemini-stream-json" as const },
  ])("preserves $providerId binary tool payloads byte-for-byte", ({ providerId, jsonlDialect }) => {
    const observedLines: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: providerId, output: "jsonl", ...(jsonlDialect ? { jsonlDialect } : {}) },
      providerId,
      parseJsonlEvent: (line) => {
        observedLines.push(line);
        return null;
      },
      onAssistantDelta: () => {},
    });
    const rawLine = JSON.stringify({
      type: "user",
      item: {
        type: "mcp_tool_call",
        result: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
      },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "keep-binary",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              },
            ],
          },
        ],
      },
    });
    parser.push(`\n \t\r\n${rawLine}\n`);

    expect(observedLines).toEqual([rawLine]);
  });

  it.each([
    ["start snapshot", { command: "ls -la" }, [], { command: "ls -la" }],
    ["explicit empty input", { command: "stale --from-start-block" }, ["{}"], {}],
    ["chunked input", {}, ['{"command":', ' "echo hi"}'], { command: "echo hi" }],
    ["malformed input", {}, ['{"command": "ls'], {}],
  ] as const)("reassembles tool arguments from %s", (_name, input, deltas, args) => {
    const frames = [
      claudeBlockStart({ type: "tool_use", id: "toolu_args", name: "Bash", input }, 0),
      ...deltas.map((delta) => claudeInputJsonDelta(delta, 0)),
      claudeBlockStop(0),
    ];
    const starts: CliToolUseStartDelta[] = [];
    const parser = createClaudeParser({
      backend: createClaudeBackend(),
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(starts).toEqual([{ toolCallId: "toolu_args", name: "Bash", kind: "tool_use", args }]);
  });
});
