import { describe, expect, it } from "vitest";
import { getWorkboardAcceptanceMarker, workboardCardAcceptanceUnseen } from "./acceptance.ts";
import { createWorkboardCard } from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";

function autoCompleted(
  status: WorkboardCard["status"],
  automation: NonNullable<NonNullable<WorkboardCard["metadata"]>["automation"]> = {},
) {
  return createWorkboardCard({
    status,
    metadata: { automation: { autoCompletedAt: 2_000, ...automation } },
  });
}

describe("Workboard acceptance marker", () => {
  it("marks a review card that still awaits acceptance", () => {
    expect(
      getWorkboardAcceptanceMarker(autoCompleted("review", { awaitingAcceptance: true })),
    ).toBe("awaiting");
  });

  it("marks an automatically finished Done card until the operator opens it", () => {
    expect(getWorkboardAcceptanceMarker(autoCompleted("done"))).toBe("unseen");
    expect(getWorkboardAcceptanceMarker(autoCompleted("done", { acceptanceSeenAt: 2_500 }))).toBe(
      undefined,
    );
    // A later automatic completion makes an older "seen" stale again.
    expect(getWorkboardAcceptanceMarker(autoCompleted("done", { acceptanceSeenAt: 1_500 }))).toBe(
      "unseen",
    );
  });

  it("leaves manually finished and active cards unmarked", () => {
    expect(getWorkboardAcceptanceMarker(createWorkboardCard({ status: "done" }))).toBeUndefined();
    expect(getWorkboardAcceptanceMarker(createWorkboardCard({ status: "review" }))).toBeUndefined();
    expect(getWorkboardAcceptanceMarker(autoCompleted("todo"))).toBeUndefined();
    expect(workboardCardAcceptanceUnseen(autoCompleted("todo"))).toBe(false);
  });

  it("counts an unopened review card as unseen so opening it records the visit", () => {
    expect(
      workboardCardAcceptanceUnseen(autoCompleted("review", { awaitingAcceptance: true })),
    ).toBe(true);
  });
});
