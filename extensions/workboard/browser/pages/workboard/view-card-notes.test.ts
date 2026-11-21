import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { createWorkboardView, inlineEditor, textButton } from "./view.test-support.ts";

const conforming = [
  "Was: Der Drawer rendert die Notes als ein Markdown-Block.",
  "Stand: Parser und Lesepfad stehen, die Tests laufen.",
  "Naechster Schritt: Der Reviewer liest den Diff.",
  "Beleg: reports/2026-11-12-note-outline.md",
].join("\n");

const unstructured = [
  "Ein Satz ohne jede Konvention, der die Grenze deutlich überschreitet und deshalb hinter",
  "dem Aufklapper steht. Und noch ein zweiter Satz, damit der Rest nicht leer ist.",
].join("\n");

/** The mounts whose container sits inside the notes block, not the waiting line above it. */
function notesMounts() {
  return workboardTestHost().host.components.mountMarkdown.mock.calls.filter(
    ([container]) => container instanceof Element && container.closest(".workboard-notes"),
  );
}

function notesSources() {
  return notesMounts().map(([, props]) => (props as { markdown: string }).markdown);
}

function notesClasses() {
  return notesMounts().map(([, props]) => (props as { class?: string }).class);
}

function renderNotes(notes: string, options: { writable?: boolean; archived?: boolean } = {}) {
  workboardTestHost().host.components.mountMarkdown.mockClear();
  const card = createWorkboardCard({
    notes,
    ...(options.archived ? { metadata: { archivedAt: 10 } } : {}),
  });
  const view = createWorkboardView(
    options.writable === false ? {} : { client: createWorkboardTestClient({}) },
  );
  view.state.cards = [card];
  view.state.showArchived = Boolean(options.archived);
  view.state.detailCardId = card.id;
  view.renderView();
  const overview = expectDefined(
    view.container.querySelector<HTMLElement>("#workboard-detail-panel-overview"),
    "overview panel",
  );
  const list = () =>
    [...overview.querySelectorAll<HTMLElement>(".workboard-notes__list > *")].map((row) => [
      row.tagName.toLowerCase(),
      row.textContent?.trim(),
    ]);
  return { card, view, overview, list };
}

