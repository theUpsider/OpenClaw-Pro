import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createWorkboardView } from "./view.test-support.ts";

function cardByTitle(container: Element, title: string) {
  return expectDefined(
    [...container.querySelectorAll<HTMLElement>("article.workboard-card")].find((card) =>
      card.querySelector("h3")?.textContent?.includes(title),
    ),
    `${title} article`,
  );
}

describe("needs-you marker", () => {
  it.each(["board", "list"] as const)(
    "shows one marker and stripe beside the classification stripe in %s view",
    (viewMode) => {
      // The shared stub resolves every color to "", which would leave every card unclassified.
      workboardTestHost().host.components.resolveAppearanceColor = vi.fn(
        (value: string | null | undefined) => `var(--session-color-${value})`,
      );
      const { state, container, renderView } = createWorkboardView();
      state.viewMode = viewMode;
      state.boards = [
        {
          id: "default",
          total: 2,
          active: 2,
          archived: 0,
          byStatus: {},
          classifications: [{ name: "bug", color: "red" }],
        },
      ];
      state.cards = [
        // Review and no agent: one marker, though `review` alone is enough.
        createWorkboardCard({
          id: "waiting",
          title: "Waiting card",
          status: "review",
          labels: ["bug", "decision"],
        }),
        // Answered decision: `ready`, assigned, but the stale `decision` label is still on it.
        // The old rule marked this; the narrowed rule must not — the discriminating case.
        createWorkboardCard({
          id: "answered",
          title: "Answered card",
          status: "ready",
          agentId: "b",
          labels: ["decision"],
          position: 3000,
        }),
        createWorkboardCard({
          id: "busy",
          title: "Busy card",
          status: "running",
          agentId: "b",
          labels: ["bug"],
          position: 2000,
        }),
      ];
      renderView();

      const waiting = cardByTitle(container, "Waiting card");
      const markers = waiting.querySelectorAll<HTMLElement>(".workboard-card__needs-you");
      expect(markers).toHaveLength(1);
      expect(markers[0]?.textContent).toBe("Needs you");
      expect(markers[0]?.title).toBe(
        "Waiting for you: a finished review, a blocked card with a decision, or an open card with no agent.",
      );
      expect(waiting.classList.contains("workboard-card--needs-you")).toBe(true);
      expect(waiting.classList.contains("workboard-card--classified")).toBe(true);
      // The marker's color stays out of the palette's inline accent.
      expect(waiting.style.getPropertyValue("--workboard-card-accent")).toBe(
        "var(--session-color-red)",
      );
      expect(waiting.style.getPropertyValue("--workboard-card-attention")).toBe("");

      const busy = cardByTitle(container, "Busy card");
      expect(busy.querySelector(".workboard-card__needs-you")).toBeNull();
      expect(busy.classList.contains("workboard-card--needs-you")).toBe(false);
      expect(busy.classList.contains("workboard-card--classified")).toBe(true);

      // The stale `decision` label on a `ready` card no longer marks: this fails under the old
      // rule, so the wiring test carries the narrowing, not just the tooltip text.
      const answered = cardByTitle(container, "Answered card");
      expect(answered.querySelector(".workboard-card__needs-you")).toBeNull();
      expect(answered.classList.contains("workboard-card--needs-you")).toBe(false);
      expect(answered.style.getPropertyValue("--workboard-card-attention")).toBe("");
    },
  );
});
