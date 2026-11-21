/**
 * The plain-text notes convention every Workboard card is written in:
 *
 *   Was: what the card is about
 *   Stand: what has happened so far
 *   Naechster Schritt: the one next action
 *   Beleg: the evidence reference
 *
 * 101 of 108 open cards follow it, but the drawer rendered the whole note as one Markdown
 * block, so a 960-character note read as a wall. This module parses the convention for the
 * read path only: it is pure (no DOM, no host, no `t()`), it never rewrites, reorders or
 * normalises the stored string, and `card.notes` stays exactly as the agent wrote it.
 *
 * The section keys are German prompt conventions, so they are matched, not displayed; the
 * display labels are i18n (`WORKBOARD_NOTE_SECTION_LABEL_KEYS`, resolved by the caller).
 */

/** Fixed display order in the drawer, regardless of how the agent authored the note. */
export const WORKBOARD_NOTE_SECTION_KEYS = ["stand", "nextStep", "evidence", "what"] as const;

export type WorkboardNoteSectionKey = (typeof WORKBOARD_NOTE_SECTION_KEYS)[number];

/** The i18n key per section; the module never renders text itself. */
export const WORKBOARD_NOTE_SECTION_LABEL_KEYS: Readonly<Record<WorkboardNoteSectionKey, string>> =
  {
    stand: "workboard.notes.stand",
    nextStep: "workboard.notes.nextStep",
    evidence: "workboard.notes.evidence",
    what: "workboard.notes.what",
  };

/** The fallback lead is one sentence of at most this many characters. */
export const WORKBOARD_NOTES_LEAD_CHARS = 140;

/** `Was` longer than this many non-empty lines collapses behind a disclosure. */
export const WORKBOARD_NOTES_COLLAPSE_LINES = 3;

export type WorkboardNoteSection = {
  key: WorkboardNoteSectionKey;
  labelKey: string;
  text: string;
  lineCount: number;
};

export type WorkboardNoteOutline = {
  /** True when the note carries at least one recognised section with text. */
  structured: boolean;
  /** Recognised sections in fixed display order; empty when `structured` is false. */
  sections: readonly WorkboardNoteSection[];
  /**
   * Lines before the first recognised key. Decision cards lead with `Braucht von the operator:` and
   * waiting cards with `Wartet auf:`, neither of which is a section key; the caller renders
   * this above the list so the question is never dropped.
   */
  preamble: string;
  /**
   * The unstructured fallback: the first sentence, capped, as the lead, and the text after it
   * as the collapsed remainder. Computed for every note (pure and cheap) but rendered only
   * when `structured` is false.
   */
  lead: string;
  rest: string;
  /** The stored string, unchanged. */
  raw: string;
};

// Both spellings of the second key: agents write `Naechster` (ASCII) and `Nächster` (umlaut),
// verified in live notes; neither may be missed.
const NOTE_KEY_PATTERN = /^\s*(Was|Stand|Naechster Schritt|Nächster Schritt|Beleg)\s*:(.*)$/iu;

const NOTE_SECTION_BY_LABEL: Readonly<Record<string, WorkboardNoteSectionKey>> = {
  was: "what",
  stand: "stand",
  "naechster schritt": "nextStep",
  "nächster schritt": "nextStep",
  beleg: "evidence",
};

function noteSectionKey(label: string): WorkboardNoteSectionKey | undefined {
  return NOTE_SECTION_BY_LABEL[label.trim().toLowerCase()];
}

/**
 * Parse the convention into sections in fixed display order.
 *
 * A line whose first non-space content is one of the four keys (case-insensitive, optional
 * space before the colon) opens a section; every following line belongs to it until the next
 * key. A key-like string later in a line is body text and never splits. A repeated key keeps
 * authoring order inside one section instead of producing two rows.
 */
