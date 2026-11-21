import type { WorkboardCard } from "./types.ts";

/**
 * Acceptance marker for a worker's automatic completion: `awaiting` while it sits in
 * review, `unseen` once it is done but the operator has not opened it since it finished.
 */
export function getWorkboardAcceptanceMarker(
  card: WorkboardCard,
): "awaiting" | "unseen" | undefined {
  const automation = card.metadata?.automation;
  if (card.status === "review" && automation?.awaitingAcceptance) {
    return "awaiting";
  }
  return card.status === "done" && workboardCardAcceptanceUnseen(card) ? "unseen" : undefined;
}

/** An automatically completed review/done card the operator has not opened since it finished. */
export function workboardCardAcceptanceUnseen(card: WorkboardCard): boolean {
  const automation = card.metadata?.automation;
  const finishedAt = automation?.autoCompletedAt;
  return (
    (card.status === "review" || card.status === "done") &&
    finishedAt !== undefined &&
    !(automation?.acceptanceSeenAt !== undefined && automation.acceptanceSeenAt >= finishedAt)
  );
}
