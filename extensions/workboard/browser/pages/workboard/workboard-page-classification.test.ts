import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { mountPage } from "./workboard-page.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("puts the primary classification's accent on the card article and leaves plain cards untouched", async () => {
  // The shared stub resolves every color to "", which would leave every card unclassified.
  workboardTestHost().host.components.resolveAppearanceColor = vi.fn(
    (value: string | null | undefined) => `var(--session-color-${value})`,
  );
  const page = mountPage({ connected: true });
  // The colors come from the card's board palette, delivered with the card list.
  page.boards([
    {
      id: "default",
      total: 2,
      active: 2,
      archived: 0,
      byStatus: {},
      classifications: [
        { name: "bug", color: "red" },
        { name: "research", color: "purple" },
      ],
    },
  ]);
  page.cards([
    createWorkboardCard({
      id: "classified",
      title: "Classified card",
      labels: ["backend", "Research", "bug"],
    }),
    createWorkboardCard({ id: "plain", title: "Plain card", labels: ["alpha", "beta"] }),
  ]);
  page.fixture.notify();
  const [classified, plain] = await afterWorkboardUpdate(() => {
    const cards = [...page.container.querySelectorAll<HTMLElement>(".workboard-card")];
    const byTitle = (title: string) =>
      expectDefined(
        cards.find((card) => card.textContent?.includes(title)),
        `${title} article`,
      );
    return [byTitle("Classified card"), byTitle("Plain card")];
  });

  expect(classified.tagName).toBe("ARTICLE");
  expect(classified.classList.contains("workboard-card--classified")).toBe(true);
  // "Research" is the first stored label with a palette color (research -> purple).
  expect(classified.style.getPropertyValue("--workboard-card-accent")).toBe(
    "var(--session-color-purple)",
  );
  const chips = [...classified.querySelectorAll<HTMLElement>(".workboard-card__label")];
  expect(chips.map((chip) => chip.textContent)).toEqual(["Research", "backend", "bug"]);
  expect(chips[0]?.classList.contains("workboard-card__label--colored")).toBe(true);

  expect(plain.tagName).toBe("ARTICLE");
  expect(plain.classList.contains("workboard-card--classified")).toBe(false);
  expect(plain.hasAttribute("style")).toBe(false);
});

it("renders cards of a board without a palette exactly as plain cards", async () => {
  workboardTestHost().host.components.resolveAppearanceColor = vi.fn(
    (value: string | null | undefined) => `var(--session-color-${value})`,
  );
  const page = mountPage({ connected: true });
  // An unseeded board (no classifications yet): names that used to be example colors stay plain.
  page.boards([{ id: "default", total: 2, active: 2, archived: 0, byStatus: {} }]);
  page.cards([
    createWorkboardCard({ id: "labelled", title: "Labelled card", labels: ["bug", "research"] }),
    createWorkboardCard({ id: "plain", title: "Plain card", labels: ["alpha", "beta"] }),
  ]);
  page.fixture.notify();
  const [labelled, plain] = await afterWorkboardUpdate(() => {
    const cards = [...page.container.querySelectorAll<HTMLElement>(".workboard-card")];
    const byTitle = (title: string) =>
      expectDefined(
        cards.find((card) => card.textContent?.includes(title)),
        `${title} article`,
      );
    return [byTitle("Labelled card"), byTitle("Plain card")];
  });

  expect(labelled.className).toBe(plain.className);
  expect(labelled.hasAttribute("style")).toBe(false);
  expect(labelled.querySelector(".workboard-card__label--colored")).toBeNull();
  expect(
    [...labelled.querySelectorAll<HTMLElement>(".workboard-card__label")].map((chip) => [
      chip.textContent,
      chip.className,
      chip.getAttribute("style"),
    ]),
  ).toEqual([
    ["bug", plain.querySelector(".workboard-card__label")?.className, null],
    ["research", plain.querySelector(".workboard-card__label")?.className, null],
  ]);
});
