import {
  WORKBOARD_CLASSIFICATION_COLORS,
  type WorkboardCard,
  type WorkboardClassification,
  type WorkboardClassificationColor,
  type WorkboardMetadata,
} from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MAX_WORKBOARD_CLASSIFICATIONS, WORKBOARD_SYSTEM_LABELS } from "./store-constants.js";

const MAX_CLASSIFICATION_NAME_LENGTH = 40;

/** What one card label write did to its board palette; tools return it to the model. */
export type WorkboardClassificationChange = {
  boardId: string;
  classifications: WorkboardClassification[];
  added: string[];
  replaced?: { name: string; by: string };
};

type SeedCard = Pick<WorkboardCard, "id" | "labels" | "createdAt"> & {
  metadata?: Pick<WorkboardMetadata, "archivedAt">;
};

function classificationKey(name: string): string {
  return name.trim().toLowerCase();
}

export function isWorkboardSystemLabel(label: string): boolean {
  return WORKBOARD_SYSTEM_LABELS.includes(classificationKey(label));
}

function slotColor(index: number): WorkboardClassificationColor {
  return (
    WORKBOARD_CLASSIFICATION_COLORS[index % WORKBOARD_CLASSIFICATION_COLORS.length] ??
    WORKBOARD_CLASSIFICATION_COLORS[0]
  );
}

function isClassificationColor(value: unknown): value is WorkboardClassificationColor {
  return WORKBOARD_CLASSIFICATION_COLORS.some((color) => color === value);
}

export function describeWorkboardClassifications(
  palette: readonly WorkboardClassification[],
): string {
  return palette.length === 0
    ? "none"
    : palette.map((entry) => `${entry.name} (${entry.color})`).join(", ");
}

/** Validates a palette before it is stored; each error names the offending entry. */
export function normalizeWorkboardClassifications(value: unknown): WorkboardClassification[] {
  if (!Array.isArray(value)) {
    throw new Error("classifications must be an array.");
  }
  if (value.length > MAX_WORKBOARD_CLASSIFICATIONS) {
    throw new Error(
      `A board holds at most ${MAX_WORKBOARD_CLASSIFICATIONS} classifications; got ${value.length}.`,
    );
  }
  const seen = new Set<string>();
  return value.map((entry: unknown, index) => {
    const rawName = isRecord(entry) && typeof entry.name === "string" ? entry.name.trim() : "";
    if (!rawName || rawName.length > MAX_CLASSIFICATION_NAME_LENGTH) {
      throw new Error(
        `Classification ${index + 1} needs a name of 1-${MAX_CLASSIFICATION_NAME_LENGTH} characters.`,
      );
    }
    const key = classificationKey(rawName);
    if (isWorkboardSystemLabel(rawName)) {
      throw new Error(`Classification "${rawName}" is a system label and cannot take a slot.`);
    }
    if (seen.has(key)) {
      throw new Error(`Classification "${rawName}" is listed twice (names ignore case).`);
    }
    seen.add(key);
    const color = isRecord(entry) ? entry.color : undefined;
    if (!isClassificationColor(color)) {
      throw new Error(
        `Classification "${rawName}" color must be one of ${WORKBOARD_CLASSIFICATION_COLORS.join(", ")}.`,
      );
    }
    return { name: rawName, color };
  });
}

/**
 * One-time palette for a board that predates classifications: the distinct
 * non-system labels of its non-archived cards, most used first, ties by first
 * appearance in card creation order, capped at the slot limit. Card labels are
 * never rewritten; labels left out keep rendering as plain chips.
 */
export function seedWorkboardClassifications(
  cards: readonly SeedCard[],
): WorkboardClassification[] {
  const tally = new Map<string, { name: string; count: number; firstSeen: number }>();
  const ordered = cards
    .filter((card) => !card.metadata?.archivedAt)
    .toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  for (const card of ordered) {
    const counted = new Set<string>();
    for (const label of card.labels) {
      const name = label.trim();
      const key = classificationKey(name);
      if (
        !name ||
        name.length > MAX_CLASSIFICATION_NAME_LENGTH ||
        isWorkboardSystemLabel(name) ||
        counted.has(key)
      ) {
        continue;
      }
      counted.add(key);
      const entry = tally.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        tally.set(key, { name, count: 1, firstSeen: tally.size });
      }
    }
  }
  return [...tally.values()]
    .toSorted((left, right) => right.count - left.count || left.firstSeen - right.firstSeen)
    .slice(0, MAX_WORKBOARD_CLASSIFICATIONS)
    .map((entry, index) => ({ name: entry.name, color: slotColor(index) }));
}

function readReplaces(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new Error("replaces must name an existing classification.");
  }
  return name;
}

/**
 * Checks a card label write against its board palette. Labels the card already
 * carried and system labels pass unchanged. Every other label reuses a matching
 * slot (taking its spelling), fills a free slot, or, on a full palette, overwrites
 * the slot named by `replaces`. Anything else is refused, never silently dropped.
 */
export function applyWorkboardCardClassifications(params: {
  boardId: string;
  palette: readonly WorkboardClassification[];
  previousLabels: readonly string[];
  labels: readonly string[];
  replaces: unknown;
}): { labels: string[]; change: WorkboardClassificationChange; changed: boolean } {
  const { boardId } = params;
  const palette = params.palette.map((entry) => ({ ...entry }));
  const replaces = readReplaces(params.replaces);
  const target =
    replaces === undefined
      ? undefined
      : palette.find((entry) => classificationKey(entry.name) === classificationKey(replaces));
  if (replaces !== undefined && !target) {
    throw new Error(
      `replaces "${replaces}" is not a classification on board "${boardId}". Current classifications: ${describeWorkboardClassifications(palette)}.`,
    );
  }
  const previous = new Set(params.previousLabels.map(classificationKey));
  const added: string[] = [];
  let replaced: WorkboardClassificationChange["replaced"];
  const labels: string[] = [];
  for (const label of params.labels) {
    const key = classificationKey(label);
    const known = palette.find((entry) => classificationKey(entry.name) === key);
    const next = previous.has(key) || isWorkboardSystemLabel(label) ? label : known?.name;
    if (next !== undefined) {
      if (!labels.includes(next)) {
        labels.push(next);
      }
      continue;
    }
    if (palette.length < MAX_WORKBOARD_CLASSIFICATIONS) {
      palette.push({ name: label, color: slotColor(palette.length) });
      added.push(label);
    } else if (target && !replaced) {
      // The slot keeps its position and color; only the name changes.
      replaced = { name: target.name, by: label };
      palette[palette.indexOf(target)] = { name: label, color: target.color };
    } else {
      throw new Error(
        `Board "${boardId}" already has ${MAX_WORKBOARD_CLASSIFICATIONS} classifications: ${describeWorkboardClassifications(palette)}. Reuse one of them for "${label}", or pass replaces with the classification "${label}" should overwrite${replaced ? " (one replacement per write)" : ""}.`,
      );
    }
    labels.push(label);
  }
  if (replaces !== undefined && !replaced) {
    throw new Error(
      `replaces "${replaces}" was not used: it only applies when a new classification meets a full palette (${MAX_WORKBOARD_CLASSIFICATIONS}/${MAX_WORKBOARD_CLASSIFICATIONS}). Board "${boardId}" has ${palette.length}; drop replaces.`,
    );
  }
  return {
    labels,
    change: { boardId, classifications: palette, added, ...(replaced ? { replaced } : {}) },
    changed: added.length > 0 || replaced !== undefined,
  };
}
