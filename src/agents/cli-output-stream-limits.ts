import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CliStreamJsonOutputLimits } from "./cli-output-contracts.js";
// Stream-json output limits and raw-line framing for the CLI streaming parser.
// Kept beside `cli-output-stream.ts` so the parser stays within the file-size
// budget; the limits are process constants, not per-backend configuration.
import { normalizeClaudeCliStreamJsonRecord } from "./cli-output-echoed-binary.js";
import { readClaudeAttributedSubagentProgressId } from "./cli-output-records.js";

// One long CLI turn (a reasoning-heavy coding run) can legitimately stream tens of
// MiB of JSONL before it finishes; the earlier 8 MiB char / 20k-line pair aborted
// such turns at the transport, after the work itself was already done.
//
// The char budget is the real memory guard: the parser retains the streamed
// assistant text, which costs about 2x its character count in RSS (measured on
// Node 26 without forced GC: 16 MiB retained -> +34 MiB peak RSS, 32 MiB -> +56
// MiB, 63 MiB -> +114 MiB). 64 MiB therefore bounds one turn at roughly 110-130
// MiB. The char budget is ALSO the single pending-line cap, so one line may hold
// up to 64 MiB on its own; framing scans only the new chunk (linear, ~5 ms for
// 16,384 chunks), so that cannot stall the process.
//
// The line budget scales with it to preserve the shipped design point: the old
// pair allowed ~419 characters per line (8 MiB / 20,000), so typical ~300-char
// JSONL lines hit the line cap near 6 MiB - BEFORE the char cap - which is why
// raising only the char budget would have changed nothing. 160,000 lines keeps
// that same ~419-char crossover (64 MiB / 160,000), so the char cap stays the
// binding guard for realistic line lengths while a flood of tiny frames (which
// the parser still bounds by count) is capped as before. Incremental
// partial-message frames are charged against chars but not against the line
// budget, so a token-delta-heavy turn cannot trip the line cap first.
//
// Concurrency context (host `gateway`, 2026-11-21): subagent maxConcurrent=8 per
// spawning session; ~100-130 MiB per in-flight turn is comfortable against the
// gateway's ~19 GiB resident and the host's 30 GiB. The gateway heap is capped
// well above this, so these caps, not an OOM, remain the first thing to trip.
const CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS = 64 * 1024 * 1024;
const CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES = 160_000;
export const CLI_STREAM_JSON_OUTPUT_LIMITS = Object.freeze({
  maxTurnRawChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  maxPendingLineChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  maxTurnLines: CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES,
} satisfies CliStreamJsonOutputLimits);

const PARTIAL_RECORD_KEYS = new Set(["type", "event", "uuid", "session_id", "parent_tool_use_id"]);
const PARTIAL_EVENT_KEYS = new Set(["type", "index", "delta"]);

/** Discount recognized token envelopes, retaining payload, padding, and a per-frame budget. */
function measureClaudePartialMessage(
  parsed: Record<string, unknown>,
  rawLine: string,
): number | undefined {
  if (
    parsed.type !== "stream_event" ||
    !isRecord(parsed.event) ||
    Object.keys(parsed).some((key) => !PARTIAL_RECORD_KEYS.has(key))
  ) {
    return undefined;
  }
  for (const key of ["uuid", "session_id", "parent_tool_use_id"]) {
    const value = parsed[key];
    if (value != null && (typeof value !== "string" || value.length > 128)) {
      return undefined;
    }
  }
  const event = parsed.event;
  if (
    event.type !== "content_block_delta" ||
    !isRecord(event.delta) ||
    Object.keys(event).some((key) => !PARTIAL_EVENT_KEYS.has(key)) ||
    (event.index !== undefined &&
      (typeof event.index !== "number" || !Number.isSafeInteger(event.index) || event.index < 0))
  ) {
    return undefined;
  }
  const delta = event.delta;
  const field =
    delta.type === "text_delta"
      ? "text"
      : delta.type === "thinking_delta"
        ? "thinking"
        : delta.type === "input_json_delta"
          ? "partial_json"
          : undefined;
  const payload = field ? delta[field] : undefined;
  if (
    typeof payload !== "string" ||
    !payload ||
    Object.keys(delta).some(
      (key) =>
        key !== "type" &&
        key !== field &&
        !(delta.type === "thinking_delta" && key === "estimated_tokens"),
    )
  ) {
    return undefined;
  }
  const estimatedTokens = delta.estimated_tokens;
  if (
    estimatedTokens != null &&
    (typeof estimatedTokens !== "number" || !Number.isFinite(estimatedTokens))
  ) {
    return undefined;
  }
  // The fixed charge bounds tiny delta floods and retained chunk bookkeeping:
  // the 8 MiB budget admits fewer than 262,144 partial frames. Empty deltas,
  // unknown fields, and oversized metadata keep the ordinary raw/frame limits.
  return (
    JSON.stringify(payload).length +
    32 +
    (estimatedTokens === undefined
      ? 0
      : JSON.stringify({ estimated_tokens: estimatedTokens }).length) +
    Math.max(0, rawLine.length - JSON.stringify(parsed).length)
  );
}

