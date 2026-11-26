import type { DecisionBatch, ProviderDecisionOutcome } from "openclaw/plugin-sdk/decisions";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedRuntimeConfig } from "./config.js";
import { DecisionAdmissionError, EvaluationError } from "./errors.js";
import {
  buildRequestPlan,
  DECISION_MODEL_ID,
  mapAnswers,
  MAX_RESPONSE_BYTES,
  SERVED_MODEL,
  type RequestPlan,
} from "./schema.js";

type Context = {
  model: string;
  signal: AbortSignal;
  deadlineMonotonicMs: number;
  isAdmissible?: () => boolean;
};

/** Render any admitted entry deterministically; non-strings become compact JSON. */
function render(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

/**
 * Everything the model needs, as text: the shared state, each question's
 * instructions, type, ordered anchors, and the exact shape to return. The
 * schema is repeated here because `response_format` can be ignored by some
 * non-conforming servers, and strict schemas constrain but do not explain.
 */
export function buildPrompt(plan: RequestPlan): string {
  const lines: string[] = [
    "You are a decision engine for typed, structured judgments.",
    "Assess only the shared state below. Answer every question exactly once.",
    "",
    "Shared state (JSON):",
    render(plan.state),
    "",
    `Return ONE JSON object with exactly these keys: ${plan.questions.map((question) => question.synthetic).join(", ")}.`,
    "Output raw JSON only: no prose, no markdown, no code fences, no extra or missing keys.",
    "",
  ];
  for (const question of plan.questions) {
    lines.push(`${question.synthetic} (${question.type}):`);
    if (question.instructions !== undefined) {
      lines.push(`  instructions: ${render(question.instructions)}`);
    }
    if (question.type === "choice") {
      const labels = question.choiceLabels ?? [];
      lines.push("  estimate a probability for each alternative, keyed exactly:");
      for (const { synthetic, description } of labels) {
        lines.push(`    ${synthetic}: ${render(description)}`);
      }
      lines.push(
        `  required shape: {"type":"choice","probabilities":{${labels
          .map(({ synthetic }) => `"${synthetic}":number`)
          .join(",")}},"choice":"<one of ${labels.map(({ synthetic }) => synthetic).join(", ")}>"}`,
      );
      lines.push(
        "  every probability is in [0,1], at least one is greater than 0; set choice to one alternative key.",
      );
    } else if (question.type === "score") {
      const levels = question.levels ?? [];
      lines.push("  ordered rubric levels (first is lowest), one probability each, in this order:");
      levels.forEach((level, index) => {
        lines.push(`    l${index}: ${render(level)}`);
      });
      lines.push(
        `  required shape: {"type":"score","probabilities":[${levels.map(() => "number").join(",")}],"score":number}`,
      );
      lines.push(
        `  probabilities has exactly ${levels.length} entries in that order, each in [0,1] with at least one greater than 0; score is in [0, ${levels.length - 1}].`,
      );
    } else {
      lines.push(`  true criterion: ${render(question.trueCriterion)}`);
      lines.push(`  false criterion: ${render(question.falseCriterion)}`);
      lines.push('  required shape: {"type":"boolean","probabilityTrue":number}');
      lines.push("  probabilityTrue is in [0,1].");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function localhostLookup() {
  // Keep localhost local even if system DNS or a hosts entry overrides it.
  return Promise.resolve([
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
}

function readUsage(
  value: unknown,
):
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "ok"; usage: { inputTokens: number; outputTokens: number } } {
  if (value === undefined) {
    return { kind: "absent" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const { prompt_tokens: input, completion_tokens: output } = value as Record<string, unknown>;
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isInteger(output) ||
    output < 0
  ) {
    return { kind: "invalid" };
  }
  return { kind: "ok", usage: { inputTokens: input, outputTokens: output } };
}

function invalidResponse(): ProviderDecisionOutcome {
  return { status: "unavailable", reason: "invalid-response" };
}

function mapPayload(payload: Record<string, unknown>, plan: RequestPlan): ProviderDecisionOutcome {
  if (payload.model !== SERVED_MODEL) {
    return invalidResponse();
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    return invalidResponse();
  }
  const choice = choices[0];
  if (
    typeof choice !== "object" ||
    choice === null ||
    Array.isArray(choice) ||
    choice.finish_reason !== "stop"
  ) {
    return invalidResponse();
  }
  const message = choice.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return invalidResponse();
  }
  const record = message as Record<string, unknown>;
  if (record.refusal !== undefined && record.refusal !== null) {
    return invalidResponse();
  }
  const content = record.content;
  if (typeof content !== "string" || !content.trim()) {
    return invalidResponse();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return invalidResponse();
  }
  const answers = mapAnswers(plan, parsed);
  if (!answers) {
    return invalidResponse();
  }
  const usage = readUsage(payload.usage);
  if (usage.kind === "invalid") {
    return invalidResponse();
  }
  return {
    status: "ok",
    result: {
      model: DECISION_MODEL_ID,
      answers,
      ...(usage.kind === "ok" ? { usage: usage.usage } : {}),
    },
  };
}

function httpOutcome(response: Response): ProviderDecisionOutcome {
  if (response.status === 401 || response.status === 403) {
    return { status: "unavailable", reason: "authentication" };
  }
  if (response.status === 429) {
    const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
    return {
      status: "unavailable",
      reason: "rate-limited",
      ...(seconds === undefined ? {} : { retryAfterMs: seconds * 1000 }),
    };
  }
  // 400/413/422 reject the request itself, including a strict schema the server
  // cannot satisfy; neither the tokenizer nor context cause is established here.
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return { status: "unavailable", reason: "transport" };
}

/** Evaluate explicit state against the loopback Example endpoint. No retries, no ambient data. */
export async function evaluate(
  batch: DecisionBatch,
  config: ResolvedRuntimeConfig,
  context: Context,
): Promise<ProviderDecisionOutcome> {
  const { model, signal, deadlineMonotonicMs, isAdmissible } = context;
  signal.throwIfAborted();
  const timeoutMs = Math.min(config.timeoutMs, deadlineMonotonicMs - performance.now());
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timedSignal, cleanup } = buildTimeoutAbortSignal({
    signal,
    timeoutMs,
    operation: "Example decision",
  });
  const active = timedSignal ?? signal;
  const assertActive = () => {
    active.throwIfAborted();
    // Synchronous preparation can exhaust the deadline before the abort timer runs.
    if (!(performance.now() < deadlineMonotonicMs)) {
      throw new EvaluationError("Example decision timed out.", "transport");
    }
    if (isAdmissible && !isAdmissible()) {
      throw new DecisionAdmissionError();
    }
  };
  const baseUrl = config.baseUrl;
  try {
    // Unowned-model and over-cap rejection precede any transport work.
    const plan = buildRequestPlan(batch, model);
    assertActive();
    const url = `${baseUrl}/v1/chat/completions`;
    const body = JSON.stringify({
      model: SERVED_MODEL,
      messages: [{ role: "user", content: buildPrompt(plan) }],
      max_tokens: config.maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: "example_decision", schema: plan.schema, strict: true },
      },
    });
    const guarded = await fetchWithSsrFGuard({
      url,
      fetchImpl: globalThis.fetch,
      requireHttps: false,
      policy: { allowedOrigins: [baseUrl] },
      ...(new URL(baseUrl).hostname === "localhost" ? { lookupFn: localhostLookup } : {}),
      maxRedirects: 0,
      signal: active,
      beforeRequest: assertActive,
      init: {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body,
      },
    });
    try {
      const response = guarded.response;
      if (!response.ok) {
        // Error payloads may echo supplied state; classify without consuming them.
        await response.body?.cancel();
        return httpOutcome(response);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readProviderJsonObjectResponse(response, "Example decision", {
          maxBytes: MAX_RESPONSE_BYTES,
          signal: active,
        });
      } catch {
        signal.throwIfAborted();
        if (active.aborted) {
          throw new EvaluationError("Example decision timed out.", "transport");
        }
        return invalidResponse();
      }
      assertActive();
      return mapPayload(payload, plan);
    } finally {
      await guarded.release();
    }
  } catch (error) {
    signal.throwIfAborted();
    // Admission closure stays terminal; every other failure is a returned outage.
    if (error instanceof DecisionAdmissionError) {
      throw error;
    }
    const failure = error instanceof EvaluationError ? error : undefined;
    return {
      status: "unavailable",
      reason: failure?.reason ?? "transport",
      ...(failure?.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    };
  } finally {
    cleanup();
  }
}
