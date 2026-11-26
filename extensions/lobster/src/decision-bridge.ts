import { createHash } from "node:crypto";
import type {
  DecisionAnswer,
  DecisionEntry,
  DecisionQuestion,
  DecisionRuntimeV1,
} from "openclaw/plugin-sdk/decisions";

/**
 * Lobster ⇄ decision-layer bridge.
 *
 * A dedicated `decision.evaluate` command turns a typed decision-layer answer into a
 * single-item stream whose `route` is a plain string, so a workflow condition can branch
 * on `$step.json.route == 'A'`. Nothing branches on an untyped LLM envelope: the host
 * binds its live `DecisionRuntimeV1` in-process (not `llm.invoke`/`openclaw.invoke`, and
 * not an external gateway call), and every rejected case throws so no route is guessed.
 *
 * The command is injected as a wrapped command registry over `createDefaultRegistry()`
 * (see `lobster-runner.ts`) because `createToolContext` honors `ctx.registry`. No Lobster
 * fork is needed.
 *
 * `@clawdbot/lobster` ships no `.d.ts`, so the command/registry shapes it calls are
 * hand-written here (same pattern as `lobster-runner.ts`). The decision contract itself is
 * a real type import from the Plugin SDK.
 */

export const DECISION_COMMAND_NAME = "decision.evaluate";

/**
 * Non-enumerable, in-process marker on a terminal rejection item. The embedded runner reads it
 * to refuse to report a stopped run as a success.
 *
 * A `Symbol` is used deliberately: a plain JSON field (`decisionBridgeRejection: true`) could be
 * produced by any ordinary workflow step — `exec --json echo '{"decisionBridgeRejection":true}'`
 * — and would then be misread as bridge control data, failing an innocent run. A symbol never
 * survives JSON parsing and cannot be forged from workflow output.
 */
export const DECISION_REJECTION_MARKER = Symbol("openclaw.lobster.decisionBridgeRejection");

/** Bound on any rejection text that leaves this module (items stay short, logs stay sane). */
export const MAX_REJECTION_REASON_CHARS = 400;

/** The host-bound evaluator the plugin injects; mirrors `DecisionRuntimeV1["evaluate"]`. */
export type DecisionEvaluator = DecisionRuntimeV1["evaluate"];

export type LobsterCommandContext = {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * Present on the real engine context, but this command does NOT write to it: the runner's
   * sink throws once a byte cap is passed and has no error listener, so an unbounded write
   * from here could take down the host process. A rejection travels as data (the halted item).
   */
  stderr?: { write: (chunk: string) => unknown };
};

export type LobsterCommandResult = {
  output?: AsyncIterable<unknown> | unknown[];
  /**
   * Stops the pipeline at this stage. The engine rethrows a halted stage before applying
   * `on_error`/`retry`, so a halt is the only result a command can use to make a rejection
   * terminal — an ordinary throw can be swallowed by `on_error: continue` and would let a
   * later branch run on a guessed route.
   */
  halt?: boolean;
};

export type LobsterCommand = {
  name: string;
  meta?: {
    description?: string;
    argsSchema?: unknown;
    sideEffects?: readonly string[];
    examples?: unknown;
  };
  help?: () => string;
  run: (params: {
    input: AsyncIterable<unknown>;
    args: Record<string, unknown>;
    ctx: LobsterCommandContext;
  }) => Promise<LobsterCommandResult | void>;
};

export type LobsterRegistry = {
  get: (name: string) => LobsterCommand | undefined;
  list: () => string[];
};

export type DecisionBridgeOptions = {
  /** The host-bound decision runtime evaluator. */
  evaluate: DecisionEvaluator;
  /** Owner agent identity; required — the command refuses to guess one. */
  agentId?: string;
  /** Audit purpose recorded with the host evaluation. */
  purpose: string;
  /** Bounded per-call timeout passed to the host; defaults to 30s. */
  defaultTimeoutMs?: number;
  /** Upper bound for `--timeout-ms`; defaults to 5 minutes. */
  maxTimeoutMs?: number;
};

/**
 * Acceptance policy plus the selected question. `resolveRoute` is pure: it validates the
 * policy bounds, finds the declared question, and applies the fail-closed truth table.
 */
