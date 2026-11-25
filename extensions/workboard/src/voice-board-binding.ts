import type { WorkboardBoardSummary, WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

/** Page marker the Control UI stamps on a chat turn started from the board surfaces. */
export const VOICE_BOARD_PAGE = "workboard";

export type VoiceBoardBinding = {
  boardId: string;
  boardKind: "cards" | "sessions";
  /** Card whose detail view started the turn. */
  cardId?: string;
};

/**
 * Reads the board that was on screen when the voice turn started. It comes from
 * the run work context the Gateway captured at send time
 * (`toolContext.workContext`, `detail.boardId` + `detail.boardKind`, plus
 * `detail.cardId` from a card detail view); the same snapshot is quoted into
 * the model text. It is reference data, not authority: it may only supply a
 * default board or card id when a tool argument is missing.
 * Malformed or absent input yields undefined.
 */
export function readVoiceBoardBinding(
  ctx: Pick<OpenClawPluginToolContext, "workContext"> | null | undefined,
): VoiceBoardBinding | undefined {
  const workContext = ctx?.workContext;
  if (!workContext || workContext.page !== VOICE_BOARD_PAGE) {
    return undefined;
  }
  const detail = workContext.detail;
  const boardId = detail?.boardId;
  const boardKind = detail?.boardKind;
  if (typeof boardId !== "string" || !boardId.trim()) {
    return undefined;
  }
  if (boardKind !== "cards" && boardKind !== "sessions") {
    return undefined;
  }
  const cardId = typeof detail?.cardId === "string" ? detail.cardId.trim() : "";
  return { boardId: boardId.trim(), boardKind, ...(cardId ? { cardId } : {}) };
}

/** Bound board id when it names an existing board of `kind`; otherwise callers keep today's default. */
export function resolveBoundBoardId(
  binding: VoiceBoardBinding | undefined,
  kind: VoiceBoardBinding["boardKind"],
  boards: readonly Pick<WorkboardBoardSummary, "id" | "kind">[],
): string | undefined {
  if (binding?.boardKind !== kind) {
    return undefined;
  }
  return boards.some((board) => board.id === binding.boardId && (board.kind ?? "cards") === kind)
    ? binding.boardId
    : undefined;
}

/**
 * Bound card id when it names a live card of the bound cards board; otherwise
 * undefined and callers keep requiring an explicit id. A stale or foreign id
 * never selects another card.
 */
export function resolveBoundCardId(
  binding: VoiceBoardBinding | undefined,
  cards: readonly Pick<WorkboardCard, "id" | "metadata">[],
): string | undefined {
  if (binding?.boardKind !== "cards" || !binding.cardId) {
    return undefined;
  }
  const { boardId, cardId } = binding;
  return cards.some(
    (card) =>
      card.id === cardId &&
      !card.metadata?.archivedAt &&
      (card.metadata?.automation?.boardId?.trim() || "default") === boardId,
  )
    ? cardId
    : undefined;
}
