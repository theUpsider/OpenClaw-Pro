import {
  WORKBOARD_PRIORITIES,
  WORKBOARD_STATUSES,
  type WorkboardCardDraft,
  type WorkboardCardDraftResult,
  type WorkboardClassification,
} from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";

export const MAX_CARD_DRAFT_VOICE_TEXT_LENGTH = 2000;
const MAX_TITLE_LENGTH = 180;
const MAX_NOTES_LENGTH = 4000;
// Echoed model values in hints stay short; the hint names the value, it does not quote an essay.
const MAX_HINT_VALUE_LENGTH = 60;
const MAX_ANSWER_LABELS = 20;
// A draft is a title plus a few fields; this caps a runaway answer, not a normal one.
const CARD_DRAFT_MAX_TOKENS = 1200;

export type WorkboardCardDraftAgent = { id: string; name?: string };

export type WorkboardCardDraftRequest = { voiceText: string; boardId: string };

export function readCardDraftRequest(params: Record<string, unknown>): WorkboardCardDraftRequest {
  const unknownField = Object.keys(params).find((key) => key !== "voiceText" && key !== "boardId");
  if (unknownField) {
    throw new Error(`Unknown card draft field: ${unknownField}.`);
  }
  const voiceText = typeof params.voiceText === "string" ? params.voiceText.trim() : "";
  if (!voiceText) {
    throw new Error("voiceText is required.");
  }
  if (voiceText.length > MAX_CARD_DRAFT_VOICE_TEXT_LENGTH) {
    throw new Error(`voiceText must be ${MAX_CARD_DRAFT_VOICE_TEXT_LENGTH} characters or fewer.`);
  }
  const boardId = params.boardId;
  if (boardId !== undefined && typeof boardId !== "string") {
    throw new Error("boardId must be a string.");
  }
  return { voiceText, boardId: boardId?.trim() || "default" };
}

function buildCardDraftSystemPrompt(params: {
  palette: readonly WorkboardClassification[];
  agents: readonly WorkboardCardDraftAgent[];
}): string {
  const labels = params.palette.length
    ? params.palette.map((entry) => entry.name).join(", ")
    : "(none — this board has no labels yet)";
  const agents = params.agents.length
    ? params.agents
        .map((agent) => (agent.name ? `${agent.id} (${agent.name})` : agent.id))
        .join(", ")
    : "(none)";
  return [
    "You turn one spoken sentence into a draft for a new Workboard card.",
    "Reply with exactly one JSON object and nothing else: no prose, no code fence.",
    "Include a key only when the sentence clearly states it. Never guess, never fill defaults.",
    "Keys (all optional):",
    `- "title": short summary of the task, at most ${MAX_TITLE_LENGTH} characters.`,
    '- "notes": details the speaker gave beyond the title.',
    `- "status": one of ${WORKBOARD_STATUSES.join(", ")}.`,
    `- "priority": one of ${WORKBOARD_PRIORITIES.join(", ")}.`,
    `- "labels": array of label names the speaker asked for. This board's labels: ${labels}. If the speaker names a label that is not listed, include it as said.`,
    `- "agent": id of the agent the speaker wants to assign. Assignable agents: ${agents}.`,
    "You only describe the draft; nothing is created or saved.",
  ].join("\n");
}

function hintValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_HINT_VALUE_LENGTH
    ? `${trimmed.slice(0, MAX_HINT_VALUE_LENGTH - 1)}…`
    : trimmed;
}

/** Parses the completion; anything but one JSON object is an error, never a partial draft. */
function parseAnswerObject(text: string): Record<string, unknown> {
  // Reasoning models can leak their trace before a closing tag; only the answer after it counts.
  const thinkEnd = text.lastIndexOf("</think>");
  let answer = (thinkEnd >= 0 ? text.slice(thinkEnd + "</think>".length) : text).trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(answer);
  if (fenced) {
    answer = fenced[1] ?? "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new Error("The model's draft answer was not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("The model's draft answer was not a JSON object.");
  }
  return parsed;
}

function readAnswerString(answer: Record<string, unknown>, key: string): string | undefined {
  const value = answer[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`The model's draft answer gave "${key}" as something other than text.`);
  }
  return value.trim() || undefined;
}

