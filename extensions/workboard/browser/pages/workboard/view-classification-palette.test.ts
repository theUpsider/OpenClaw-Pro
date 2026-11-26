import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { WorkboardBoardSummary, WorkboardCard } from "../../lib/workboard/index.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import type { WorkboardInlineText } from "./view-inline-properties.tsx";
import { createWorkboardView, inlineEditor, textButton } from "./view.test-support.ts";

const COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;

function board(names: readonly string[]): WorkboardBoardSummary {
  return {
    id: "default",
    total: 0,
    active: 0,
    archived: 0,
    byStatus: {},
    classifications: names.map((name, index) => ({ name, color: COLORS[index % COLORS.length]! })),
  };
}

const FULL = ["bug", "feature", "docs", "chore", "research", "ops", "design", "test", "ux", "perf"];

async function openPalette(params: {
  card: WorkboardCard;
  board?: WorkboardBoardSummary;
  others?: WorkboardCard[];
  respond?: (method: string, params: unknown) => unknown;
}) {
  const resolveColor = workboardTestHost().host.components;
  const previousResolve = resolveColor.resolveAppearanceColor;
  resolveColor.resolveAppearanceColor = vi.fn((value) => `var(--session-color-${value})`);
  onTestFinished(() => {
    resolveColor.resolveAppearanceColor = previousResolve;
  });
  const client = createWorkboardTestClient(
    params.respond ??
      ((method, request) =>
        method === "workboard.cards.update"
          ? {
              card: {
                ...params.card,
                labels: (request as { patch: { labels: string[] } }).patch.labels,
                updatedAt: params.card.updatedAt + 1,
              },
            }
          : {}),
  );
  const { state, container, renderView } = createWorkboardView({
    client,
    onRequestUpdate: () => renderView(),
  });
  state.cards = [params.card, ...(params.others ?? [])];
  state.boards = params.board ? [params.board] : [];
  state.detailCardId = params.card.id;
  renderView();
  const editor = await inlineEditor(container, "labels");
  const input = await editor.open();
  const popover = expectDefined(editor.popover, "labels popover");
  const palette = expectDefined(
    popover.querySelector<HTMLElement>(".workboard-palette"),
    ".workboard-palette",
  );
  const slot = (name: string) =>
    expectDefined(
      [...popover.querySelectorAll<HTMLElement>(".workboard-palette__slot")].find(
        (element) => element.textContent === name,
      ),
      `slot ${name}`,
    );
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  };
  const create = async () => {
    const button = textButton(popover, "Create");
    await waitForFast(() => expect(button.disabled).toBe(false));
    button.click();
  };
  return {
    state,
    client,
    editor,
    popover,
    palette,
    input,
    slot,
    type,
    create,
    rerender: renderView,
  };
}

