import "../../test/dom.setup.ts";
import { expect, it } from "vitest";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { dispatchSummaryMessage, matchesCardQuery } from "./view-helpers.tsx";

it("matches card ID prefixes case-insensitively", () => {
  const card = createWorkboardCard({ id: "123e4567-e89b-12d3-a456-426614174000" });
  const query = " 123E4567-E89B ";

  expect(matchesCardQuery(card, query)).toBe(true);
});

it("counts cards left queued behind a busy lane in the dispatch summary", () => {
  const state = getWorkboardState({});
  const counts = { failures: 0, promoted: 0, blocked: 0, reclaimed: 0, orchestrated: 0 };
  state.lastDispatchSummary = { ...counts, started: 1, queued: 2 };
  expect(dispatchSummaryMessage(state)).toBe(
    "Started 1. Prepared 0, blocked 0, released 0, organized 0. Failed to start: 0. Queued behind a busy lane: 2.",
  );
  state.lastDispatchSummary = { ...counts, started: 0, queued: 1 };
  expect(dispatchSummaryMessage(state)).toBe(
    "Started 0. Prepared 0, blocked 0, released 0, organized 0. Failed to start: 0. Queued behind a busy lane: 1.",
  );
  state.lastDispatchSummary = { ...counts, started: 0, queued: 0 };
  expect(dispatchSummaryMessage(state)).toBe("No cards were started.");
});
