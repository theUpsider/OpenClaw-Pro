import { describe, expect, it } from "vitest";
import {
  countNoteLines,
  parseWorkboardNote,
  WORKBOARD_NOTE_SECTION_LABEL_KEYS,
  WORKBOARD_NOTES_LEAD_CHARS,
  workboardNoteDisplaySource,
  workboardNoteFallback,
} from "./note-outline.ts";

const conforming = [
  "Was: Der Drawer rendert die Notes als ein Markdown-Block.",
  "Stand: Parser und Lesepfad stehen, Tests laufen.",
  "Naechster Schritt: Reviewer liest den Diff.",
  "Beleg: reports/2026-11-12-note-outline.md",
].join("\n");

const sectionTitles = (notes: string | undefined) =>
  parseWorkboardNote(notes).sections.map((section) => section.key);

describe("parseWorkboardNote", () => {
  it("parses every key of a fully conforming note", () => {
    const outline = parseWorkboardNote(conforming);
    expect(outline.structured).toBe(true);
    expect(outline.preamble).toBe("");
    expect(outline.sections).toEqual([
      {
        key: "stand",
        labelKey: WORKBOARD_NOTE_SECTION_LABEL_KEYS.stand,
        text: "Parser und Lesepfad stehen, Tests laufen.",
        lineCount: 1,
      },
      {
        key: "nextStep",
        labelKey: WORKBOARD_NOTE_SECTION_LABEL_KEYS.nextStep,
        text: "Reviewer liest den Diff.",
        lineCount: 1,
      },
      {
        key: "evidence",
        labelKey: WORKBOARD_NOTE_SECTION_LABEL_KEYS.evidence,
        text: "reports/2026-11-12-note-outline.md",
        lineCount: 1,
      },
      {
        key: "what",
        labelKey: WORKBOARD_NOTE_SECTION_LABEL_KEYS.what,
        text: "Der Drawer rendert die Notes als ein Markdown-Block.",
        lineCount: 1,
      },
    ]);
  });

  it("returns the sections in the fixed display order however the note was authored", () => {
    const outline = parseWorkboardNote(
      ["Beleg: b", "Nächster Schritt: c", "Was: a", "Stand: d"].join("\n"),
    );
    expect(outline.sections.map((section) => section.key)).toEqual([
      "stand",
      "nextStep",
      "evidence",
      "what",
    ]);
    expect(outline.sections.map((section) => section.text)).toEqual(["d", "c", "b", "a"]);
  });

  it("keeps a missing Stand out of the list instead of inventing an empty row", () => {
    const outline = parseWorkboardNote(["Was: a", "Beleg: b"].join("\n"));
    expect(sectionTitles(["Was: a", "Beleg: b"].join("\n"))).toEqual(["evidence", "what"]);
    expect(outline.sections.every((section) => section.text.length > 0)).toBe(true);
  });

  it("leaves a note without a recognised key unstructured and returns the raw text", () => {
    const notes = "Just prose.\nNo key anywhere.\nSecond sentence.";
    const outline = parseWorkboardNote(notes);
    expect(outline.structured).toBe(false);
    expect(outline.sections).toEqual([]);
    expect(outline.raw).toBe(notes);
    expect(outline.preamble).toBe(notes);
  });

  it("keeps a Beleg URL intact so the host renderer owns the link", () => {
    const outline = parseWorkboardNote("Beleg: https://example.test/pr/75\nWas: b");
    const evidence = outline.sections.find((section) => section.key === "evidence");
    expect(evidence?.text).toBe("https://example.test/pr/75");
    expect(workboardNoteDisplaySource("https://example.test/pr/75")).toBe(
      "https://example.test/pr/75",
    );
  });

  it("parses CRLF line endings", () => {
    const outline = parseWorkboardNote(
      "Was: a\r\n\r\nStand: b ist mehrzeilig\r\nund geht weiter\r\nNaechster Schritt: c\r\n",
    );
    expect(outline.sections.map((section) => section.key)).toEqual(["stand", "nextStep", "what"]);
    expect(outline.sections[0]?.text).toBe("b ist mehrzeilig\nund geht weiter");
    expect(outline.sections[0]?.lineCount).toBe(2);
  });

  it("accepts the ASCII spelling Naechster", () => {
    const outline = parseWorkboardNote("Naechster Schritt: only the ASCII key\n");
    expect(outline.sections).toEqual([
      {
        key: "nextStep",
        labelKey: WORKBOARD_NOTE_SECTION_LABEL_KEYS.nextStep,
        text: "only the ASCII key",
        lineCount: 1,
      },
    ]);
  });

  it("does not split on a key-like string inside another section's body", () => {
    const outline = parseWorkboardNote(
      ["Stand: der Beleg: steht in der nächsten Zeile", "Beleg: reports/x.md", "Was: a"].join("\n"),
    );
    expect(outline.sections.map((section) => section.key)).toEqual(["stand", "evidence", "what"]);
    expect(outline.sections[0]?.text).toBe("der Beleg: steht in der nächsten Zeile");
    expect(outline.sections[1]?.text).toBe("reports/x.md");
  });

  it("matches keys case-insensitively and tolerates space around the colon", () => {
    const outline = parseWorkboardNote("  stand : b\nWAS:a\nBELEG :  c  \n");
    expect(outline.sections.map((section) => section.key)).toEqual(["stand", "evidence", "what"]);
    expect(outline.sections.map((section) => section.text)).toEqual(["b", "c", "a"]);
  });

  it("keeps the pre-key lines as the preamble, for decision and waiting cards", () => {
    const outline = parseWorkboardNote(
      [
        "Braucht von the operator: Postgres oder SQLite?",
        "Optionen: (1) Postgres (2) SQLite — Empfehlung: Postgres",
        "Stand: beide gemessen",
        "Beleg: reports/x.md",
      ].join("\n"),
    );
    expect(outline.preamble).toContain("Braucht von the operator: Postgres oder SQLite?");
    expect(outline.sections.map((section) => section.key)).toEqual(["stand", "evidence"]);
  });

  it("drops a bare key that carries no value", () => {
    expect(sectionTitles("Stand:\nWas: a")).toEqual(["what"]);
  });

  it("keeps the stored string byte-identical on the outline", () => {
    const notes = "Was: a\r\nStand:  b  \r\n";
    expect(parseWorkboardNote(notes).raw).toBe(notes);
  });

  it("handles an empty or missing note", () => {
    expect(parseWorkboardNote(undefined)).toEqual({
      structured: false,
      sections: [],
      preamble: "",
      lead: "",
      rest: "",
      raw: "",
    });
    expect(parseWorkboardNote("")).toMatchObject({ structured: false, preamble: "" });
  });

  it("counts non-empty lines", () => {
    expect(countNoteLines("a\n\n  \nb")).toBe(2);
    expect(countNoteLines("")).toBe(0);
  });
});