export function parseWorkboardNote(notes: string | undefined): WorkboardNoteOutline {
  const raw = notes ?? "";
  const authored = new Map<WorkboardNoteSectionKey, string[]>();
  const preamble: string[] = [];
  let current: WorkboardNoteSectionKey | undefined;
  for (const line of raw.split(/\r?\n/u)) {
    const match = NOTE_KEY_PATTERN.exec(line);
    const key = match ? noteSectionKey(match[1] ?? "") : undefined;
    if (key) {
      current = key;
      const body = authored.get(key) ?? [];
      if (body.length > 0) {
        // The same key twice: one row, separated by a blank line, nothing dropped.
        body.push("");
      }
      const first = (match?.[2] ?? "").trim();
      if (first) {
        body.push(first);
      }
      authored.set(key, body);
      continue;
    }
    if (current) {
      authored.get(current)?.push(line);
    } else {
      preamble.push(line);
    }
  }
  const sections: WorkboardNoteSection[] = [];
  for (const key of WORKBOARD_NOTE_SECTION_KEYS) {
    const text = (authored.get(key) ?? []).join("\n").trim();
    if (!text) {
      // A bare `Stand:` with no value carries nothing; it never becomes an empty row.
      continue;
    }
    sections.push({
      key,
      labelKey: WORKBOARD_NOTE_SECTION_LABEL_KEYS[key],
      text,
      lineCount: countNoteLines(text),
    });
  }
  return {
    structured: sections.length > 0,
    sections,
    preamble: preamble.join("\n").trim(),
    ...workboardNoteFallback(raw),
    raw,
  };
}

/**
 * The lead/remainder split for a note the convention does not cover: the first sentence,
 * capped, and everything after it. The remainder starts where the lead stopped, so revealing
 * the full note never repeats the lead.
 */
export function workboardNoteFallback(raw: string): { lead: string; rest: string } {
  const text = raw.trim();
  if (!text) {
    return { lead: "", rest: "" };
  }
  const match = /^[\s\S]*?[.!?](?=\s|$)/u.exec(text);
  const sentence = (match?.[0] ?? text).trim();
  const cut = Math.min(sentence.length, WORKBOARD_NOTES_LEAD_CHARS);
  return {
    lead: cut < sentence.length ? `${sentence.slice(0, cut).trimEnd()}\u2026` : sentence,
    rest: text.slice(cut).trim(),
  };
}

/** Non-empty lines, the unit the `Was` disclosure counts. */
export function countNoteLines(text: string): number {
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
}

// Trailing prose punctuation (`).,;:!?`) is not part of the destination; the host renderer
// would otherwise make it part of the `href`.
const NOTE_URL_SOURCE = "https?:\\/\\/[^\\s<>\"'`]*[^\\s<>\"'`).,;:!?]";
const NOTE_PATH_SUFFIX_SOURCE = "\\.[A-Za-z0-9]{1,8}(?::\\d+(?:-\\d+)?)?";
const NOTE_PATH_SOURCE = [
  // Rooted, home-relative, dot-relative or drive-relative paths: they need one separator.
  `(?:~\\/|\\.{1,2}\\/|\\/|[A-Za-z]:[\\\\/])[\\w.@+-]+(?:[\\\\/][\\w.@+-]+)*${NOTE_PATH_SUFFIX_SOURCE}`,
  // Relative multi-segment paths (`reports/gate/shot-1.png`). A bare filename is not a path
  // any more than it is a URL, so it stays prose.
  `[\\w.@+-]+(?:[\\\\/][\\w.@+-]+)+${NOTE_PATH_SUFFIX_SOURCE}`,
].join("|");
// A card id is the store's UUID; shorter hex runs are commit prefixes and stay prose.
const NOTE_CARD_ID_SOURCE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const NOTE_TOKEN_PATTERN = new RegExp(
  `(${NOTE_URL_SOURCE})|(${NOTE_PATH_SOURCE})|(${NOTE_CARD_ID_SOURCE})`,
  "gu",
);

/**
 * The Markdown source the drawer renders for one value: the URL grammar stays the host
 * renderer's (it linkifies `http(s)`/`www` and sanitizes), while file paths and card ids are
 * wrapped in a code span so a reference reads as a reference.
 *
 * This is a render-time projection of a copy. The stored note is untouched, and a link is
 * only ever produced for a real destination: paths and ids get no `href`, because this app
 * has no file opener or card deep link reachable from the drawer notes, and a link that can
 * only fail is worse than none.
 */
export function workboardNoteDisplaySource(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(NOTE_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    const token = match[0];
    result += text.slice(cursor, index);
    cursor = index + token.length;
    // A URL keeps its own grammar; an authored code span is left alone; a token carrying a
    // backtick would close the span it is wrapped in, so it stays verbatim too.
    const reference =
      !match[1] && !token.includes("`") && text[index - 1] !== "`" && text[cursor] !== "`";
    result += reference ? `\`${token}\`` : token;
  }
  result += text.slice(cursor);
  return result;
}
