import { workboardOperatorAskKind } from "../../../src/workboard-operator-ask.ts";
import { isActiveWorkboardCard } from "./card-state.ts";
import type { WorkboardCard, WorkboardPriority, WorkboardStatus } from "./types.ts";

/**
 * Why a card waits on the operator, and its lens tier. The tier is the lens' primary sort
 * key, most urgent first: tier 0 is what the operator must answer or decide (`decision`,
 * `input`, `external`), tier 1 is a finished result to accept (`review`), tier 2 is
 * housekeeping (`unowned`, i.e. "no agent").
 *
 * `decision`, `input` and `external` come from the one shared predicate
 * (`workboardOperatorAskKind`), never re-derived here, so the lens and the store agree on
 * what an ask means.
 */
export const WORKBOARD_ATTENTION_REASON_TIERS = {
  decision: 0,
  input: 0,
  external: 0,
  review: 1,
  unowned: 2,
} as const;

export type AttentionReason = keyof typeof WORKBOARD_ATTENTION_REASON_TIERS;

/** Tiers at or below this one are the operator's own steps; above it, housekeeping. */
export const WORKBOARD_ATTENTION_HEADLINE_TIER = 1;

/**
 * Statuses where an open card without an agent is still the operator's to place. A card that
 * left the board (`done`), is scheduled, or is mid-run is not waiting on a person, and `review`
 * already asks on its own. `ready` is included on purpose: the conventions require an agent
 * there, so an unassigned one asks for exactly that.
 */
const UNOWNED_STATUSES: ReadonlySet<WorkboardStatus> = new Set([
  "triage",
  "backlog",
  "todo",
  "ready",
]);

/**
 * Statuses where a card can still be waiting on the operator, so a stored `askKind` is the
 * agent's live question rather than the remains of an earlier one. Excluded are `running`
 * (the agent is working, so a stored ask is stale by definition), `scheduled` (nothing is
 * being asked yet), `review` (a finished result to accept, which is a different step) and
 * `done` (finished).
 *
 * `ready` is excluded too, and that is the whole gate's shape: the store retires `ask`/`askKind`
 * in the same write that settles a card out of `blocked` (`store-status-write.ts`), so a kind
 * left on a `ready` card is a leftover, never a live question -- and a `ready` card is one an
 * agent picks up now, so a face asking the operator there invites a second answer. A live
 * operator question is expressed by leaving the card `blocked`. The remaining statuses need
 * the gate because a lifecycle write (the agent's own completion) skips the manual settle.
 * The `decision` label needs no gate at all: the shared predicate already narrows it to
 * `blocked`.
 */
const ASKING_STATUSES: ReadonlySet<WorkboardStatus> = new Set([
  "triage",
  "backlog",
  "todo",
  "blocked",
]);

/**
 * Why a card waits on the operator, in tier order (most urgent first). A card's first reason
 * is the one its face speaks for; the whole list is kept so a card with several reasons
 * appears once in the lens and never loses one.
 *
 * No reason is stored: all three are derived from facts the card already carries, and each
 * goes quiet on its own as soon as the operator acts. Archived cards never ask for attention,
 * even in review: archiving already took them off the operator's plate.
 */
export function workboardAttentionReasons(card: WorkboardCard): AttentionReason[] {
  if (!isActiveWorkboardCard(card)) {
    return [];
  }
  const reasons: AttentionReason[] = [];
  const ask = workboardOperatorAskKind(card);
  if (
    (ask === "decision" || ask === "input" || ask === "external") &&
    ASKING_STATUSES.has(card.status)
  ) {
    reasons.push(ask);
  }
  if (card.status === "review") {
    reasons.push("review");
  }
  if (!card.agentId?.trim() && UNOWNED_STATUSES.has(card.status)) {
    reasons.push("unowned");
  }
  return reasons;
}

export function needsOperatorAttention(card: WorkboardCard): boolean {
  return workboardAttentionReasons(card).length > 0;
}

/**
 * When the card entered its current status: the latest `moved` event into that status, else
 * `createdAt`. Only status moves carry their target in the event log; `edited` events record
 * no label or agent change, so the onset of a `decision` or `unowned` reason cannot be
 * reconstructed and this deliberately does not pretend to (nor uses `updatedAt`).
 */
export function attentionSinceMs(card: WorkboardCard): number {
  let since: number | undefined;
  for (const event of card.events ?? []) {
    if (
      event.kind === "moved" &&
      event.toStatus === card.status &&
      (since === undefined || event.at > since)
    ) {
      since = event.at;
    }
  }
  return since ?? card.createdAt;
}

const PRIORITY_RANK: Record<WorkboardPriority, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

export type WorkboardInboxEntry = {
  card: WorkboardCard;
  /** Every reason that applies, in tier order; never empty. */
  reasons: AttentionReason[];
  /** `reasons[0]`: the reason the card's face speaks for. */
  reason: AttentionReason;
  /** Lens tier of `reason`; the lens' primary sort key. */
  tier: number;
  since: number;
  rank: number;
};

/**
 * The "Needs you" inbox: cards waiting on the operator in one global order. The reason tier
 * decides first (decide, then accept, then place), then priority, then longest in the current
 * state, then id so equal keys never reshuffle. A card with several reasons appears once, in
 * its most urgent tier, keeping its full reason list. Keys are computed once per card, not
 * inside the comparator.
 */
export function workboardInboxEntries(cards: readonly WorkboardCard[]): WorkboardInboxEntry[] {
  return cards
    .flatMap((card) => {
      const reasons = workboardAttentionReasons(card);
      const reason = reasons[0];
      return reason === undefined
        ? []
        : [
            {
              card,
              reasons,
              reason,
              tier: WORKBOARD_ATTENTION_REASON_TIERS[reason],
              since: attentionSinceMs(card),
              rank: PRIORITY_RANK[card.priority],
            },
          ];
    })
    .toSorted(
      (left, right) =>
        left.tier - right.tier ||
        right.rank - left.rank ||
        left.since - right.since ||
        (left.card.id < right.card.id ? -1 : left.card.id > right.card.id ? 1 : 0),
    );
}

export function isWorkboardInboxUnownedEntry(entry: WorkboardInboxEntry): boolean {
  return entry.tier > WORKBOARD_ATTENTION_HEADLINE_TIER;
}

export type WorkboardInboxPartition = {
  /** The operator's own steps (decide / review), each drawn with its own face. */
  headline: WorkboardInboxEntry[];
  /** Open cards no agent owns: one collapsed summary row, never a face. */
  unowned: WorkboardInboxEntry[];
};

/**
 * Splits the ordered entries so the lens can draw the operator's steps in full and the "no
 * agent" rest as one collapsed count row. Both groups keep the entry order; every entry stays
 * whole, with its full reason list.
 */
export function partitionWorkboardInboxEntries(
  entries: readonly WorkboardInboxEntry[],
): WorkboardInboxPartition {
  const headline: WorkboardInboxEntry[] = [];
  const unowned: WorkboardInboxEntry[] = [];
  for (const entry of entries) {
    (isWorkboardInboxUnownedEntry(entry) ? unowned : headline).push(entry);
  }
  return { headline, unowned };
}
