import { WORKBOARD_CLASSIFICATION_COLORS, type WorkboardBoardSummary } from "./types.ts";

export type WorkboardClassification = { name: string; color: string };

export type WorkboardCardClassification = {
  primary?: { label: string; color: string };
  /** Label -> CSS color, only for labels that match a palette entry with a known color. */
  colors: ReadonlyMap<string, string>;
  /** The primary label first, the remaining labels in stored order. */
  orderedLabels: readonly string[];
};

/**
 * Slots on one board. The Gateway store owns the limit (`MAX_WORKBOARD_CLASSIFICATIONS`,
 * not in the shared contract); the editor only counts against it and opens the overwrite
 * step at the limit. The write itself is still refused or accepted by the Gateway.
 */
export const WORKBOARD_CLASSIFICATION_SLOTS = 10;

/** The palette of the card's board; empty until boards load or while the board is unseeded. */
export function boardClassifications(
  boards: readonly Pick<WorkboardBoardSummary, "id" | "classifications">[],
  boardId: string,
): readonly WorkboardClassification[] {
  return boards.find((board) => board.id === boardId)?.classifications ?? [];
}

export function classificationKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** The eight named session colors, in the contract's order (re-exported from the contract). */
export { WORKBOARD_CLASSIFICATION_COLORS };

/**
 * A palette draft row for the board editor. `key` is stable across renames so a
 * Solid `<For>` keys on identity, not the (editable) name.
 */
export type WorkboardPaletteDraftEntry = { key: string; name: string; color: string };

/**
 * Seed a palette draft from a stored palette. Rows get a fresh key; the name is
 * the editable field and the color is one of the named swatches.
 */
export function createPaletteDraft(
  palette: readonly WorkboardClassification[],
): WorkboardPaletteDraftEntry[] {
  return palette.map((entry) => ({
    key: crypto.randomUUID(),
    name: entry.name,
    color: entry.color,
  }));
}

/**
 * Validate and normalize a draft into the palette payload, mirroring the store's
 * own rules so the board editor can refuse locally instead of round-tripping a
 * rejection. Returns the payload or a message naming the first problem.
 */
export function normalizePaletteDraft(
  entries: readonly WorkboardPaletteDraftEntry[],
): { palette: WorkboardClassification[] } | { error: string } {
  const palette: WorkboardClassification[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) {
      return { error: "Every classification needs a name." };
    }
    if (name.length > 40) {
      return { error: `“${name}” is longer than 40 characters.` };
    }
    if (classificationKey(name) === "parallelizable") {
      return { error: `“${name}” is a system label and cannot take a slot.` };
    }
    const key = classificationKey(name);
    if (seen.has(key)) {
      return { error: `“${name}” is listed twice (names ignore case).` };
    }
    seen.add(key);
    if (!WORKBOARD_CLASSIFICATION_COLORS.some((color) => color === entry.color)) {
      return { error: `“${name}” needs a color.` };
    }
    palette.push({ name, color: entry.color });
  }
  return { palette };
}

export function resolveCardClassification(
  labels: readonly string[],
  palette: readonly WorkboardClassification[],
  resolveColor: (value: string) => string,
): WorkboardCardClassification {
  const paletteColors = new Map<string, string>();
  for (const entry of palette) {
    const key = classificationKey(entry.name);
    const color = resolveColor(entry.color);
    if (color && !paletteColors.has(key)) {
      paletteColors.set(key, color);
    }
  }
  const colors = new Map<string, string>();
  let primary: WorkboardCardClassification["primary"];
  for (const label of labels) {
    const color = paletteColors.get(classificationKey(label));
    if (color) {
      colors.set(label, color);
      primary ??= { label, color };
    }
  }
  return {
    primary,
    colors,
    orderedLabels: primary
      ? [primary.label, ...labels.filter((label) => label !== primary.label)]
      : labels,
  };
}