export type RoutePolicy = {
  questions: Readonly<Record<string, DecisionQuestion>>;
  /** Selected question id; must be a key of `questions`. */
  question: string;
  minConfidence?: number;
  minProbability?: number;
  minMargin?: number;
};

const DEFAULT_DECISION_TIMEOUT_MS = 30_000;
const DEFAULT_DECISION_MAX_TIMEOUT_MS = 300_000;

function fail(message: string): never {
  throw new Error(message);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bridge policy, not provider semantics: the declared acceptance flags must be in their
 * stated bounds before any answer is considered. A flag outside its bounds is a caller
 * error (throw), never silently clamped.
 */
export function validateRoutePolicy(policy: RoutePolicy): void {
  if (policy.minConfidence !== undefined) {
    if (
      !isFiniteNumber(policy.minConfidence) ||
      policy.minConfidence < 0 ||
      policy.minConfidence > 1
    ) {
      fail("--min-confidence must be a finite number in [0, 1]");
    }
  }
  if (policy.minProbability !== undefined) {
    if (
      !isFiniteNumber(policy.minProbability) ||
      policy.minProbability <= 0.5 ||
      policy.minProbability > 1
    ) {
      fail("--min-probability must be a finite number in (0.5, 1]");
    }
  }
  if (policy.minMargin !== undefined) {
    if (!isFiniteNumber(policy.minMargin) || policy.minMargin < 0 || policy.minMargin >= 1) {
      fail("--min-margin must be a finite number in [0, 1)");
    }
  }
  if (
    policy.minConfidence === undefined &&
    policy.minProbability === undefined &&
    policy.minMargin === undefined
  ) {
    fail(
      "decision.evaluate requires an acceptance policy: --min-confidence, --min-probability, or --min-margin",
    );
  }
}

/**
 * The whole fail-closed truth table for a single answered question. Returns the route
 * string. Every rejected case throws, so the workflow aborts and runs no branch.
 *
 * Which rule is bridge policy vs a malformed/unavailable provider response:
 * - choice: the provider label must be the distribution's unique strict argmax. A provider
 *   label that disagrees with the argmax, or a tie, is a *bridge policy* rejection — the
 *   contract explicitly allows a non-argmax `choice`, and we refuse to pick one for you.
 *   A probability outside [0, 1] or a missing required confidence is a malformed answer.
 * - boolean: `true` above `--min-probability`, `false` below `1 - min`. The middle band is
 *   a *bridge policy* refusal to guess; a probability outside [0, 1] is malformed.
 * - score: the route is the unique strict argmax level index. That is *bridge policy*, not
 *   the provider's `score` semantics; the fractional `score` is passed through unchanged
 *   and never rounded. An array whose length disagrees with the rubric is malformed.
 */
export function resolveRoute(
  answer: DecisionAnswer | null | undefined,
  policy: RoutePolicy,
): string {
  validateRoutePolicy(policy);
  const question = policy.questions[policy.question];
  if (!question) {
    fail(`unknown decision question: ${policy.question}`);
  }
  if (answer === null || answer === undefined || typeof answer !== "object") {
    fail(`decision layer returned no answer for question ${policy.question}`);
  }
  // Match the answer discriminant first. Comparing `answer.type` against the union-typed
  // `question.type` narrows the answer union to `never`, so the declared question type is
  // checked inside each branch where both sides are already narrowed.
  switch (answer.type) {
    case "boolean":
      if (question.type !== "boolean") {
        fail(
          `decision answer type boolean does not match the declared question type ${question.type}`,
        );
      }
      return resolveBooleanRoute(answer, policy);
    case "choice":
      if (question.type !== "choice") {
        fail(
          `decision answer type choice does not match the declared question type ${question.type}`,
        );
      }
      return resolveChoiceRoute(answer, policy);
    case "score":
      if (question.type !== "score") {
        fail(
          `decision answer type score does not match the declared question type ${question.type}`,
        );
      }
      return resolveScoreRoute(answer, policy, question);
    default:
      // The answer union is fully covered above; this stays for an unrecognized runtime shape.
      return fail("unsupported decision answer type");
  }
}

function resolveBooleanRoute(
  answer: Extract<DecisionAnswer, { type: "boolean" }>,
  policy: RoutePolicy,
): string {
  if (policy.minProbability === undefined) {
    fail("boolean answers require --min-probability");
  }
  // A boolean answer carries only `probabilityTrue`: it has no confidence and no runner-up
  // alternative. A declared --min-confidence or --min-margin on a boolean question could
  // therefore never be honoured, so accepting the route would silently ignore the policy the
  // caller printed. Refuse the unsupported combination instead.
  if (policy.minConfidence !== undefined) {
    fail("--min-confidence is not supported for a boolean question; use --min-probability");
  }
  if (policy.minMargin !== undefined) {
    fail("--min-margin is not supported for a boolean question; use --min-probability");
  }
  const min = policy.minProbability;
  const probabilityTrue = answer.probabilityTrue;
  if (!isProbability(probabilityTrue)) {
    fail("boolean probabilityTrue must be a finite number in [0, 1]");
  }
  if (probabilityTrue >= min) {
    return "true";
  }
  // Symmetric form: `false` iff the complementary probability meets the same floor. Writing
  // `1 - probabilityTrue >= min` instead of `probabilityTrue <= 1 - min` avoids the
  // floating-point error in `1 - 0.9` (0.09999999999999998), which would wrongly mark the
  // inclusive false endpoint 0.1 as ambiguous.
  if (1 - probabilityTrue >= min) {
    return "false";
  }
  return fail(
    `boolean probability ${probabilityTrue} is ambiguous for --min-probability ${min} (middle band)`,
  );
}

function resolveChoiceRoute(
  answer: Extract<DecisionAnswer, { type: "choice" }>,
  policy: RoutePolicy,
): string {
  if (policy.minConfidence === undefined && policy.minMargin === undefined) {
    fail("choice answers require --min-confidence or --min-margin");
  }
  const choice = answer.choice;
  if (typeof choice !== "string") {
    fail("choice answer is missing its label");
  }
  const probabilities = answer.probabilities;
  if (!isPlainObject(probabilities)) {
    fail("choice answer is missing its probability distribution");
  }
  const entries = Object.entries(probabilities);
  if (entries.length === 0) {
    fail("choice answer probability distribution is empty");
  }
  for (const [label, value] of entries) {
    if (!isProbability(value)) {
      fail(`choice probability for ${label} must be a finite number in [0, 1]`);
    }
  }
  if (!Object.hasOwn(probabilities, choice)) {
    fail(`choice label ${choice} is not a key of the probability distribution`);
  }
  if (policy.minConfidence !== undefined) {
    const confidence = answer.confidence;
    if (!isFiniteNumber(confidence)) {
      fail("choice answer is missing a finite confidence required by --min-confidence");
    }
    if (confidence < policy.minConfidence) {
      fail(`choice confidence ${confidence} is below --min-confidence ${policy.minConfidence}`);
    }
  }
  const labelProbability = probabilities[choice]!;
  let runnerUp = Number.NEGATIVE_INFINITY;
  for (const [label, value] of entries) {
    if (label !== choice && value > runnerUp) {
      runnerUp = value;
    }
  }
  if (!(labelProbability > runnerUp)) {
    fail(`choice label ${choice} is not the unique strict argmax of the probability distribution`);
  }
  if (policy.minMargin !== undefined) {
    const margin = labelProbability - runnerUp;
    if (margin < policy.minMargin) {
      fail(`choice margin ${margin} is below --min-margin ${policy.minMargin}`);
    }
  }
  return choice;
}

function resolveScoreRoute(
  answer: Extract<DecisionAnswer, { type: "score" }>,
  policy: RoutePolicy,
  question: Extract<DecisionQuestion, { type: "score" }>,
): string {
  if (policy.minConfidence === undefined && policy.minMargin === undefined) {
    fail("score answers require --min-confidence or --min-margin");
  }
  const probabilities = answer.probabilities;
  if (!Array.isArray(probabilities) || probabilities.length === 0) {
    fail("score answer probabilities must be a non-empty array");
  }
  for (let index = 0; index < probabilities.length; index++) {
    if (!isProbability(probabilities[index])) {
      fail(`score probability at index ${index} must be a finite number in [0, 1]`);
    }
  }
  if (Array.isArray(question.criteria) && probabilities.length !== question.criteria.length) {
    fail(
      `score answer has ${probabilities.length} probabilities but the question declares ${question.criteria.length} criteria`,
    );
  }
  if (policy.minConfidence !== undefined) {
    const confidence = answer.confidence;
    if (!isFiniteNumber(confidence)) {
      fail("score answer is missing a finite confidence required by --min-confidence");
    }
    if (confidence < policy.minConfidence) {
      fail(`score confidence ${confidence} is below --min-confidence ${policy.minConfidence}`);
    }
  }
  let best = Number.NEGATIVE_INFINITY;
  let bestIndex = -1;
  let second = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < probabilities.length; index++) {
    const value = probabilities[index]!;
    if (value > best) {
      second = best;
      best = value;
      bestIndex = index;
    } else if (value > second) {
      second = value;
    }
  }
  let maxCount = 0;
  for (const value of probabilities) {
    if (value === best) {
      maxCount += 1;
    }
  }
  if (maxCount !== 1) {
    fail("score probabilities have no unique strict argmax");
  }
  if (policy.minMargin !== undefined && best - second < policy.minMargin) {
    fail(`score margin ${best - second} is below --min-margin ${policy.minMargin}`);
  }
  // Bridge policy: the fractional `score` is provider-owned and passed through unchanged.
  return String(bestIndex);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).toSorted()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable rubric identity for a questions map. Keys are sorted and arrays keep their order,
 * so the same rubric produces the same version regardless of key insertion order.
 * Local by design: the bridge never imports core rubric internals.
 */
