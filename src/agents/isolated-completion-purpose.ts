/** Bounded internal diagnostic labels, independent of execution policy triggers. */
export type IsolatedCompletionPurpose =
  | "isolated-completion"
  | "goal-verification"
  | "session-activity-summary"
  | "session-observer"
  | "conversation-label"
  | "composer-prediction"
  | "progress-narration"
  | "transcript-summary"
  | "skill-diet"
  | "plugin-completion";