describe("workboardNoteFallback", () => {
  it("leads with the first sentence and keeps the remainder behind the disclosure", () => {
    const { lead, rest } = workboardNoteFallback("Erster Satz hier. Zweiter Satz dort.");
    expect(lead).toBe("Erster Satz hier.");
    expect(rest).toBe("Zweiter Satz dort.");
  });

  it("caps a sentence with no terminator and never repeats it in the remainder", () => {
    const text = `no terminator ${"x".repeat(200)}`;
    const { lead, rest } = workboardNoteFallback(text);
    expect(lead.length).toBeLessThanOrEqual(WORKBOARD_NOTES_LEAD_CHARS + 1);
    expect(lead.endsWith("…")).toBe(true);
    expect(rest.startsWith("x")).toBe(true);
    expect(`${lead}${rest}`).not.toContain("no terminator no terminator");
  });

  it("returns an empty pair for an empty note", () => {
    expect(workboardNoteFallback("   ")).toEqual({ lead: "", rest: "" });
  });
});

describe("workboardNoteDisplaySource", () => {
  it("marks a file path as a reference without inventing a destination", () => {
    expect(workboardNoteDisplaySource("siehe reports/2026-11-12/gate-result.json:12")).toBe(
      "siehe `reports/2026-11-12/gate-result.json:12`",
    );
    expect(workboardNoteDisplaySource("~/.local/state/x.log")).toBe("`~/.local/state/x.log`");
    expect(workboardNoteDisplaySource("/workspace/x.md")).toBe("`/workspace/x.md`");
  });

  it("marks a card id as a reference", () => {
    expect(workboardNoteDisplaySource("wartet auf 4e2248d3-dc1f-4a2b-9c3d-0f1e2a3b4c5d")).toBe(
      "wartet auf `4e2248d3-dc1f-4a2b-9c3d-0f1e2a3b4c5d`",
    );
  });

  it("leaves a URL to the host renderer and does not trail prose punctuation into it", () => {
    expect(workboardNoteDisplaySource("see https://example.test/pr/75, then stop")).toBe(
      "see https://example.test/pr/75, then stop",
    );
    expect(workboardNoteDisplaySource("https://example.test/a.md")).toBe(
      "https://example.test/a.md",
    );
  });

  it("leaves an authored code span alone and never splits it", () => {
    expect(workboardNoteDisplaySource("run `pnpm test` in the repo")).toBe(
      "run `pnpm test` in the repo",
    );
    expect(workboardNoteDisplaySource("`reports/x.md`")).toBe("`reports/x.md`");
  });

  it("leaves a bare filename and a commit prefix as prose", () => {
    expect(workboardNoteDisplaySource("see README.md")).toBe("see README.md");
    expect(workboardNoteDisplaySource("commit 7be610c9bcd")).toBe("commit 7be610c9bcd");
  });

  it("is a pure projection: it never rewrites the stored note", () => {
    const notes = "Beleg: reports/a/b.md und https://example.test";
    const outline = parseWorkboardNote(notes);
    expect(workboardNoteDisplaySource(outline.sections[0]?.text ?? "")).not.toBe(
      outline.sections[0]?.text,
    );
    expect(outline.raw).toBe(notes);
  });
});