function readAnswerLabels(answer: Record<string, unknown>): string[] {
  const value = answer.labels;
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((label) => typeof label !== "string")) {
    throw new Error(
      'The model\'s draft answer gave "labels" as something other than a list of names.',
    );
  }
  return value
    .slice(0, MAX_ANSWER_LABELS)
    .map((label: string) => label.trim())
    .filter(Boolean);
}

function pickListValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  const key = value?.toLowerCase();
  return allowed.find((entry) => entry === key);
}

function shorten(value: string, max: number, field: string, hints: string[]): string {
  if (value.length <= max) {
    return value;
  }
  hints.push(`${field} shortened to ${max} characters.`);
  return value.slice(0, max).trimEnd();
}

/**
 * Normalizes the model answer field by field against the board's own vocabulary:
 * labels only from the palette (in palette spelling), status/priority only from the
 * fixed lists, agent only from the server's roster. Dropped values become hints.
 */
export function normalizeCardDraftAnswer(
  text: string,
  context: {
    palette: readonly WorkboardClassification[];
    agents: readonly WorkboardCardDraftAgent[];
  },
): WorkboardCardDraftResult {
  const answer = parseAnswerObject(text);
  const title = readAnswerString(answer, "title");
  const notes = readAnswerString(answer, "notes");
  const status = readAnswerString(answer, "status");
  const priority = readAnswerString(answer, "priority");
  const agent = readAnswerString(answer, "agent");
  const spokenLabels = readAnswerLabels(answer);

  const draft: WorkboardCardDraft = {};
  const hints: string[] = [];
  if (title) {
    draft.title = shorten(title, MAX_TITLE_LENGTH, "Title", hints);
  }
  if (notes) {
    draft.notes = shorten(notes, MAX_NOTES_LENGTH, "Notes", hints);
  }
  if (status) {
    const value = pickListValue(status, WORKBOARD_STATUSES);
    if (value) {
      draft.status = value;
    } else {
      hints.push(`Status "${hintValue(status)}" is not a Workboard status; left out.`);
    }
  }
  if (priority) {
    const value = pickListValue(priority, WORKBOARD_PRIORITIES);
    if (value) {
      draft.priority = value;
    } else {
      hints.push(`Priority "${hintValue(priority)}" is not a Workboard priority; left out.`);
    }
  }
  if (spokenLabels.length && !context.palette.length) {
    hints.push(
      `This board has no labels yet, so no labels were set (heard: ${spokenLabels.map(hintValue).join(", ")}).`,
    );
  } else if (spokenLabels.length) {
    const byKey = new Map(context.palette.map((entry) => [entry.name.toLowerCase(), entry.name]));
    const labels = new Set<string>();
    for (const label of spokenLabels) {
      const name = byKey.get(label.toLowerCase());
      if (name) {
        labels.add(name);
      } else {
        hints.push(`Label "${hintValue(label)}" is not one of this board's labels; left out.`);
      }
    }
    if (labels.size) {
      draft.labels = [...labels];
    }
  }
  if (agent) {
    const key = agent.toLowerCase();
    const match = context.agents.find(
      (entry) => entry.id.toLowerCase() === key || entry.name?.toLowerCase() === key,
    );
    if (match) {
      draft.agentId = match.id;
    } else {
      hints.push(`Agent "${hintValue(agent)}" is not an assignable agent; left out.`);
    }
  }
  return { draft, hints };
}

/**
 * Drafts New card form fields from one utterance. Read-only: the caller supplies the
 * palette and roster it read; this only runs the completion and normalizes its answer.
 */
export async function draftWorkboardCard(params: {
  llm: OpenClawPluginApi["runtime"]["llm"];
  voiceText: string;
  palette: readonly WorkboardClassification[];
  agents: readonly WorkboardCardDraftAgent[];
  signal?: AbortSignal;
}): Promise<WorkboardCardDraftResult> {
  const result = await params.llm.complete({
    systemPrompt: buildCardDraftSystemPrompt(params),
    messages: [{ role: "user", content: params.voiceText }],
    purpose: "workboard.cards.draft",
    maxTokens: CARD_DRAFT_MAX_TOKENS,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return normalizeCardDraftAnswer(result.text, params);
}
