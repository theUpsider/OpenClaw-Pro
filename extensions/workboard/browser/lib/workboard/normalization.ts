import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeEvents,
  normalizeExecution,
  normalizeMetadata,
} from "./metadata-normalization.ts";
import {
  isValidWorkboardBoardId,
  normalizeWorkboardSessionsBoardSpec,
  WORKBOARD_CLASSIFICATION_COLORS,
  WORKBOARD_PRIORITIES,
  WORKBOARD_STATUSES,
  type WorkboardBoardSummary,
  type WorkboardCard,
  type WorkboardCardDraft,
  type WorkboardCardDraftResult,
  type WorkboardClassification,
  type WorkboardClassificationColor,
  type WorkboardPriority,
  type WorkboardStatus,
} from "./types.ts";

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

// Shape check at the response boundary; the Gateway validates names and colors on write.
function normalizeClassifications(value: unknown): WorkboardClassification[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.name === "string" &&
    entry.name.trim() &&
    WORKBOARD_CLASSIFICATION_COLORS.includes(entry.color as WorkboardClassificationColor)
      ? [{ name: entry.name.trim(), color: entry.color as WorkboardClassificationColor }]
      : [],
  );
}

function normalizeBoardSummary(value: unknown): WorkboardBoardSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!isValidWorkboardBoardId(id)) {
    return null;
  }
  const byStatus: Partial<Record<WorkboardStatus, number>> = {};
  if (isRecord(value.byStatus)) {
    for (const status of WORKBOARD_STATUSES) {
      if (value.byStatus[status] !== undefined) {
        byStatus[status] = normalizeCount(value.byStatus[status]);
      }
    }
  }
  const automationJobId =
    typeof value.automationJobId === "string" ? value.automationJobId.trim() : "";
  const classifications = normalizeClassifications(value.classifications);
  return {
    id,
    ...(value.kind === "sessions"
      ? { kind: "sessions" as const, sessions: normalizeWorkboardSessionsBoardSpec(value.sessions) }
      : {}),
    total: normalizeCount(value.total),
    active: normalizeCount(value.active),
    archived: normalizeCount(value.archived),
    byStatus,
    ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: value.description.trim() }
      : {}),
    ...(typeof value.icon === "string" && value.icon.trim() ? { icon: value.icon.trim() } : {}),
    ...(typeof value.color === "string" && value.color.trim() ? { color: value.color.trim() } : {}),
    ...(automationJobId && automationJobId.length <= 128 ? { automationJobId } : {}),
    ...(classifications ? { classifications } : {}),
    ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
  };
}

function normalizeCard(value: unknown): WorkboardCard | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : "";
  const title = typeof value.title === "string" ? value.title : "";
  const status = WORKBOARD_STATUSES.includes(value.status as WorkboardStatus)
    ? (value.status as WorkboardStatus)
    : "todo";
  const priority = WORKBOARD_PRIORITIES.includes(value.priority as WorkboardPriority)
    ? (value.priority as WorkboardPriority)
    : "normal";
  if (!id || !title) {
    return null;
  }
  const execution = normalizeExecution(value.execution);
  const events = normalizeEvents(value.events);
  const metadata = normalizeMetadata(value.metadata);
  return {
    id,
    title,
    status,
    priority,
    labels: Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string")
      : [],
    position: typeof value.position === "number" ? value.position : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.sourceUrl === "string" ? { sourceUrl: value.sourceUrl } : {}),
    ...(execution ? { execution } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "number" ? { completedAt: value.completedAt } : {}),
    ...(events.length ? { events } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function normalizeCardsPayload(payload: unknown): {
  cards: WorkboardCard[];
  boards: WorkboardBoardSummary[];
  statuses: readonly WorkboardStatus[];
} {
  if (!isRecord(payload)) {
    return { cards: [], boards: [], statuses: WORKBOARD_STATUSES };
  }
  const cards = Array.isArray(payload.cards)
    ? payload.cards.map(normalizeCard).filter((card): card is WorkboardCard => card !== null)
    : [];
  const statuses = Array.isArray(payload.statuses)
    ? payload.statuses.filter((status): status is WorkboardStatus =>
        WORKBOARD_STATUSES.includes(status as WorkboardStatus),
      )
    : WORKBOARD_STATUSES;
  const boards = Array.isArray(payload.boards)
    ? payload.boards
        .map(normalizeBoardSummary)
        .filter((board): board is WorkboardBoardSummary => board !== null)
    : [];
  return { cards, boards, statuses: statuses.length ? statuses : WORKBOARD_STATUSES };
}

export function normalizeCardPayload(payload: unknown): WorkboardCard {
  const card = isRecord(payload) ? normalizeCard(payload.card) : null;
  if (!card) {
    throw new Error("workboard response did not include a card");
  }
  return card;
}

function isDraftText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Shape check at the response boundary; `workboard.cards.draft` already limited every value.
export function normalizeCardDraftPayload(payload: unknown): WorkboardCardDraftResult {
  const draft = isRecord(payload) && isRecord(payload.draft) ? payload.draft : {};
  const fields: WorkboardCardDraft = {};
  if (isDraftText(draft.title)) {
    fields.title = draft.title;
  }
  if (isDraftText(draft.notes)) {
    fields.notes = draft.notes;
  }
  if (WORKBOARD_STATUSES.includes(draft.status as WorkboardStatus)) {
    fields.status = draft.status as WorkboardStatus;
  }
  if (WORKBOARD_PRIORITIES.includes(draft.priority as WorkboardPriority)) {
    fields.priority = draft.priority as WorkboardPriority;
  }
  const labels: unknown[] = Array.isArray(draft.labels) ? draft.labels : [];
  if (labels.some(isDraftText)) {
    fields.labels = labels.filter(isDraftText);
  }
  if (isDraftText(draft.agentId)) {
    fields.agentId = draft.agentId;
  }
  const hints: unknown[] = isRecord(payload) && Array.isArray(payload.hints) ? payload.hints : [];
  return { draft: fields, hints: hints.filter(isDraftText) };
}
