import {
  WORKBOARD_DECISION_OPTION_LIMITS,
  type WorkboardCard,
  type WorkboardDecisionOption,
} from "./types.ts";
import { getWorkboardDecisionOptions } from "./waiting-reason.ts";

/**
 * The choices a decision card offers, and where they came from. `structured` options
 * were supplied by the agent (`metadata.automation.decisionOptions`) and may carry a
 * description and a recommendation; otherwise the notes' unchecked task items are
 * plain labels; otherwise there is nothing to pick and only the answer field shows.
 */
export type WorkboardDecisionChoices = {
  structured: boolean;
  options: WorkboardDecisionOption[];
};

export function resolveWorkboardDecisionOptions(card: WorkboardCard): WorkboardDecisionChoices {
  const { min, max } = WORKBOARD_DECISION_OPTION_LIMITS;
  const stored = card.metadata?.automation?.decisionOptions ?? [];
  if (stored.length >= min) {
    // The list order is the number; only the first recommendation counts.
    const recommended = stored.findIndex((option) => option.recommended);
    return {
      structured: true,
      options: stored.slice(0, max).map(({ label, description }, index) => {
        const choice: WorkboardDecisionOption = { label };
        if (description) {
          choice.description = description;
        }
        if (index === recommended) {
          choice.recommended = true;
        }
        return choice;
      }),
    };
  }
  return {
    structured: false,
    options: getWorkboardDecisionOptions(card).map((label) => ({ label })),
  };
}
