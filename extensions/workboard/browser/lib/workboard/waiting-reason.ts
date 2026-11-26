import { getWorkboardDependencyState } from "./card-state.ts";
import { getWorkboardLaneQueue, type WorkboardLaneQueue } from "./lane-queue.ts";
import type { WorkboardCard, WorkboardLifecycle } from "./types.ts";

/** Label the board uses for blocked cards that wait on the operator, not on other work. */
export const WORKBOARD_DECISION_LABEL = "decision";

export type WorkboardWaitingReason =
  | { kind: "decision" }
  | { kind: "blocked"; detail?: string; parents: string[] }
  | { kind: "restart"; sessionKey: string }
  | { kind: "parents"; parents: string[] }
  | { kind: "stale"; detail: string }
  | { kind: "lane"; agentId: string }
  | { kind: "queued"; queue: WorkboardLaneQueue }
  | { kind: "dispatcher" }
  | { kind: "review"; automatic?: true }
  | { kind: "notReleased" }
  | { kind: "notSpecified" }
  | { kind: "scheduled"; at?: number };

export function isWorkboardDecisionCard(card: WorkboardCard): boolean {
  return (
    card.status === "blocked" &&
    card.labels.some((label) => label.trim().toLowerCase() === WORKBOARD_DECISION_LABEL)
  );
}

/** Unchecked Markdown task items (`- [ ] option`) in the notes are the decision's choices. */
export function getWorkboardDecisionOptions(card: WorkboardCard): string[] {
  return (card.notes ?? "")
    .split("\n")
    .map((line) => /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter((option): option is string => Boolean(option));
}

/**
 * One short answer to "why is nobody working on this card?", derived only from facts
 * the card and board already carry. Cards that are running or finished have none.
 */
export function getWorkboardWaitingReason(
  card: WorkboardCard,
  cards: readonly WorkboardCard[],
  lifecycle?: WorkboardLifecycle["state"],
  now = Date.now(),
): WorkboardWaitingReason | undefined {
  if (card.status === "done") {
    return undefined;
  }
  if (isWorkboardDecisionCard(card)) {
    return { kind: "decision" };
  }
  const parents = getWorkboardDependencyState(card, cards)
    .blockedParents.filter((parent) => !parent.missing)
    .map((parent) => parent.title);
  if (card.status === "blocked") {
    const tombstone = card.metadata?.automation?.restartTombstone;
    if (tombstone) {
      return { kind: "restart", sessionKey: tombstone.sessionKey };
    }
    const protocol = card.metadata?.workerProtocol;
    const detail = protocol?.state === "blocked" ? protocol.detail?.trim() : undefined;
    return { kind: "blocked", parents, ...(detail ? { detail } : {}) };
  }
  if (parents.length) {
    return { kind: "parents", parents };
  }
  switch (card.status) {
    case "running": {
      const stale = card.metadata?.stale?.reason.trim();
      return stale ? { kind: "stale", detail: stale } : undefined;
    }
    case "ready": {
      // A live or queued session means the card already left the lane queue.
      if (lifecycle === "running" || lifecycle === "queued") {
        return undefined;
      }
      const queue = getWorkboardLaneQueue(card, cards, now);
      if (queue) {
        return { kind: "queued", queue };
      }
      const agentId = card.agentId?.trim();
      return agentId ? { kind: "lane", agentId } : { kind: "dispatcher" };
    }
    case "review":
      return card.metadata?.automation?.awaitingAcceptance
        ? { kind: "review", automatic: true }
        : { kind: "review" };
    case "todo":
      return { kind: "notReleased" };
    case "backlog":
    case "triage":
      return { kind: "notSpecified" };
    case "scheduled": {
      const at = card.metadata?.automation?.scheduledAt;
      return typeof at === "number" ? { kind: "scheduled", at } : { kind: "scheduled" };
    }
  }
  return undefined;
}
