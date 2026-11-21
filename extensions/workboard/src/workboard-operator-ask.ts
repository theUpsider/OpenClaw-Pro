// One owner for "does this card wait on the operator, and why". Pure on purpose: no
// store, no DOM, no plugin runtime, so the Control UI reads the same predicate and the
// same bound the server validates with (the UI imports it through this module instead
// of re-deriving the rule, just as `browser/lib/workboard/lane-queue.ts` reads
// `store-constants.ts`).
import {
  WORKBOARD_OPERATOR_ASK_KINDS,
  type WorkboardCard,
  type WorkboardMetadata,
  type WorkboardOperatorAskKind,
} from "@openclaw/workboard-contract";

export { WORKBOARD_OPERATOR_ASK_KINDS };
export type { WorkboardOperatorAskKind };

/** Length bound of the agent's one-line `ask`, shared by the store rule and the tools. */
export const WORKBOARD_ASK_MAX_LENGTH = 120;

/**
 * The label that owns "this is a multiple-choice decision" (same value as
 * `WORKBOARD_DECISION_LABEL` in `browser/lib/workboard/waiting-reason.ts`, which keeps
 * its own copy for its existing readers). Never a value of the blocker kind: a card
 * must not be decidable through two different fields.
 */
export const WORKBOARD_OPERATOR_ASK_DECISION_LABEL = "decision";

/** Every reason a card can wait on the operator: the label case plus the two kinds. */
export const WORKBOARD_OPERATOR_ASK_REASONS = [
  "decision",
  ...WORKBOARD_OPERATOR_ASK_KINDS,
] as const;
export type WorkboardOperatorAskReason = (typeof WORKBOARD_OPERATOR_ASK_REASONS)[number];

function hasDecisionLabel(label: string): boolean {
  return label.trim().toLowerCase() === WORKBOARD_OPERATOR_ASK_DECISION_LABEL;
}

/** True for stored ask text that stays short and on one line. */
export function isWorkboardAskText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= WORKBOARD_ASK_MAX_LENGTH &&
    !/[\r\n]/.test(value)
  );
}

/**
 * The one `ask` write rule. A string is trimmed; empty (or absent/null) clears the
 * field. Over-long text and line breaks are refused with the limit named, never
 * silently truncated, so the acting tool reports a fixable error.
 */
export function normalizeWorkboardAsk(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(
      `ask must be a single line of ${WORKBOARD_ASK_MAX_LENGTH} characters or fewer (got ${typeof value}).`,
    );
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `ask must be a single line without line breaks (at most ${WORKBOARD_ASK_MAX_LENGTH} characters).`,
    );
  }
  const ask = value.trim();
  if (!ask) {
    return undefined;
  }
  if (ask.length > WORKBOARD_ASK_MAX_LENGTH) {
    throw new Error(
      `ask must be ${WORKBOARD_ASK_MAX_LENGTH} characters or fewer (got ${ask.length}).`,
    );
  }
  return ask;
}

/** The one blocker-kind write rule; an unknown value is refused, never dropped. */
export function normalizeWorkboardAskKind(value: unknown): WorkboardOperatorAskKind | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !WORKBOARD_OPERATOR_ASK_KINDS.includes(value as WorkboardOperatorAskKind)
  ) {
    throw new Error(`askKind must be one of: ${WORKBOARD_OPERATOR_ASK_KINDS.join(", ")}.`);
  }
  return value as WorkboardOperatorAskKind;
}

function storedAskKind(
  metadata: WorkboardMetadata | undefined,
): WorkboardOperatorAskKind | undefined {
  const kind = metadata?.automation?.askKind;
  return kind && WORKBOARD_OPERATOR_ASK_KINDS.includes(kind) ? kind : undefined;
}

/**
 * The single answer to "does this card wait on the operator, and why". A `blocked` card
 * carrying the `decision` label answers `decision` (the label's semantics, unchanged, and
 * it wins over a stored kind so the multiple-choice picker stays the only owner of that
 * case). Otherwise the agent-declared `askKind` answers, or nothing when the card names
 * neither. A bare metadata object can only answer from the stored kind.
 */
export function workboardOperatorAskKind(
  cardOrMetadata: WorkboardCard | WorkboardMetadata | undefined,
): WorkboardOperatorAskReason | undefined {
  if (!cardOrMetadata) {
    return undefined;
  }
  if (isWorkboardCardLike(cardOrMetadata)) {
    return cardOrMetadata.status === "blocked" && cardOrMetadata.labels.some(hasDecisionLabel)
      ? "decision"
      : storedAskKind(cardOrMetadata.metadata);
  }
  return storedAskKind(cardOrMetadata);
}

/** A card carries `status` and `labels`; a bare metadata object carries neither. */
function isWorkboardCardLike(value: WorkboardCard | WorkboardMetadata): value is WorkboardCard {
  return "status" in value && "labels" in value;
}