export function rubricVersionFor(questions: Readonly<Record<string, DecisionQuestion>>): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(questions)))
    .digest("hex");
  return `lobster-bridge-v1-${digest.slice(0, 24)}`;
}

/**
 * Wrap a base registry (typically `createDefaultRegistry()`) so `decision.evaluate` is
 * available. The base registry is never mutated.
 */
export function createLobsterRegistry(
  base: LobsterRegistry,
  options: DecisionBridgeOptions,
): LobsterRegistry {
  const command = createDecisionEvaluateCommand(options);
  return {
    get(name) {
      if (name === DECISION_COMMAND_NAME) {
        return command;
      }
      return base.get(name);
    },
    list() {
      const names = new Set(base.list());
      names.add(DECISION_COMMAND_NAME);
      return [...names].toSorted();
    },
  };
}

export function createDecisionEvaluateCommand(options: DecisionBridgeOptions): LobsterCommand {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_DECISION_MAX_TIMEOUT_MS;
  return {
    name: DECISION_COMMAND_NAME,
    meta: {
      description: "Evaluate a typed decision-layer question and resolve a branchable route",
      argsSchema: {
        type: "object",
        properties: {
          "state-json": { type: "string", description: "JSON state (defaults to pipeline input)" },
          "questions-json": { type: "string", description: "JSON map of question definitions" },
          question: { type: "string", description: "Question id when the map has more than one" },
          "min-confidence": { type: "number", description: "Acceptance floor in [0, 1]" },
          "min-probability": {
            type: "number",
            description: "Boolean acceptance floor in (0.5, 1]",
          },
          "min-margin": { type: "number", description: "Top-two probability gap in [0, 1)" },
          "timeout-ms": { type: "number", description: "Host evaluation timeout in milliseconds" },
        },
        required: ["questions-json"],
      },
      sideEffects: ["calls_decision_layer"],
    },
    help() {
      return (
        `decision.evaluate — resolve a typed decision-layer answer into a route\n\n` +
        `Usage:\n` +
        `  decision.evaluate --questions-json '<map>' [--question <id>] <policy>\n\n` +
        `Accepts:\n` +
        `  --state-json <json>       State; defaults to the pipeline input item(s)\n` +
        `  --questions-json <json>   Non-empty map of choice/boolean/score questions\n` +
        `  --question <id>           Required when the map has more than one entry\n` +
        `  --min-confidence <n>      [0, 1]\n` +
        `  --min-probability <n>     Boolean only, (0.5, 1]\n` +
        `  --min-margin <n>          [0, 1)\n` +
        `  --timeout-ms <n>          Host evaluation timeout\n\n` +
        `Fail-closed: an unreachable decision layer, a malformed answer, a non-argmax choice\n` +
        `label, a tie, or an ambiguous boolean stops the workflow terminally. The rejection is\n` +
        `returned as a halted stage, so a step-level on_error/retry cannot recover a route.\n`
      );
    },
    async run({ input, args, ctx }) {
      // Every rejection is returned as a TERMINAL halt, not a throw. The engine rethrows a
      // halted pipeline stage before `on_error`/`retry`, so a halt is the only result that
      // cannot be swallowed: with `on_error: continue` an ordinary throw would let a later
      // negated condition (`!= 'A'`) run on a route that was never resolved.
      try {
        return await runAccepted({ input, args, ctx, options, defaultTimeoutMs, maxTimeoutMs });
      } catch (error) {
        // Caller cancellation and timeout are not decision rejections: let the engine surface
        // the cancellation instead of reporting a rejected decision.
        if (ctx.signal?.aborted) {
          throw error;
        }
        const reason = (error instanceof Error ? error.message : String(error)).slice(
          0,
          MAX_REJECTION_REASON_CHARS,
        );
        // No stderr write here: the runner's stderr sink is byte-capped and has no error
        // listener, so an over-long write would crash the process instead of failing the run.
        // The reason is carried on the halted item and surfaced by the engine/runner.
        const item: Record<string | symbol, unknown> = { status: "rejected", reason };
        item[DECISION_REJECTION_MARKER] = true;
        return { halt: true, output: asStream([item]) };
      }
    },
  };
}

