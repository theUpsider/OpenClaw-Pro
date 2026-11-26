import type { WorkboardCard } from "@openclaw/workboard-contract";
import {
  DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT,
  MAX_WORKBOARD_OWNER_SLOT_LIMIT,
  WORKBOARD_PARALLELIZABLE_LABEL,
} from "./store-constants.js";

/** Requested opt-in change; `maxConcurrentPerOwner: null` clears the stored ceiling. */
export type WorkboardParallelismChange = {
  parallelizable?: boolean;
  maxConcurrentPerOwner?: number | null;
};

export type WorkboardParallelismPatch = WorkboardParallelismChange & { labels?: string[] };

export function isWorkboardOwnerSlotCeiling(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT &&
    (value as number) <= MAX_WORKBOARD_OWNER_SLOT_LIMIT
  );
}

function isParallelizableLabel(label: string): boolean {
  return label.trim().toLowerCase() === WORKBOARD_PARALLELIZABLE_LABEL;
}

/**
 * Shared by `openclaw workboard update` and `workboard_set_parallelism` so both
 * leave cards in the same shape. `labels`, when present, replaces the card's
 * whole label list, so callers write with `expectedUpdatedAt` from `card`.
 *
 * Turning parallelism off also removes the `parallelizable` label, because the
 * label alone still opts the card in (see workboardCardIsParallelizable).
 */
export function buildWorkboardParallelismPatch(
  card: Pick<WorkboardCard, "labels">,
  change: { parallelizable?: unknown; maxConcurrentPerOwner?: unknown },
): WorkboardParallelismPatch {
  const { parallelizable, maxConcurrentPerOwner } = change;
  if (parallelizable === undefined && maxConcurrentPerOwner === undefined) {
    throw new Error("Set parallelizable, maxConcurrentPerOwner, or both.");
  }
  if (parallelizable !== undefined && typeof parallelizable !== "boolean") {
    throw new Error("parallelizable must be a boolean.");
  }
  if (
    maxConcurrentPerOwner !== undefined &&
    maxConcurrentPerOwner !== null &&
    !isWorkboardOwnerSlotCeiling(maxConcurrentPerOwner)
  ) {
    throw new Error(
      `maxConcurrentPerOwner must be an integer from ${DEFAULT_WORKBOARD_OWNER_SLOT_LIMIT} to ${MAX_WORKBOARD_OWNER_SLOT_LIMIT}, or null to clear it.`,
    );
  }
  const patch: WorkboardParallelismPatch = {};
  if (maxConcurrentPerOwner !== undefined) {
    patch.maxConcurrentPerOwner = maxConcurrentPerOwner;
  }
  if (parallelizable === undefined) {
    return patch;
  }
  patch.parallelizable = parallelizable;
  const marked = card.labels.filter(isParallelizableLabel);
  const labelsCurrent = parallelizable
    ? marked.length === 1 && marked[0] === WORKBOARD_PARALLELIZABLE_LABEL
    : marked.length === 0;
  if (!labelsCurrent) {
    const others = card.labels.filter((label) => !isParallelizableLabel(label));
    patch.labels = parallelizable ? [...others, WORKBOARD_PARALLELIZABLE_LABEL] : others;
  }
  return patch;
}