describe("label editor classification palette", () => {
  it("toggles a used slot in the draft and saves the result through the card update", async () => {
    const card = createWorkboardCard({ labels: ["bug"] });
    const view = await openPalette({ card, board: board(["bug", "research"]) });

    expect(view.palette.querySelector(".workboard-palette__count")?.textContent).toBe(
      "2 / 10 used",
    );
    expect(view.slot("bug").getAttribute("aria-pressed")).toBe("true");
    expect(view.slot("bug").style.getPropertyValue("--palette-slot-color")).toBe(
      "var(--session-color-red)",
    );
    expect(view.slot("research").getAttribute("aria-pressed")).toBe("false");

    view.slot("research").click();
    view.slot("bug").click();
    await waitForFast(() =>
      expect(view.slot("research").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(view.slot("bug").getAttribute("aria-pressed")).toBe("false");
    // Slots edit the draft only; nothing is written before Save.
    expect(view.client.request).not.toHaveBeenCalled();
    expect(view.state.cards[0]?.labels).toEqual(["bug"]);

    textButton(view.popover, "Save").click();
    await waitForFast(() => expect(view.state.cards[0]?.labels).toEqual(["research"]));
    expect(view.client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { labels: ["research"] },
    });
  });

  it("keeps free slots inert: they are not controls and never seed the palette", async () => {
    const card = createWorkboardCard({ labels: [] });
    const view = await openPalette({ card, board: board(["bug"]) });

    const free = [...view.palette.querySelectorAll<HTMLElement>(".workboard-palette__slot--free")];
    expect(free).toHaveLength(9);
    for (const slot of free) {
      expect(slot.tagName).toBe("SPAN");
      slot.click();
    }
    expect(view.palette.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect((view.editor.owner as WorkboardInlineText).hasUnsavedChanges).toBe(false);
    expect(view.client.request).not.toHaveBeenCalled();
  });

  it("shows the palette read-only when the card stops being editable mid-edit", async () => {
    const card = createWorkboardCard({ labels: ["bug"] });
    const view = await openPalette({ card, board: board(["bug", "research"]) });
    view.slot("research").click();
    // Archiving elsewhere removes editability while the popover is open.
    view.state.cards = [{ ...card, metadata: { archivedAt: 2 } }];
    view.rerender();

    await waitForFast(() =>
      expect(view.palette.classList.contains("workboard-palette--readonly")).toBe(true),
    );
    expect(view.palette.isConnected).toBe(true);
    expect(view.slot("bug").getAttribute("aria-disabled")).toBe("true");
    view.slot("bug").click();
    // The dirty draft survives, but the read-only slots no longer change it.
    expect(view.slot("bug").getAttribute("aria-pressed")).toBe("true");
    expect(view.slot("research").getAttribute("aria-pressed")).toBe("true");
    expect(view.input.readOnly).toBe(true);
    expect(textButton(view.popover, "Create").disabled).toBe(true);
  });

  it("refuses an 11th classification at the field and leaves the card unchanged", async () => {
    const card = createWorkboardCard({ labels: ["bug"] });
    const view = await openPalette({ card, board: board(FULL) });

    expect(view.palette.classList.contains("workboard-palette--full")).toBe(true);
    expect(view.palette.querySelectorAll(".workboard-palette__slot--free")).toHaveLength(0);
    view.type("triage");
    await view.create();

    const error = await waitForFast(() =>
      expectDefined(
        view.popover.querySelector<HTMLElement>(".workboard-palette__error"),
        "field error",
      ),
    );
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "No free slot for “triage”. Reuse a classification above, or replace one below.",
    );
    expect(view.palette.classList.contains("workboard-palette--error")).toBe(true);
    expect(view.input.getAttribute("aria-describedby")).toBe(error.id);
    expect(view.input.value).toBe("triage");
    expect(view.client.request).not.toHaveBeenCalled();
    expect(view.state.cards[0]?.labels).toEqual(["bug"]);
    expect(view.state.error).toBeNull();
  });

  it("names the target slot and its card count, cancels without effect, then replaces", async () => {
    const card = createWorkboardCard({ id: "card-1", labels: ["bug"] });
    const others = [
      createWorkboardCard({ id: "card-2", labels: ["Ops"] }),
      createWorkboardCard({ id: "card-3", labels: ["ops", "bug"] }),
      createWorkboardCard({
        id: "card-4",
        labels: ["ops"],
        metadata: { automation: { boardId: "elsewhere" } },
      }),
    ];
    const view = await openPalette({ card, board: board(FULL), others });
    view.type("triage");
    await view.create();

    const picker = await waitForFast(() =>
      expectDefined(
        view.popover.querySelector<HTMLElement>(".workboard-palette__overwrite"),
        "overwrite picker",
      ),
    );
    const select = expectDefined(picker.querySelector("select"), "overwrite target");
    expect([...select.options].map((option) => option.value)).toEqual(["", ...FULL]);
    const replace = expectDefined(
      picker.querySelector<HTMLButtonElement>(".workboard-palette__replace"),
      "replace button",
    );
    expect(replace.disabled).toBe(true);
    expect(replace.classList.contains("primary")).toBe(false);

    select.value = "ops";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const warning = await waitForFast(() =>
      expectDefined(
        picker.querySelector<HTMLElement>(".workboard-palette__overwrite-warning"),
        "overwrite warning",
      ),
    );
    expect(warning.getAttribute("role")).toBe("alert");
    // Two cards on this board carry "ops" (any case); the other board's card does not count.
    expect(warning.textContent).toBe(
      "“ops” loses its classification on 2 cards. “triage” takes its slot and color.",
    );
    expect(replace.textContent).toBe("Replace “ops” with “triage”");

    textButton(picker, "Keep palette").click();
    await waitForFast(() =>
      expect(view.popover.querySelector(".workboard-palette__overwrite")).toBeNull(),
    );
    expect(view.popover.querySelector(".workboard-palette__error")).toBeNull();
    expect(view.input.value).toBe("triage");
    expect(view.client.request).not.toHaveBeenCalled();

    await view.create();
    const reopened = await waitForFast(() =>
      expectDefined(
        view.popover.querySelector<HTMLElement>(".workboard-palette__overwrite"),
        "overwrite picker",
      ),
    );
    const target = expectDefined(reopened.querySelector("select"), "overwrite target");
    target.value = "ops";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() =>
      expect(
        reopened.querySelector<HTMLButtonElement>(".workboard-palette__replace")?.disabled,
      ).toBe(false),
    );
    textButton(reopened, "Replace “ops”").click();

    await waitForFast(() =>
      expect(view.state.cards.find((entry) => entry.id === card.id)?.labels).toEqual([
        "bug",
        "triage",
      ]),
    );
    expect(view.client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { labels: ["bug", "triage"], replaces: "ops" },
    });
    await waitForFast(() => expect(view.popover.querySelector(".workboard-palette")).toBeNull());
  });

  it("keeps a refused replacement at the field with the picker still open", async () => {
    const card = createWorkboardCard({ labels: [] });
    const view = await openPalette({
      card,
      board: board(FULL),
      respond: () => {
        throw new Error('replaces "ops" is not a classification on board "default".');
      },
    });
    view.type("triage");
    await view.create();
    const select = await waitForFast(() =>
      expectDefined(
        view.popover.querySelector<HTMLSelectElement>(".workboard-palette__overwrite select"),
        "overwrite target",
      ),
    );
    select.value = "ops";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() =>
      expect(view.popover.querySelector(".workboard-palette__overwrite-warning")).not.toBeNull(),
    );
    textButton(view.popover, "Replace “ops”").click();

    await waitForFast(() =>
      expect(view.popover.querySelector(".workboard-palette__error")?.textContent).toContain(
        'replaces "ops" is not a classification',
      ),
    );
    expect(view.popover.querySelector(".workboard-palette__overwrite")).not.toBeNull();
    expect(view.input.value).toBe("triage");
    expect(view.state.cards[0]?.labels).toEqual([]);
    expect(view.state.error).toBeNull();
  });

  it("explains an empty palette and makes Create the primary action", async () => {
    const card = createWorkboardCard({ labels: ["parallelizable", "legacy"] });
    const view = await openPalette({ card, board: board([]) });

    expect(view.palette.classList.contains("workboard-palette--empty")).toBe(true);
    expect(view.palette.querySelector(".workboard-palette__status")?.textContent).toBe(
      "No classifications yet — create the first one here.",
    );
    expect(view.palette.querySelector(".workboard-palette__count")?.textContent).toBe(
      "0 / 10 used",
    );
    expect(textButton(view.popover, "Create").classList.contains("primary")).toBe(true);
    // Labels without a slot stay visible and removable, and the note says why they take none.
    const unslotted = [
      ...view.palette.querySelectorAll<HTMLElement>(".workboard-palette__slot--unslotted"),
    ];
    expect(unslotted.map((slot) => slot.textContent)).toEqual(["parallelizable", "legacy"]);
    expect(unslotted.every((slot) => slot.getAttribute("aria-pressed") === "true")).toBe(true);
    expect(view.palette.querySelector(".workboard-palette__note")?.textContent).toContain(
      "parallelizable",
    );

    view.type("bug");
    await view.create();
    await waitForFast(() =>
      expect(view.state.cards[0]?.labels).toEqual(["parallelizable", "legacy", "bug"]),
    );
  });

  it("marks the palette loading until the card's board summary arrives", async () => {
    const card = createWorkboardCard({ labels: [] });
    const view = await openPalette({ card });

    expect(view.palette.classList.contains("workboard-palette--loading")).toBe(true);
    expect(view.palette.querySelector(".workboard-palette__count")).toBeNull();
    expect(view.palette.querySelector(".workboard-palette__status")?.textContent).toBe(
      "Loading classifications…",
    );
  });

  it("steps back from the overwrite step on Escape and keeps the rest of the draft", async () => {
    const card = createWorkboardCard({ labels: ["bug"] });
    const view = await openPalette({ card, board: board(FULL) });
    view.slot("docs").click();
    view.type("triage");
    await view.create();
    const select = await waitForFast(() =>
      expectDefined(
        view.popover.querySelector<HTMLSelectElement>(".workboard-palette__overwrite select"),
        "overwrite target",
      ),
    );
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    select.dispatchEvent(escape);

    await waitForFast(() =>
      expect(view.popover.querySelector(".workboard-palette__overwrite")).toBeNull(),
    );
    expect(escape.defaultPrevented).toBe(true);
    // Still editing: the slot toggle and the typed name survive; only the step closed.
    expect(view.popover.querySelector(".workboard-palette")).not.toBeNull();
    expect(view.slot("docs").getAttribute("aria-pressed")).toBe("true");
    expect(view.input.value).toBe("triage");
    expect(view.popover.querySelector(".workboard-palette__error")).toBeNull();
    expect(view.client.request).not.toHaveBeenCalled();
  });

  it("asks to replace only the name past the last free slot, and one per save", async () => {
    const card = createWorkboardCard({ labels: [] });
    const view = await openPalette({ card, board: board(FULL.slice(0, 9)) });
    view.type("alpha, beta");
    await view.create();

    const picker = await waitForFast(() =>
      expectDefined(
        view.popover.querySelector<HTMLElement>(".workboard-palette__overwrite"),
        "overwrite picker",
      ),
    );
    // "alpha" takes the free tenth slot; "beta" is the one that needs a replacement.
    expect(view.popover.querySelector(".workboard-palette__error")?.textContent).toContain(
      "No free slot for “beta”",
    );
    const select = expectDefined(picker.querySelector("select"), "overwrite target");
    select.value = "ops";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() =>
      expect(picker.querySelector(".workboard-palette__replace")?.textContent).toBe(
        "Replace “ops” with “beta”",
      ),
    );

    // The field drives the step: a third name cannot be replaced in the same save.
    view.type("alpha, beta, gamma");
    await waitForFast(() =>
      expect(view.popover.querySelector(".workboard-palette__error")?.textContent).toBe(
        "Only one classification can be replaced per save. Create these one at a time: beta, gamma.",
      ),
    );
    expect(view.popover.querySelector(".workboard-palette__overwrite")).toBeNull();
    // Back to names that fit: the step and its refusal disappear without a request.
    view.type("alpha");
    await waitForFast(() =>
      expect(view.popover.querySelector(".workboard-palette__error")).toBeNull(),
    );
    expect(view.client.request).not.toHaveBeenCalled();
  });
});