/** The accepting path; any thrown rejection is converted to a terminal halt by `run`. */
async function runAccepted({
  input,
  args,
  ctx,
  options,
  defaultTimeoutMs,
  maxTimeoutMs,
}: {
  input: AsyncIterable<unknown>;
  args: Record<string, unknown>;
  ctx: LobsterCommandContext;
  options: DecisionBridgeOptions;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}): Promise<LobsterCommandResult> {
  const agentId = (options.agentId ?? "").trim();
  if (!agentId) {
    fail("decision.evaluate requires a bound agent identity");
  }
  const questions = parseQuestions(args);
  const questionId = selectQuestion(questions, args);
  const { policy, view } = buildPolicy(questions, questionId, args, defaultTimeoutMs, maxTimeoutMs);
  const state = await resolveState(args, input);
  const rubricVersion = rubricVersionFor(questions);
  const signal = ctx.signal ?? new AbortController().signal;
  const outcome: unknown = await options.evaluate(
    { state: state as DecisionEntry, questions },
    {
      agentId,
      purpose: options.purpose,
      rubricVersion,
      timeoutMs: policy.timeoutMs,
      signal,
    },
  );
  if (!isPlainObject(outcome) || typeof outcome.status !== "string") {
    fail("decision layer returned no result");
  }
  if (outcome.status === "unavailable") {
    fail(`decision layer unavailable: ${String(outcome.reason)}`);
  }
  if (outcome.status !== "ok") {
    fail(`decision layer returned an unexpected status: ${outcome.status}`);
  }
  const result = outcome.result;
  if (!isPlainObject(result) || !isPlainObject(result.answers)) {
    fail("decision layer returned no answers");
  }
  const answer = result.answers[questionId] as DecisionAnswer | undefined;
  const route = resolveRoute(answer, policy);
  const item = {
    status: "ok",
    type: (answer as DecisionAnswer).type,
    question: questionId,
    route,
    answer,
    policy: view,
    model: result.model,
    provenance: outcome.provenance,
  };
  return { output: asStream([item]) };
}

