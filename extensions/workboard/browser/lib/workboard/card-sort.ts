import type { WorkboardCard, WorkboardUiState } from "./types.ts";

export type WorkboardCardSort = WorkboardUiState["sort"];

/**
 * Display-only ordering for board columns. `position` keeps the server order
 * (status, position, createdAt), which also drives dispatch, so callers get the
 * input order back. Time sorts put the newest first; the stable sort keeps the
 * server order for equal timestamps.
 */
export function sortWorkboardCards(
  cards: readonly WorkboardCard[],
  sort: WorkboardCardSort,
): readonly WorkboardCard[] {
  if (sort === "position") {
    return cards;
  }
  const key = sort === "created" ? "createdAt" : "updatedAt";
  return cards.toSorted((left, right) => right[key] - left[key]);
}