describe("card notes structure", () => {
  it("renders a conforming note as a label/value list in the fixed display order", () => {
    const { list } = renderNotes(conforming);
    // Stand -> Naechster Schritt -> Beleg -> Was, though the note is authored in that order.
    expect(list()).toEqual([
      ["dt", "Status"],
      ["dd", "Parser und Lesepfad stehen, die Tests laufen."],
      ["dt", "Next step"],
      ["dd", "Der Reviewer liest den Diff."],
      ["dt", "Evidence"],
      ["dd", "`reports/2026-11-12-note-outline.md`"],
      ["dt", "What"],
      ["dd", "Der Drawer rendert die Notes als ein Markdown-Block."],
    ]);
  });

  it("renders the fixed order even when the note lists the keys in another order", () => {
    const { list } = renderNotes(["Beleg: b.md", "Was: a", "Stand: s"].join("\n"));
    expect(list().map(([tag]) => tag)).toEqual(["dt", "dd", "dt", "dd", "dt", "dd"]);
    expect(
      list()
        .filter(([tag]) => tag === "dt")
        .map(([, text]) => text),
    ).toEqual(["Status", "Evidence", "What"]);
  });

  it("shows the structured list and never the unstructured marker", () => {
    const { overview } = renderNotes(conforming);
    expect(overview.querySelector(".workboard-notes__list")).not.toBeNull();
    expect(overview.querySelector(".workboard-notes__marker")).toBeNull();
  });

  it("falls a non-conforming note back to a lead plus a collapsed remainder, with a marker", () => {
    const { overview, list } = renderNotes(unstructured);
    expect(overview.querySelector(".workboard-notes__list")).toBeNull();
    expect(list()).toEqual([]);
    const marker = expectDefined(
      overview.querySelector(".workboard-notes__marker"),
      "unstructured marker",
    );
    // Informational text, not an error: no alert role, and the words carry the meaning.
    expect(marker.textContent).toBe("Unstructured note");
    expect(marker.closest("[role='alert']")).toBeNull();
    const help = expectDefined(
      overview.querySelector(".workboard-notes__marker-help"),
      "marker help",
    );
    expect(help.textContent).toBe(
      "This note does not follow the Was / Stand / Naechster Schritt / Beleg convention, so it is shown as plain text. Nothing is rewritten.",
    );
    const disclosure = expectDefined(
      overview.querySelector<HTMLDetailsElement>(".workboard-notes__disclosure"),
      "fallback disclosure",
    );
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("summary")?.textContent?.replace(/\s+/gu, " ")).toBe(
      `Show full note (${unstructured.trim().length} characters)`,
    );
    // The lead and the remainder are two separate mounts, so the remainder never repeats the
    // lead. The lead is a verbatim slice, so its authored line break survives (pre-wrap).
    expect(notesClasses()).toEqual(["workboard-notes__lead", "workboard-notes__rest"]);
    expect(notesSources()).toEqual([
      "Ein Satz ohne jede Konvention, der die Grenze deutlich überschreitet und deshalb hinter\ndem Aufklapper steht.",
      "Und noch ein zweiter Satz, damit der Rest nicht leer ist.",
    ]);
  });

  it("collapses a Was longer than three lines behind a keyboard-operable disclosure", () => {
    const { overview } = renderNotes(
      ["Stand: kurz", "Was: Zeile eins", "Zeile zwei", "Zeile drei", "Zeile vier"].join("\n"),
    );
    const details = expectDefined(
      overview.querySelector<HTMLDetailsElement>(
        ".workboard-notes__value .workboard-notes__disclosure",
      ),
      "Was disclosure",
    );
    // A native <details>/<summary> is focusable and toggles on Enter and Space by itself.
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Show what this card is about");
    expect(details.tagName.toLowerCase()).toBe("details");
  });

  it("does not collapse a Was of three lines or fewer", () => {
    const { overview } = renderNotes(["Was: eins", "zwei", "drei"].join("\n"));
    const value = expectDefined(overview.querySelector(".workboard-notes__value"), "Was value");
    expect(value.querySelector(".workboard-notes__disclosure")).toBeNull();
    expect(value.textContent?.replace(/\s+/gu, " ").trim()).toBe("eins zwei drei");
  });

  it("keeps a decision card's question, which is not one of the four keys", () => {
    const { overview, list } = renderNotes(
      [
        "Braucht von the operator: Postgres oder SQLite?",
        "Stand: beide gemessen",
        "Beleg: reports/db.md",
      ].join("\n"),
    );
    // The question is rendered above the list as its own mount, so the four keys keep the list.
    expect(notesClasses()).toEqual(["workboard-notes__preamble", undefined, undefined]);
    expect(notesSources()).toContain("Braucht von the operator: Postgres oder SQLite?");
    expect(overview.querySelector(".workboard-notes__list")).not.toBeNull();
    expect(list().map(([, text]) => text)).toEqual([
      "Status",
      "beide gemessen",
      "Evidence",
      "`reports/db.md`",
    ]);
    expect(overview.querySelector(".workboard-notes__marker")).toBeNull();
  });

  it("labels the sections through i18n, not through the German parser keys", () => {
    const { overview } = renderNotes(conforming);
    const labels = [...overview.querySelectorAll(".workboard-notes__label")].map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Stand");
    expect(labels).not.toContain("Beleg");
    expect(labels).not.toContain("Naechster Schritt");
  });

  it("handles a key-like string inside another section's body without splitting twice", () => {
    const { list } = renderNotes(
      ["Stand: der Beleg: steht hier im Text", "Beleg: reports/x.md", "Was: a"].join("\n"),
    );
    expect(list().filter(([tag]) => tag === "dt").length).toBe(3);
    expect(list()).toContainEqual(["dd", "der Beleg: steht hier im Text"]);
  });

  it("parses the ASCII Naechster spelling in the drawer", () => {
    const { list } = renderNotes("Naechster Schritt: der ASCII-Schlüssel");
    expect(list()).toEqual([
      ["dt", "Next step"],
      ["dd", "der ASCII-Schlüssel"],
    ]);
  });

  it("parses CRLF notes from the store", () => {
    const { list } = renderNotes("Was: a\r\n\r\nStand: b\r\nund weiter\r\nBeleg: c.md\r\n");
    expect(list()).toContainEqual(["dd", "b\nund weiter"]);
    expect(list().filter(([tag]) => tag === "dt").length).toBe(3);
  });

  it("renders a card id and a file path in Evidence as references without inventing a link", () => {
    const { overview } = renderNotes(
      "Beleg: reports/gate/result.json und Karte 4e2248d3-dc1f-4a2b-9c3d-0f1e2a3b4c5d",
    );
    // Scoped to the Evidence value: the waiting line is a separate block mount above it.
    const value = expectDefined(
      overview.querySelector(".workboard-notes__value"),
      "Evidence value",
    );
    const mount = expectDefined(
      value.querySelector("[data-test-markdown]"),
      "Evidence markdown mount",
    );
    expect(mount.getAttribute("data-markdown")).toBe(
      "`reports/gate/result.json` und Karte `4e2248d3-dc1f-4a2b-9c3d-0f1e2a3b4c5d`",
    );
    // A reference is marked, never linked: this app has no file opener or card deep link here.
    expect(mount.querySelector("a")).toBeNull();
  });

  it("hands a URL in Evidence to the host renderer untouched", () => {
    const { overview } = renderNotes("Beleg: https://example.test/pr/75\nWas: a");
    const sources = [...overview.querySelectorAll("[data-markdown]")].map((node) =>
      node.getAttribute("data-markdown"),
    );
    // The URL keeps its own grammar; the host renderer linkifies and sanitizes it.
    expect(sources).toContain("https://example.test/pr/75");
  });
});

