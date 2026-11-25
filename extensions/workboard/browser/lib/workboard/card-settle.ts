import { t } from "../../i18n/index.ts";
import { isActiveWorkboardCard, nextWorkboardCardPosition } from "./card-state.ts";
import { addWorkboardCardComment, moveWorkboardCard } from "./mutations.ts";
import {
  getWorkboardState,
  workboardMutationsReady,
  type WorkboardClientContext,
} from "./runtime.ts";
import type { WorkboardCard, WorkboardStatus } from "./types.ts";
import { WORKBOARD_DECISION_LABEL } from "./waiting-reason.ts";

/**
 * One owner for the operator's settle writes on the board. The drawer picker and the card
 * face both call these functions, so the comment-then-move mechanics and the label drop
 * exist once instead of drifting between two action paths.
 */

/**
 * A caller that may move a card: the board's client context plus the two facts the move
 * guard reads. `canWrite` is the caller's writability decision (`canMutate` in the pages
 * layer, which owns page authority); it is never re-derived here.
 */
export type WorkboardSettleTarget = WorkboardClientContext & {
  connected: boolean;
  canWrite?: boolean;
};

export type WorkboardSettleMoveOptions = {
  /** Labels dropped in the move's own write, e.g. `decision` once the operator decided. */
  labelsRemove?: readonly string[];
  /**
   * The `updatedAt` the caller rendered. The store refuses the write when the card no longer
   * carries it, so a stale caller cannot overwrite a card that moved on (an undone drag would
   * otherwise pull a running card back to `blocked`).
   */
  expectedUpdatedAt?: number;
};

/**
 * Resolves false when a guard refused the move or the write failed. Only a failed write sets
 * the board error; callers that must not end silently report refusals.
 */
export async function moveWorkboardCardToStatus(
  target: WorkboardSettleTarget,
  card: WorkboardCard,
  status: WorkboardStatus,
  options: WorkboardSettleMoveOptions = {},
): Promise<boolean> {
  const state = getWorkboardState(target.host);
  if (
    !isActiveWorkboardCard(card) ||
    status === card.status ||
    state.busyCardIds.has(card.id) ||
    state.dispatching ||
    target.canWrite === false ||
    !workboardMutationsReady(state) ||
    !target.connected ||
    !target.client
  ) {
    return false;
  }
  return await moveWorkboardCard({
    host: target.host,
    client: target.client,
    requestUpdate: target.requestUpdate,
    cardId: card.id,
    status,
    position: nextWorkboardCardPosition(state.cards, card, status),
    ...(options.labelsRemove ? { labelsRemove: options.labelsRemove } : {}),
    ...(options.expectedUpdatedAt !== undefined
      ? { expectedUpdatedAt: options.expectedUpdatedAt }
      : {}),
  });
}

/**
 * Records the operator's answer on a decision card as a comment. When `made` is set it then
 * moves the card to Ready and drops its decision label in the move's own write, so the card
 * cannot stay a decision card and leaves no window where it is blocked without the label.
 *
 * Resolves true only when the decision was fully recorded. A false keeps the caller's typed
 * text, so the operator can decide again after a refusal.
 */
export async function recordWorkboardDecision(
  target: WorkboardSettleTarget & { cardId: string; decision: string; made: boolean },
): Promise<boolean> {
  const cardId = target.cardId;
  const saved = await addWorkboardCardComment({
    host: target.host,
    client: target.client,
    requestUpdate: target.requestUpdate,
    cardId,
    body: t("workboard.decisionComment", { decision: target.decision }),
  });
  if (!saved) {
    return false;
  }
  // The comment advanced updatedAt; move from the card the Gateway just returned. The move is
  // pinned to that revision, exactly as `sendBack` does, so a change landing between the
  // comment and the move refuses the write instead of overwriting the newer card.
  const state = getWorkboardState(target.host);
  const current = state.cards.find((card) => card.id === cardId);
  if (target.made) {
    const moved =
      current &&
      (await moveWorkboardCardToStatus(target, current, "ready", {
        labelsRemove: [WORKBOARD_DECISION_LABEL],
        expectedUpdatedAt: current.updatedAt,
      }));
    if (!moved) {
      // A failed write already set the board error. A guard refusal (a dispatch started while
      // the comment saved, or a change landing between comment and move) would otherwise leave
      // the card blocked without a word. The comment stands, so the message says so: deciding
      // again records a second one.
      state.error ??= t("workboard.decisionMoveFailed");
      target.requestUpdate?.();
      return false;
    }
  }
  return true;
}

/**
 * Accepts the result a worker reported: `review` -> `done`. `expectedUpdatedAt` is the
 * revision the operator rendered; a card that changed since then refuses the write instead of
 * being overwritten. The store stamps the operator's acceptance itself, because a browser move
 * is the operator's own actor (`null` scope); this helper never writes `acceptanceSeenAt`.
 */
export async function acceptWorkboardCard(
  target: WorkboardSettleTarget,
  card: WorkboardCard,
  options: { expectedUpdatedAt?: number } = {},
): Promise<boolean> {
  return await moveWorkboardCardToStatus(target, card, "done", options);
}

/**
 * Sends a reported result back for rework: writes the reason as a comment, then moves the card
 * `review` -> `ready`. Ready, not Todo (the operator's decision): the same lane picks the card up again
 * with its context intact instead of it landing unassigned in the backlog.
 *
 * The caller's `expectedUpdatedAt` is checked before anything is written, because the reason
 * comment takes no revision guard of its own and it advances `updatedAt`; handing the pre-comment
 * revision to the later move would refuse every send-back. The move is then pinned to the revision
 * the comment returned, so a change landing during the comment still refuses.
 */
export async function sendBackWorkboardCard(
  target: WorkboardSettleTarget,
  card: WorkboardCard,
  options: { reason: string; expectedUpdatedAt?: number },
): Promise<boolean> {
  const live = getWorkboardState(target.host).cards.find((candidate) => candidate.id === card.id);
  if (options.expectedUpdatedAt !== undefined && live?.updatedAt !== options.expectedUpdatedAt) {
    return false;
  }
  const saved = await addWorkboardCardComment({
    host: target.host,
    client: target.client,
    requestUpdate: target.requestUpdate,
    cardId: card.id,
    body: options.reason,
  });
  if (!saved) {
    return false;
  }
  const current = getWorkboardState(target.host).cards.find(
    (candidate) => candidate.id === card.id,
  );
  if (!current) {
    return false;
  }
  return await moveWorkboardCardToStatus(target, current, "ready", {
    expectedUpdatedAt: current.updatedAt,
  });
}