// Forwarded child message payloads are discarded; only their progress id survives.
// Stream events can retain text even with child attribution, so keep their full charge.
const CLAUDE_SUBAGENT_RECORD_CHARS = 64;

/** Fixed charge only for child message records the parser discards. */
function measureClaudeSubagentRecord(parsed: Record<string, unknown>): number | undefined {
  if ((parsed.type !== "assistant" && parsed.type !== "user") || parsed.item != null) {
    return undefined;
  }
  const parentToolUseId = readClaudeAttributedSubagentProgressId(parsed);
  if (
    !parentToolUseId ||
    parentToolUseId.length > 128 ||
    (typeof parsed.parent_tool_use_id === "string" && parsed.parent_tool_use_id.length > 128)
  ) {
    return undefined;
  }
  return CLAUDE_SUBAGENT_RECORD_CHARS;
}

/** Budget charge for one Claude stream-json line, and whether it is a partial-message frame. */
export function chargeClaudeStreamJsonLine(
  record: Record<string, unknown> | undefined,
  rawLine: string,
): { chars: number; partialMessage: boolean } {
  const partialChars = record ? measureClaudePartialMessage(record, rawLine) : undefined;
  const subagentChars = record ? measureClaudeSubagentRecord(record) : undefined;
  const normalized = record ? normalizeClaudeCliStreamJsonRecord(record) : undefined;
  // Neither media omission nor token-envelope discounts may erase wire whitespace.
  const chars =
    subagentChars ??
    partialChars ??
    (normalized
      ? Math.max(normalized.line.length, rawLine.length - normalized.omittedRawChars)
      : rawLine.length);
  return { chars, partialMessage: partialChars !== undefined };
}

/** Frames arbitrary stdout chunks while bounding each individual raw JSONL line. */
export function frameBoundedCliJsonlChunk(
  state: { pending: string },
  chunk: string,
  maxLineChars: number,
  onLine: (line: string) => boolean | void,
): boolean {
  for (let offset = 0; offset < chunk.length;) {
    const newlineIndex = chunk.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
    if (state.pending.length + (lineEnd - offset) > maxLineChars) {
      state.pending = "";
      return false;
    }
    state.pending += chunk.slice(offset, lineEnd);
    if (newlineIndex === -1) {
      return true;
    }
    const line = state.pending;
    // Control-response writes can synchronously reenter stdout framing.
    state.pending = "";
    offset = newlineIndex + 1;
    if (onLine(line) === false) {
      return true;
    }
  }
  return true;
}

export function streamJsonOutputLimitErrorText(
  kind: "raw" | "line" | "lines",
  limit: number,
): string {
  if (kind === "line") {
    return `CLI JSONL line exceeded ${limit} characters; refusing to parse output.`;
  }
  if (kind === "lines") {
    return `CLI JSONL output exceeded ${limit} lines; refusing to parse output.`;
  }
  return `CLI JSONL output exceeded ${limit} characters; refusing to parse output.`;
}
