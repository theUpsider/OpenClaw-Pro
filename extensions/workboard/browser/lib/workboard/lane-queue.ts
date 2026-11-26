import {
  collectWorkboardOwnerSlotUsage,
  compareWorkboardReadyCards,
  workboardCardConsumesOwnerSlot,
  workboardCardSlotOwner,
  workboardOwnerSlotAdmitsCard,
  workboardOwnerSlotLimit,
} from "../../../src/store-constants.ts";
import type { WorkboardCard, WorkboardStatus } from "./types.ts";

/** How many cards ahead in the lane the UI names; the position still counts all of them. */
const MAX_LANE_QUEUE_AHEAD = 3;

// The dispatcher starts Ready cards first; earlier statuses wait behind them.
const QUEUED_STATUS_RANK: Partial<Record<WorkboardStatus, number>> = {
  ready: 0,
  scheduled: 1,
  todo: 2,
  backlog: 3,
};

type WorkboardLaneCardRef = { id: string; title: string };

export type WorkboardLaneQueue = {
  ownerId: string;
  holder: WorkboardLaneCardRef;
  /** 1-based place of this card among the owner's waiting cards. */
  position: number;
  total: number;
  ahead: WorkboardLaneCardRef[];
};

function laneCardRef(card: WorkboardCard): WorkboardLaneCardRef {
  return { id: card.id, title: card.title };
}

function isQueuedForOwner(card: WorkboardCard, ownerId: string, now: number): boolean {
  return (
    !card.metadata?.archivedAt &&
    QUEUED_STATUS_RANK[card.status] !== undefined &&
    !workboardCardConsumesOwnerSlot(card, now) &&
    workboardCardSlotOwner(card, now) === ownerId
  );
}

/**
 * Owner-slot facts for one waiting card, derived from the loaded card list with the
 * server's own slot rules. Undefined while the card's owner slot would admit it.
 */
export function getWorkboardLaneQueue(
  card: WorkboardCard,
  cards: readonly WorkboardCard[],
  now = Date.now(),
): WorkboardLaneQueue | undefined {
  const ownerId = workboardCardSlotOwner(card, now);
  if (!isQueuedForOwner(card, ownerId, now)) {
    return undefined;
  }
  const usage = collectWorkboardOwnerSlotUsage(cards, now, workboardOwnerSlotLimit);
  if (workboardOwnerSlotAdmitsCard(usage, ownerId, workboardOwnerSlotLimit(card))) {
    return undefined;
  }
  // Occupied slots keep their claim owner through the reclaim grace, so omit now here.
  const holder = cards.find(
    (candidate) =>
      workboardCardConsumesOwnerSlot(candidate, now) &&
      workboardCardSlotOwner(candidate) === ownerId,
  );
  if (!holder) {
    return undefined;
  }
  const queue = cards
    .filter((candidate) => isQueuedForOwner(candidate, ownerId, now))
    .toSorted(
      (a, b) =>
        (QUEUED_STATUS_RANK[a.status] ?? 0) - (QUEUED_STATUS_RANK[b.status] ?? 0) ||
        compareWorkboardReadyCards(a, b),
    );
  const index = queue.findIndex((candidate) => candidate.id === card.id);
  return {
    ownerId,
    holder: laneCardRef(holder),
    position: index + 1,
    total: queue.length,
    ahead: queue.slice(0, Math.min(index, MAX_LANE_QUEUE_AHEAD)).map(laneCardRef),
  };
}