type ParsedPolicy = {
  policy: RoutePolicy & { timeoutMs: number };
  view: Record<string, number>;
};

function parseQuestions(args: Record<string, unknown>): Record<string, DecisionQuestion> {
  const raw = readStringFlag(args, "questions-json");
  if (raw === undefined) {
    fail("decision.evaluate requires --questions-json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("--questions-json must be valid JSON");
  }
  if (!isPlainObject(parsed) || Object.keys(parsed).length === 0) {
    fail("--questions-json must be a non-empty object");
  }
  for (const [id, question] of Object.entries(parsed)) {
    if (!isPlainObject(question) || typeof question.type !== "string") {
      fail(`question ${id} must be an object with a type`);
    }
  }
  return parsed as Record<string, DecisionQuestion>;
}

function selectQuestion(
  questions: Record<string, DecisionQuestion>,
  args: Record<string, unknown>,
) {
  const ids = Object.keys(questions);
  const requested = readStringFlag(args, "question");
  if (requested === undefined) {
    if (ids.length === 1) {
      return ids[0]!;
    }
    fail("--question is required when --questions-json has more than one entry");
  }
  if (!Object.hasOwn(questions, requested)) {
    fail(`unknown --question ${requested}`);
  }
  return requested;
}

function buildPolicy(
  questions: Record<string, DecisionQuestion>,
  questionId: string,
  args: Record<string, unknown>,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
): ParsedPolicy {
  const minConfidence = readBound(args, "min-confidence", { min: 0, max: 1 });
  const minProbability = readBound(args, "min-probability", {
    min: 0.5,
    max: 1,
    minExclusive: true,
  });
  const minMargin = readBound(args, "min-margin", { min: 0, max: 1, maxExclusive: true });
  const policy: RoutePolicy & { timeoutMs: number } = {
    questions,
    question: questionId,
    timeoutMs: readTimeout(args, defaultTimeoutMs, maxTimeoutMs),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    ...(minProbability !== undefined ? { minProbability } : {}),
    ...(minMargin !== undefined ? { minMargin } : {}),
  };
  validateRoutePolicy(policy);
  const view: Record<string, number> = {};
  if (minConfidence !== undefined) {
    view.minConfidence = minConfidence;
  }
  if (minProbability !== undefined) {
    view.minProbability = minProbability;
  }
  if (minMargin !== undefined) {
    view.minMargin = minMargin;
  }
  return { policy, view };
}

function readBound(
  args: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number; minExclusive?: boolean; maxExclusive?: boolean },
): number | undefined {
  const raw = args[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    fail(`--${key} must be a number`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fail(`--${key} must be a finite number`);
  }
  const aboveMin = bounds.minExclusive ? value > bounds.min : value >= bounds.min;
  const belowMax = bounds.maxExclusive ? value < bounds.max : value <= bounds.max;
  if (!aboveMin || !belowMax) {
    fail(`--${key} is out of bounds`);
  }
  return value;
}

function readTimeout(
  args: Record<string, unknown>,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
): number {
  // The configured default and maximum are both clamped: a `--timeout-ms 0.5` must not become
  // the invalid host option `0`, and a maximum below the default must still cap the default.
  const ceiling = Math.max(1, Math.floor(maxTimeoutMs));
  const floorDefault = Math.max(1, Math.floor(defaultTimeoutMs));
  const fallback = Math.min(floorDefault, ceiling);
  const raw = args["timeout-ms"];
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    fail("--timeout-ms must be a positive number");
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    fail("--timeout-ms must be a positive number");
  }
  // A fractional positive value floors to at least 1ms, never to 0.
  return Math.min(Math.max(1, Math.floor(value)), ceiling);
}

async function resolveState(
  args: Record<string, unknown>,
  input: AsyncIterable<unknown>,
): Promise<unknown> {
  const raw = readStringFlag(args, "state-json");
  if (raw !== undefined) {
    try {
      return JSON.parse(raw);
    } catch {
      fail("--state-json must be valid JSON");
    }
  }
  const items: unknown[] = [];
  for await (const item of input) {
    items.push(item);
  }
  if (items.length === 0) {
    fail("decision.evaluate requires state: pass --state-json or a pipeline input item");
  }
  return items.length === 1 ? items[0] : items;
}

function readStringFlag(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

async function* asStream(items: unknown[]): AsyncIterable<unknown> {
  for (const item of items) {
    yield item;
  }
}
