import type {
  WorkboardCard,
  WorkboardClaim,
  WorkboardExecution,
  WorkboardMetadata,
} from "@openclaw/workboard-contract";
import {
  isFutureDateTimestampMs,
  MAX_DATE_TIMESTAMP_MS,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";

export const POSITION_STEP = 1000;
export const MAX_CARDS = 2000;
export const MAX_CARD_EVENTS = 50;
export const MAX_CARD_ATTEMPTS = 30;
export const MAX_CARD_COMMENTS = 50;
export const MAX_CARD_LINKS = 50;
export const MAX_CARD_PROOF = 40;
export const MAX_CARD_ARTIFACTS = 40;
export const MAX_CARD_ATTACHMENTS = 20;
export const MAX_CARD_WORKER_LOGS = 40;
export const MAX_WORKER_CONTEXT_PARENTS = 6;
export const MAX_WORKER_CONTEXT_RECENT_CARDS = 5;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_CARD_DIAGNOSTICS = 12;
export const MAX_CARD_NOTIFICATIONS = 20;
export const MAX_RUN_ID_LENGTH = 512;
/** Stored ceiling for a card's free-text summary (completion, spec, or decompose prose). */
export const WORKBOARD_SUMMARY_MAX_LENGTH = 2000;
export const MAX_CARD_METADATA_BYTES = 24 * 1024;
export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_WORKBOARD_DISPATCH_OWNER = "workboard-dispatcher";
/** Backwards-compatible owner slot ceiling: one active card per owner. */
export const DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT = 1;
/** Guardrail for `maxConcurrentPerOwner`; keeps a bad card from unbounded fan-out. */
export const MAX_WORKBOARD_OWNER_SLOT_LIMIT = 16;
/** Label that opts a card into running beside other cards of the same owner. */
export const WORKBOARD_PARALLELIZABLE_LABEL = "parallelizable";
/**
 * Labels Workboard writes for its own behavior. They never take a classification
 * slot and cannot be registered as classifications.
 */
export const WORKBOARD_SYSTEM_LABELS: readonly string[] = [WORKBOARD_PARALLELIZABLE_LABEL];
export const MAX_WORKBOARD_CLASSIFICATIONS = 10;
export const READY_STRANDED_MS = 60 * 60 * 1000;
export const RUNNING_HEARTBEAT_STALE_MS = 20 * 60 * 1000;
export const BLOCKED_TOO_LONG_MS = 24 * 60 * 60 * 1000;
const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

export function isWorkboardClaimReclaimable(
  claim: WorkboardClaim | undefined,
  now: number,
): boolean {
  return Boolean(claim?.expiresAt && now - claim.expiresAt > CLAIM_RECLAIM_MS);
}

type WorkboardOwnerSlotCard = Pick<WorkboardCard, "status" | "agentId"> & {
  execution?: Pick<WorkboardExecution, "status">;
  metadata?: Pick<WorkboardMetadata, "claim" | "archivedAt">;
};

/** Owner-capacity facts: the opt-in marker and the declared concurrency ceiling. */
export type WorkboardOwnerConcurrencyCard = Pick<WorkboardCard, "labels"> & {
  metadata?: Pick<WorkboardMetadata, "automation">;
};

/** Owner slot usage: how many cards hold the slot and the tightest declared ceiling. */
export type WorkboardOwnerSlotUsage = { count: number; limit: number };

export function workboardCardConsumesOwnerSlot(card: WorkboardOwnerSlotCard, now: number): boolean {
  const claim = card.metadata?.claim;
  const activeClaim = claim && isFutureDateTimestampMs(claim.expiresAt, { nowMs: now });
  return (
    !card.metadata?.archivedAt &&
    !isWorkboardClaimReclaimable(claim, now) &&
    (card.status === "running" ||
      (card.status !== "done" && activeClaim) ||
      card.execution?.status === "running")
  );
}

export function workboardCardSlotOwner(card: WorkboardOwnerSlotCard, now?: number): string {
  const claim = card.metadata?.claim;
  // Ready candidates pass now to ignore expired claims. Occupied slots omit it
  // so the claim owner keeps its slot through the heartbeat-reclaim grace period.
  return (
    (claim && (now === undefined || isFutureDateTimestampMs(claim.expiresAt, { nowMs: now }))
      ? claim.ownerId
      : undefined) ||
    card.agentId ||
    DEFAULT_WORKBOARD_DISPATCH_OWNER
  );
}

/**
 * A card whose placement and transport belong to an external controller. The local
 * dispatcher never claims or starts these cards; dependency promotion, claim
 * cleanup, and the manual claim/heartbeat/complete flow still work for them.
 * Absent metadata means `native`, so every existing card is unchanged.
 */
export function workboardCardIsExternallyDispatched(
  card: Pick<WorkboardCard, "metadata">,
): boolean {
  return card.metadata?.automation?.dispatchMode === "external";
}

/**
 * A card opts into parallel dispatch by carrying the `parallelizable` label or the
 * matching automation flag. Everything else keeps the historical single slot.
 */
export function workboardCardIsParallelizable(card: WorkboardOwnerConcurrencyCard): boolean {
  if (card.metadata?.automation?.parallelizable === true) {
    return true;
  }
  return card.labels.some((label) => label.trim().toLowerCase() === WORKBOARD_PARALLELIZABLE_LABEL);
}

/**
 * Effective owner slot ceiling for one card. Unmarked cards return 1, so their
 * behaviour is unchanged; opt-in cards may raise it up to the guardrail.
 */
export function workboardOwnerSlotLimit(card: WorkboardOwnerConcurrencyCard): number {
  if (!workboardCardIsParallelizable(card)) {
    return DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT;
  }
  const requested = card.metadata?.automation?.maxConcurrentPerOwner;
  const resolved =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.trunc(requested)
      : DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT;
  return Math.min(
    MAX_WORKBOARD_OWNER_SLOT_LIMIT,
    Math.max(DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT, resolved),
  );
}

/**
 * Record one active card against its owner. The owner ceiling is the tightest
 * limit among its participating cards, so a non-opt-in card (limit 1) never
 * shares the slot with anything.
 */
export function addWorkboardOwnerSlot(
  usage: Map<string, WorkboardOwnerSlotUsage>,
  owner: string,
  limit: number,
): void {
  const current = usage.get(owner);
  if (current) {
    current.count += 1;
    current.limit = Math.min(current.limit, limit);
    return;
  }
  usage.set(owner, { count: 1, limit });
}

/**
 * Shared admission check for both dispatcher selection and the atomic DB claim
 * gate: a card may start while the owner stays below the tightest ceiling.
 */
export function workboardOwnerSlotAdmitsCard(
  usage: Map<string, WorkboardOwnerSlotUsage>,
  owner: string,
  cardLimit: number,
): boolean {
  const current = usage.get(owner);
  if (!current) {
    return true;
  }
  return current.count < Math.min(current.limit, cardLimit);
}

/**
 * Snapshot of how many active cards each owner already holds, with the tightest
 * ceiling declared by the participating cards. Both the dispatcher selection and
 * the start loop seed from this one snapshot so neither can admit more than the
 * atomic claim gate would.
 */
export function collectWorkboardOwnerSlotUsage<Card extends WorkboardOwnerSlotCard>(
  cards: readonly Card[],
  now: number,
  limitOf: (card: Card) => number,
): Map<string, WorkboardOwnerSlotUsage> {
  const usage = new Map<string, WorkboardOwnerSlotUsage>();
  for (const card of cards) {
    if (!workboardCardConsumesOwnerSlot(card, now)) {
      continue;
    }
    addWorkboardOwnerSlot(usage, workboardCardSlotOwner(card), limitOf(card));
  }
  return usage;
}

const WORKBOARD_PRIORITY_RANK: Record<WorkboardCard["priority"], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** Dispatch order for cards waiting on an owner slot; the Control UI lane queue shares it. */
export function compareWorkboardReadyCards(
  a: Pick<WorkboardCard, "priority" | "position" | "createdAt">,
  b: Pick<WorkboardCard, "priority" | "position" | "createdAt">,
): number {
  return (
    WORKBOARD_PRIORITY_RANK[a.priority] - WORKBOARD_PRIORITY_RANK[b.priority] ||
    a.position - b.position ||
    a.createdAt - b.createdAt
  );
}

/** Deep copy, so a caller cannot mutate the shared running-owner snapshot. */
export function cloneWorkboardOwnerSlotUsage(
  usage: ReadonlyMap<string, WorkboardOwnerSlotUsage>,
): Map<string, WorkboardOwnerSlotUsage> {
  return new Map([...usage].map(([owner, entry]) => [owner, { ...entry }]));
}

export function secondsToDurationMs(seconds: number): number {
  const ms = Math.trunc(seconds) * 1000;
  return Number.isFinite(ms)
    ? Math.min(MAX_DATE_TIMESTAMP_MS, Math.max(1, ms))
    : MAX_DATE_TIMESTAMP_MS;
}

export function addWorkboardDurationMs(now: number, durationMs: number): number {
  return resolveExpiresAtMsFromDurationMs(durationMs, { nowMs: now }) ?? MAX_DATE_TIMESTAMP_MS;
}
