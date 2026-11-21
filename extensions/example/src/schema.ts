import type { DecisionAnswer, DecisionBatch, DecisionEntry } from "openclaw/plugin-sdk/decisions";
import { EvaluationError } from "./errors.js";

// The host bounds a batch at 1 MiB; our response cap is independent so a runaway
// model cannot force the runtime to buffer an unbounded body.
export const MAX_BATCH_BYTES = 1_048_576;
export const MAX_RESPONSE_BYTES = 1_048_576;

/** The only host-selected decision model this provider serves. */
export const DECISION_MODEL_REF = "example/ds41-314113f8";
/** The bare host model id, accepted because the host may pass either form. */
export const DECISION_MODEL_ID = "ds41-314113f8";
/** Served checkpoint name; the response `model` field must equal this exactly. */
export const SERVED_MODEL = "ds41";

const MAX_QUESTIONS = 32;
const MAX_CHOICE_LABELS = 64;
const MAX_SCORE_LEVELS = 10;

export type PlannedChoiceLabel = { synthetic: string; real: string; description: DecisionEntry };

export type PlannedQuestion = {
  synthetic: string;
  id: string;
  type: "choice" | "score" | "boolean";
  instructions: DecisionEntry | undefined;
  schema: Record<string, unknown>;
  // choice: synthetic label keys aligned to real labels and descriptions.
  choiceLabels?: PlannedChoiceLabel[];
  // score: ordered rubric levels, aligned to probability positions.
  levels?: readonly DecisionEntry[];
  // boolean: optional outcome descriptions.
  trueCriterion?: DecisionEntry;
  falseCriterion?: DecisionEntry;
};

export type RequestPlan = {
  state: DecisionEntry;
  questions: PlannedQuestion[];
  schema: Record<string, unknown>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function unsupported(message: string): never {
  throw new EvaluationError(message, "unsupported-input");
}

function choiceQuestionSchema(labels: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      type: { const: "choice" },
      probabilities: {
        type: "object",
        properties: Object.fromEntries(labels.map((label) => [label, { type: "number" }])),
        required: [...labels],
        additionalProperties: false,
      },
      choice: { type: "string", enum: [...labels] },
    },
    required: ["type", "probabilities", "choice"],
    additionalProperties: false,
  };
}

function scoreQuestionSchema(levels: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      type: { const: "score" },
      probabilities: {
        type: "array",
        items: { type: "number" },
        minItems: levels,
        maxItems: levels,
      },
      score: { type: "number" },
    },
    required: ["type", "probabilities", "score"],
    additionalProperties: false,
  };
}

function booleanQuestionSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { type: { const: "boolean" }, probabilityTrue: { type: "number" } },
    required: ["type", "probabilityTrue"],
    additionalProperties: false,
  };
}

/**
 * Build the strict response schema plus the synthetic-name -> real-question map.
 * Question ids and labels never become schema property names: they may contain
 * quotes, `__proto__`, or Unicode that must not shape the grammar. Caps are
 * enforced here, before any transport work.
 */
