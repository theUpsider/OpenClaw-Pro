import "../../test/dom.setup.ts";
import { render } from "@solidjs/web";
import { createComponent, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { resolveCardClassification } from "../../lib/workboard/classification.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { CardMeta } from "./view-card-content.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const palette = [
  { name: "bug", color: "red" },
  { name: "research", color: "purple" },
];
const resolveColor = (value: string) => `var(--session-color-${value})`;

function renderMeta(labels: string[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () =>
      createComponent(CardMeta, {
        card: createWorkboardCard({ labels }),
        archived: false,
        classification: resolveCardClassification(labels, palette, resolveColor),
      }),
    container,
  );
  flush();
  const chips = [...container.querySelectorAll<HTMLElement>(".workboard-card__label")];
  return { container, chips, dispose };
}

it("pins the primary classification first and marks colored chips with a dot", () => {
  const { container, chips, dispose } = renderMeta(["frontend", "Research", "bug"]);
  try {
    expect(chips.map((chip) => chip.textContent)).toEqual(["Research", "frontend", "bug"]);
    expect(chips.map((chip) => chip.classList.contains("workboard-card__label--colored"))).toEqual([
      true,
      false,
      true,
    ]);
    expect(chips[0]?.style.getPropertyValue("--workboard-label-color")).toBe(
      "var(--session-color-purple)",
    );
    expect(chips[1]?.getAttribute("style")).toBeNull();
    expect(container.querySelector(".sr-only")?.textContent).toBe("Type: Research");
  } finally {
    dispose();
  }
});

it("renders labels without a palette match exactly as plain chips", () => {
  const { container, chips, dispose } = renderMeta(["alpha", "beta"]);
  try {
    expect(chips.map((chip) => chip.textContent)).toEqual(["alpha", "beta"]);
    expect(chips.map((chip) => chip.className)).toEqual([
      "workboard-chip workboard-truncate workboard-card__label",
      "workboard-chip workboard-truncate workboard-card__label",
    ]);
    expect(chips.map((chip) => chip.childElementCount)).toEqual([0, 0]);
    expect(chips.some((chip) => chip.hasAttribute("style"))).toBe(false);
    expect(container.querySelector(".sr-only")).toBeNull();
  } finally {
    dispose();
  }
});

it("leaves settled labels untouched until their available width changes", () => {
  let resize: ResizeObserverCallback = () => {};
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = render(
    () =>
      createComponent(CardMeta, {
        card: createWorkboardCard({ labels: ["alpha", "beta"] }),
        archived: false,
        classification: resolveCardClassification(["alpha", "beta"], [], () => ""),
      }),
    container,
  );
  flush();
  const labels = container.querySelector<HTMLElement>(".workboard-card__labels")!;
  const chips = [...labels.querySelectorAll<HTMLElement>(".workboard-card__label")];
  const overflow = labels.querySelector<HTMLElement>(".workboard-card__label-overflow")!;
  let width = 100;
  Object.defineProperty(labels, "clientWidth", { get: () => width });
  for (const chip of chips) {
    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue({ width: 60 } as DOMRect);
  }
  vi.spyOn(overflow, "getBoundingClientRect").mockReturnValue({ width: 20 } as DOMRect);
  const mutations = new MutationObserver(() => {});
  mutations.observe(labels, { attributes: true, childList: true, subtree: true });
  const notifyResize = () =>
    resize(
      [
        {
          target: labels,
          contentRect: new DOMRect(0, 0, width, 24),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    );
  try {
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, true]);
    expect(overflow.textContent).toBe("+1");
    mutations.takeRecords();
    notifyResize();
    expect(mutations.takeRecords()).toEqual([]);
    width = 200;
    notifyResize();
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, false]);
    expect(overflow.hidden).toBe(true);
    width = 100;
    notifyResize();
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, true]);
    expect(overflow.title).toBe("beta");
  } finally {
    mutations.disconnect();
    root();
  }
});

it("shows an unseen marker on an automatically finished Done card in the chip style", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = render(
    () =>
      createComponent(CardMeta, {
        card: createWorkboardCard({
          status: "done",
          metadata: { automation: { autoCompletedAt: 2_000 } },
        }),
        archived: false,
        classification: resolveCardClassification([], [], () => ""),
      }),
    container,
  );
  flush();
  const marker = container.querySelector<HTMLElement>(".workboard-card__acceptance");
  expect(marker?.textContent).toBe("New");
  expect(marker?.classList.contains("workboard-card__acceptance--unseen")).toBe(true);
  expect(marker?.title).toBe("Finished automatically and not opened since.");
  root();
  container.remove();
});
