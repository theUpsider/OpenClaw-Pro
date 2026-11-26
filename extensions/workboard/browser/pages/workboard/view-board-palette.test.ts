import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkboardBoardSummary } from "../../lib/workboard/index.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { createBoardPaletteDraft, readBoardPaletteDraft } from "./view-board-palette.tsx";
import { mountPage, openBoardEditor } from "./workboard-page.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function board(palette: { name: string; color: string }[]): WorkboardBoardSummary {
  return {
    id: "planning",
    name: "Planning",
    total: 0,
    active: 0,
    archived: 0,
    byStatus: {},
    classifications: palette,
  };
}

describe("board palette draft", () => {
  it("is unchanged when the draft matches what was stored", () => {
    const draft = createBoardPaletteDraft([{ name: "bug", color: "red" }]);
    expect(readBoardPaletteDraft(draft)).toEqual({ changed: false });
  });

  it("reports the payload when a name or color changes", () => {
    const draft = createBoardPaletteDraft([{ name: "bug", color: "red" }]);
    draft.entries[0]!.color = "blue";
    expect(readBoardPaletteDraft(draft)).toEqual({
      changed: true,
      palette: [{ name: "bug", color: "blue" }],
    });
  });

  it.each([
    [[{ key: "a", name: "", color: "red" }], "Every classification needs a name."],
    [
      [
        { key: "a", name: "bug", color: "red" },
        { key: "b", name: "Bug", color: "blue" },
      ],
      "“Bug” is listed twice (names ignore case).",
    ],
    [[{ key: "a", name: "parallelizable", color: "red" }], "is a system label"],
    [[{ key: "a", name: "x".repeat(41), color: "red" }], "longer than 40 characters"],
  ])("refuses an invalid draft in place (%#)", (entries, message) => {
    const draft = { entries, original: [], error: null };
    const result = readBoardPaletteDraft(draft);
    expect(result.changed).toBe(true);
    expect(result.error).toContain(message);
  });
});

describe("board palette editor", () => {
  it("edits the palette of a cards board and writes it through the classifications method", async () => {
    const page = mountPage({ boardId: "planning" });
    page.boards([board([{ name: "bug", color: "red" }])]);
    page.fixture.connection.connected = true;
    page.fixture.notify();
    const form = await openBoardEditor(page);
    const palette = expectDefined(
      form.querySelector<HTMLElement>(".workboard-palette-editor"),
      "palette editor",
    );
    expect(palette.textContent).toContain("Classification palette");
    const rows = () => [...palette.querySelectorAll<HTMLElement>(".workboard-palette-editor__row")];
    expect(rows()).toHaveLength(1);

    // Rename the slot and add a second named classification.
    const name = expectDefined(
      rows()[0]!.querySelector<HTMLInputElement>(".settings-input"),
      "name",
    );
    name.value = "defect";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await afterWorkboardUpdate(() => {
      expect(
        form.querySelector<HTMLButtonElement>(".workboard-palette-editor__footer .btn")?.disabled,
      ).toBe(false);
    });
    form.querySelector<HTMLButtonElement>(".workboard-palette-editor__footer .btn")!.click();
    await afterWorkboardUpdate(() => expect(rows()).toHaveLength(2));
    const second = expectDefined(
      rows()[1]!.querySelector<HTMLInputElement>(".settings-input"),
      "second name",
    );
    second.value = "feature";
    second.dispatchEvent(new Event("input", { bubbles: true }));

    page.request.mockImplementationOnce(async () => ({
      board: { id: "planning", createdAt: 1, updatedAt: 1 },
    }));
    page.request.mockImplementationOnce(async () => ({
      classifications: [
        { name: "defect", color: "red" },
        { name: "feature", color: "blue" },
      ],
    }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await afterWorkboardUpdate(() =>
      expect(page.request).toHaveBeenCalledWith("workboard.boards.classifications", {
        boardId: "planning",
        classifications: [
          { name: "defect", color: "red" },
          { name: "feature", color: "blue" },
        ],
      }),
    );
  });

  it("blocks save with the reason at the field for an invalid draft", async () => {
    const page = mountPage({ boardId: "planning" });
    page.boards([board([{ name: "bug", color: "red" }])]);
    page.fixture.connection.connected = true;
    page.fixture.notify();
    const form = await openBoardEditor(page);
    const name = expectDefined(
      form.querySelector<HTMLInputElement>(".workboard-palette-editor__row .settings-input"),
      "name",
    );
    name.value = "";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await afterWorkboardUpdate(() => {
      const error = expectDefined(
        form.querySelector<HTMLElement>(".workboard-palette-editor__error"),
        "field error",
      );
      expect(error.getAttribute("role")).toBe("alert");
    });
    expect(
      page.request.mock.calls.filter(([method]) => method === "workboard.boards.classifications"),
    ).toHaveLength(0);
  });

  it("removes a slot so a card keeps its label as a plain chip", async () => {
    const page = mountPage({ boardId: "planning" });
    page.boards([board([{ name: "bug", color: "red" }])]);
    page.fixture.connection.connected = true;
    page.fixture.notify();
    const form = await openBoardEditor(page);
    const remove = expectDefined(
      form.querySelector<HTMLButtonElement>(
        '.workboard-palette-editor__row [aria-label^="Remove"]',
      ),
      "remove button",
    );
    remove.click();
    await afterWorkboardUpdate(() =>
      expect(form.querySelector<HTMLElement>(".workboard-palette-editor__empty")).not.toBeNull(),
    );

    page.request.mockImplementationOnce(async () => ({
      board: { id: "planning", createdAt: 1, updatedAt: 1 },
    }));
    page.request.mockImplementationOnce(async () => ({ classifications: [] }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await afterWorkboardUpdate(() =>
      expect(page.request).toHaveBeenCalledWith("workboard.boards.classifications", {
        boardId: "planning",
        classifications: [],
      }),
    );
  });

  it("shows no palette editor for a Sessions board", async () => {
    const page = mountPage({ boardId: "planning" });
    page.boards([
      {
        id: "planning",
        name: "Planning",
        kind: "sessions",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        sessions: {
          columns: [
            { id: "a", label: "A", description: "A", fallback: true },
            { id: "b", label: "B", description: "B" },
          ],
        },
      },
    ]);
    page.fixture.connection.connected = true;
    page.fixture.notify();
    const form = await openBoardEditor(page);
    expect(form.querySelector(".workboard-palette-editor")).toBeNull();
  });
});
