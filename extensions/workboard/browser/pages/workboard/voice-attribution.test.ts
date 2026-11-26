import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkboardEvent } from "../../lib/workboard/index.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { openCardDetails } from "./view-card-details.tsx";
import { mountPage } from "./workboard-page.test-support.ts";

// Test names map to docs/ui/screen-state-matrix.md; the matrix cites the German titles.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const movedAt = Date.UTC(2026, 10, 2, 21, 54);

async function activityRows(events: WorkboardEvent[]) {
  const page = mountPage({ connected: true });
  page.agents([{ id: "main", name: "D" }]);
  // Gateway payloads pass the browser's card normalization like a live list.
  page.cards([createWorkboardCard({ id: "login", title: "Login bug", events })]);
  await afterWorkboardUpdate(() => expect(page.workboard.state.cards).toHaveLength(1));
  page.fixture.host.agents.refresh();
  openCardDetails(page.workboard.state, page.workboard.state.cards[0]!);
  page.fixture.notify();
  return afterWorkboardUpdate(() => [
    ...document.querySelectorAll<HTMLLIElement>(".workboard-detail__events li"),
  ]);
}

// »Event mit Agent«
it("shows the agent and the time of a card event the agent caused", async () => {
  const [row] = await activityRows([
    { id: "event-1", kind: "moved", at: movedAt, toStatus: "review", agentId: "main" },
  ]);
  const item = expectDefined(row, "event row");

  expect(item.querySelector("span")?.textContent).toBe("Moved to Review by D");
  expect(item.querySelector("time")?.textContent).toBeTruthy();
});

// »Event ohne Agent«
it("shows only text and time for events without a recorded agent", async () => {
  const rows = await activityRows([
    { id: "event-1", kind: "edited", at: movedAt },
    { id: "event-2", kind: "moved", at: movedAt + 1, toStatus: "done", agentId: "retired" },
  ]);

  // Newest first, as the Activity tab lists them.
  expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual([
    // An agent missing from the agent list keeps its id instead of a guessed name.
    "Moved to Done by retired",
    "Edited",
  ]);
  expect(rows[1]?.querySelector(".workboard-detail__event-agent")).toBeNull();
  expect(rows.every((row) => row.querySelector("time")?.textContent)).toBe(true);
});