describe("card notes edit path", () => {
  it("still binds the original stored string, so a save writes the layout back unchanged", async () => {
    const { card, view } = renderNotes(conforming);
    const client = createWorkboardTestClient(() => ({
      card: { ...card, updatedAt: card.updatedAt + 1 },
    }));
    view.renderView({ client });
    const editor = await inlineEditor(view.container, "notes");

    const textarea = await editor.open();
    // The editor is bound to `card.notes` verbatim: no normalisation, no reordering.
    expect(textarea.value).toBe(conforming);
    // Saving an untouched draft is not a write; type one character and it is.
    textarea.value = `${conforming}!`;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    textButton(editor.owner, "Save").click();
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
        id: card.id,
        expectedUpdatedAt: card.updatedAt,
        patch: { notes: `${conforming}!` },
      }),
    );
    // The rendered structure came from a copy; the stored string keeps its authored layout.
    expect(card.notes).toBe(conforming);
    expect(conforming.startsWith("Was: ")).toBe(true);
  });

  it("keeps the read path rendering the same note after a successful save", async () => {
    const { card, view } = renderNotes(conforming);
    const saved = { ...card, notes: "Stand: nur Stand", updatedAt: card.updatedAt + 1 };
    const client = createWorkboardTestClient(() => ({ card: saved }));
    view.renderView({ client });
    const editor = await inlineEditor(view.container, "notes");
    const textarea = await editor.open();
    textarea.value = saved.notes;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    textButton(editor.owner, "Save").click();
    await waitForFast(() => expect(view.state.cards[0]?.notes).toBe("Stand: nur Stand"));
    const overview = expectDefined(
      view.container.querySelector("#workboard-detail-panel-overview"),
      "overview panel",
    );
    expect(
      [...overview.querySelectorAll(".workboard-notes__label")].map((node) => node.textContent),
    ).toEqual(["Status"]);
  });
});
