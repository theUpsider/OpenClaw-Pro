import type { WorkboardCard } from "@openclaw/workboard-contract";

export type WorkboardCardUpdatePatch = {
  priority?: unknown;
  labels?: string[];
  decisionOptions?: unknown;
  dispatchMode?: unknown;
  ask?: unknown;
  askKind?: unknown;
};

function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

function readLabels(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.map((entry: string) => entry.trim()).filter(Boolean);
}

/**
 * `workboard_update` patch. Labels are edited by name, case-insensitively,
 * against the card that was read, so the caller writes with that card's
 * `expectedUpdatedAt`. store.update owns priority validation and the label
 * caps. Removals apply before additions. Decision options replace the stored
 * list whole; `[]` clears it. A `dispatchMode` patch moves placement between the
 * local dispatcher and an external controller. `ask` replaces the operator question
 * whole (`""` clears it) and `askKind` says why the card waits.
 */
export function buildWorkboardCardUpdatePatch(
  card: Pick<WorkboardCard, "labels">,
  change: {
    priority?: unknown;
    labelsAdd?: unknown;
    labelsRemove?: unknown;
    decisionOptions?: unknown;
    dispatchMode?: unknown;
    ask?: unknown;
    askKind?: unknown;
  },
): WorkboardCardUpdatePatch {
  if (
    change.priority === undefined &&
    change.labelsAdd === undefined &&
    change.labelsRemove === undefined &&
    change.decisionOptions === undefined &&
    change.dispatchMode === undefined &&
    change.ask === undefined &&
    change.askKind === undefined
  ) {
    throw new Error(
      "Pass priority, labelsAdd, labelsRemove, decisionOptions, dispatchMode, ask, or askKind.",
    );
  }
  const patch: WorkboardCardUpdatePatch = {
    ...(change.priority === undefined ? {} : { priority: change.priority }),
    ...(change.decisionOptions === undefined ? {} : { decisionOptions: change.decisionOptions }),
    ...(change.dispatchMode === undefined ? {} : { dispatchMode: change.dispatchMode }),
    ...(change.ask === undefined ? {} : { ask: change.ask }),
    ...(change.askKind === undefined ? {} : { askKind: change.askKind }),
  };
  const removed = new Set(readLabels(change.labelsRemove, "labelsRemove").map(labelKey));
  const labels = card.labels.filter((label) => !removed.has(labelKey(label)));
  for (const label of readLabels(change.labelsAdd, "labelsAdd")) {
    if (!labels.some((existing) => labelKey(existing) === labelKey(label))) {
      labels.push(label);
    }
  }
  if (
    labels.length !== card.labels.length ||
    labels.some((label, index) => label !== card.labels[index])
  ) {
    patch.labels = labels;
  }
  return patch;
}