export function buildRequestPlan(batch: DecisionBatch, model: string): RequestPlan {
  if (model !== DECISION_MODEL_REF && model !== DECISION_MODEL_ID) {
    unsupported("Example serves only the example/ds41-314113f8 decision model.");
  }
  const entries = Object.entries(batch.questions);
  if (entries.length > MAX_QUESTIONS) {
    unsupported("Example accepts at most 32 questions per batch.");
  }
  const questions: PlannedQuestion[] = [];
  for (const [index, [id, question]] of entries.entries()) {
    const synthetic = `q${index}`;
    if (question.type === "choice") {
      const criteria = Object.entries(question.criteria);
      if (criteria.length > MAX_CHOICE_LABELS) {
        unsupported("Example accepts at most 64 alternatives per choice question.");
      }
      const choiceLabels = criteria.map(([real, description], labelIndex) => ({
        synthetic: `l${labelIndex}`,
        real,
        description,
      }));
      questions.push({
        synthetic,
        id,
        type: "choice",
        instructions: question.instructions,
        schema: choiceQuestionSchema(choiceLabels.map((entry) => entry.synthetic)),
        choiceLabels,
      });
    } else if (question.type === "score") {
      if (question.criteria.length > MAX_SCORE_LEVELS) {
        unsupported("Example accepts at most 10 levels per score question.");
      }
      questions.push({
        synthetic,
        id,
        type: "score",
        instructions: question.instructions,
        schema: scoreQuestionSchema(question.criteria.length),
        levels: question.criteria,
      });
    } else {
      questions.push({
        synthetic,
        id,
        type: "boolean",
        instructions: question.instructions,
        schema: booleanQuestionSchema(),
        trueCriterion: question.criteria?.true,
        falseCriterion: question.criteria?.false,
      });
    }
  }
  if (Buffer.byteLength(JSON.stringify(batch), "utf8") > MAX_BATCH_BYTES) {
    unsupported("Example batch exceeds the 1 MiB request limit.");
  }
  return {
    state: batch.state,
    questions,
    schema: {
      type: "object",
      properties: Object.fromEntries(
        questions.map((question) => [question.synthetic, question.schema]),
      ),
      required: questions.map((question) => question.synthetic),
      additionalProperties: false,
    },
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function mapChoice(
  question: PlannedQuestion,
  value: Record<string, unknown>,
): DecisionAnswer | null {
  if (!exactKeys(value, ["type", "probabilities", "choice"]) || value.type !== "choice") {
    return null;
  }
  const choiceLabels = question.choiceLabels;
  if (!choiceLabels || !record(value.probabilities)) {
    return null;
  }
  const syntheticLabels = choiceLabels.map((entry) => entry.synthetic);
  if (!exactKeys(value.probabilities, syntheticLabels)) {
    return null;
  }
  // Build with Object.fromEntries: a label may legitimately be `__proto__`, and a
  // plain `{}` assignment would set the prototype instead of creating that key — the
  // host would then reject the whole batch and count it toward its circuit breaker.
  const probabilities: [string, number][] = [];
  let positive = false;
  for (const entry of choiceLabels) {
    const estimate = value.probabilities[entry.synthetic];
    if (!probability(estimate)) {
      return null;
    }
    positive ||= estimate > 0;
    probabilities.push([entry.real, estimate]);
  }
  if (!positive || typeof value.choice !== "string") {
    return null;
  }
  const chosen = choiceLabels.find((entry) => entry.synthetic === value.choice);
  if (!chosen) {
    return null;
  }
  return { type: "choice", choice: chosen.real, probabilities: Object.fromEntries(probabilities) };
}

function mapScore(
  question: PlannedQuestion,
  value: Record<string, unknown>,
): DecisionAnswer | null {
  if (!exactKeys(value, ["type", "probabilities", "score"]) || value.type !== "score") {
    return null;
  }
  const levels = question.levels;
  if (
    !levels ||
    !Array.isArray(value.probabilities) ||
    value.probabilities.length !== levels.length
  ) {
    return null;
  }
  const probabilities: number[] = [];
  let positive = false;
  for (const estimate of value.probabilities) {
    if (!probability(estimate)) {
      return null;
    }
    positive ||= estimate > 0;
    probabilities.push(estimate);
  }
  const score = value.score;
  if (
    !positive ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > levels.length - 1
  ) {
    return null;
  }
  return { type: "score", score, probabilities };
}

function mapBoolean(value: Record<string, unknown>): DecisionAnswer | null {
  if (!exactKeys(value, ["type", "probabilityTrue"]) || value.type !== "boolean") {
    return null;
  }
  if (!probability(value.probabilityTrue)) {
    return null;
  }
  return { type: "boolean", probabilityTrue: value.probabilityTrue };
}

/**
 * Accept the response only when every key and value matches its exact synthetic
 * shape. Estimates pass through unchanged; a partial batch, a repaired value,
 * or a default answer is never returned.
 */
export function mapAnswers(
  plan: RequestPlan,
  parsed: unknown,
): Record<string, DecisionAnswer> | null {
  if (!record(parsed)) {
    return null;
  }
  if (
    !exactKeys(
      parsed,
      plan.questions.map((question) => question.synthetic),
    )
  ) {
    return null;
  }
  // Object.fromEntries again: a question id may be `__proto__`, which a plain `{}`
  // assignment would drop, silently producing an answer map the host must reject.
  const answers: [string, DecisionAnswer][] = [];
  for (const question of plan.questions) {
    const value = parsed[question.synthetic];
    if (!record(value)) {
      return null;
    }
    const answer =
      question.type === "boolean"
        ? mapBoolean(value)
        : question.type === "choice"
          ? mapChoice(question, value)
          : mapScore(question, value);
    if (!answer) {
      return null;
    }
    answers.push([question.id, answer]);
  }
  return Object.fromEntries(answers);
}
