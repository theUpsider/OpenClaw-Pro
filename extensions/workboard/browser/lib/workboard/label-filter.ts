import type { WorkboardCard } from "./types.ts";

export type WorkboardLabelOption = {
  value: string;
  label: string;
  count: number;
};

// Labels are free text, so "Bug" and "bug" are one facet value. The key is the
// lowercased trimmed label; the option shows the first spelling seen.
function labelKey(label: string): string {
  return label.trim().toLocaleLowerCase();
}

/**
 * Options come from the given cards. Selected labels stay listed with a zero
 * count so they remain visible and clearable when other filters hide them.
 */
export function buildWorkboardLabelOptions(
  cards: readonly WorkboardCard[],
  selected: ReadonlySet<string> = new Set(),
): WorkboardLabelOption[] {
  const options = new Map<string, WorkboardLabelOption>();
  for (const card of cards) {
    const seen = new Set<string>();
    for (const label of card.labels) {
      const value = labelKey(label);
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      const option = options.get(value);
      if (option) {
        option.count += 1;
      } else {
        options.set(value, { value, label: label.trim(), count: 1 });
      }
    }
  }
  for (const value of selected) {
    if (!options.has(value)) {
      options.set(value, { value, label: value, count: 0 });
    }
  }
  return [...options.values()].toSorted((left, right) => left.label.localeCompare(right.label));
}

/** OR within the facet: a card matches when it carries any selected label key. */
export function matchesLabelFilter(card: WorkboardCard, values: ReadonlySet<string>): boolean {
  return !values.size || card.labels.some((label) => values.has(labelKey(label)));
}
