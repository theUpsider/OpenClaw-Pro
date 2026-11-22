import type { WorkboardSessionsBoardSpec } from "./sessions-board.js";

export type WorkboardDatabasePortApi<Database, Input> = {
  inspectWorkboardPortSource(db: Database): {
    version: number;
    migrationRequired: boolean;
    pendingColumns: Record<string, string[]>;
  };
  admitWorkboardPort(dbPath: string, input?: Input): void;
  WorkboardPortSchemaError: new (message?: string) => Error;
};

export const WORKBOARD_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export const WORKBOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
/** Built-in launch choices. Persisted execution engines remain an open runtime identifier. */
export const WORKBOARD_EXECUTION_ENGINES = ["codex", "claude"] as const;
export const WORKBOARD_EXECUTION_MODES = ["autonomous", "manual"] as const;
/** Who owns a card's placement and transport. Omitted means `native`. */
export const WORKBOARD_DISPATCH_MODES = ["native", "external"] as const;
/**
 * Why a card waits on the operator. The multiple-choice `decision` label stays the
 * single owner of "this is a decision", so it is deliberately not a value here.
 */
export const WORKBOARD_OPERATOR_ASK_KINDS = ["input", "external"] as const;
export const WORKBOARD_EXECUTION_STATUSES = [
  "idle",
  "running",
  "review",
  "blocked",
  "done",
] as const;
export const WORKBOARD_EVENT_KINDS = [
  "created",
  "edited",
  "moved",
  "linked",
  "specified",
  "decomposed",
  "claimed",
  "heartbeat",
  "execution_updated",
  "attempt_started",
  "attempt_updated",
  "comment_added",
  "link_added",
  "unlinked",
  "proof_added",
  "artifact_added",
  "attachment_added",
  "diagnostic",
  "notification",
  "dispatch",
  "orchestration",
  "protocol_violation",
  "archived",
  "unarchived",
  "stale",
] as const;
export const WORKBOARD_ATTEMPT_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "blocked",
  "stopped",
] as const;
export const WORKBOARD_LINK_TYPES = [
  "parent",
  "child",
  "blocks",
  "blocked_by",
  "relates_to",
] as const;
export const WORKBOARD_PROOF_STATUSES = ["passed", "failed", "skipped", "unknown"] as const;
export const WORKBOARD_TEMPLATE_IDS = ["bugfix", "docs", "release", "pr_review", "plugin"] as const;
export const WORKBOARD_DIAGNOSTIC_KINDS = [
  "stranded_ready",
  "running_without_heartbeat",
  "blocked_too_long",
  "repeated_failures",
  "missing_proof",
  "orphaned_session",
  "archived_but_active",
  "awaiting_acceptance",
] as const;
export const WORKBOARD_DIAGNOSTIC_SEVERITIES = ["warning", "error", "critical"] as const;
export const WORKBOARD_NOTIFICATION_KINDS = ["completed", "failed", "stale"] as const;
export const WORKBOARD_BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function isValidWorkboardBoardId(value: unknown): value is string {
  return typeof value === "string" && WORKBOARD_BOARD_ID_PATTERN.test(value);
}

export type WorkboardDeleteResult = {
  deleted: boolean;
  referenceUpdates?: Array<{ id: string; previousUpdatedAt: number; updatedAt: number }>;
};

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];
export type WorkboardExecutionEngine = string;
export type WorkboardExecutionMode = (typeof WORKBOARD_EXECUTION_MODES)[number];
export type WorkboardDispatchMode = (typeof WORKBOARD_DISPATCH_MODES)[number];
export type WorkboardOperatorAskKind = (typeof WORKBOARD_OPERATOR_ASK_KINDS)[number];
export type WorkboardExecutionStatus = (typeof WORKBOARD_EXECUTION_STATUSES)[number];
export type WorkboardEventKind = (typeof WORKBOARD_EVENT_KINDS)[number];
export type WorkboardAttemptStatus = (typeof WORKBOARD_ATTEMPT_STATUSES)[number];
export type WorkboardLinkType = (typeof WORKBOARD_LINK_TYPES)[number];
export type WorkboardProofStatus = (typeof WORKBOARD_PROOF_STATUSES)[number];
export type WorkboardTemplateId = (typeof WORKBOARD_TEMPLATE_IDS)[number];
export type WorkboardDiagnosticKind = (typeof WORKBOARD_DIAGNOSTIC_KINDS)[number];
export type WorkboardDiagnosticSeverity = (typeof WORKBOARD_DIAGNOSTIC_SEVERITIES)[number];
export type WorkboardNotificationKind = (typeof WORKBOARD_NOTIFICATION_KINDS)[number];

/** Surface a card's interaction session runs on; see {@link WorkboardInteraction}. */
export const WORKBOARD_INTERACTION_SURFACES = ["plugin-dock", "chat"] as const;
export type WorkboardInteractionSurface = (typeof WORKBOARD_INTERACTION_SURFACES)[number];

export type WorkboardExecution = {
  id: string;
  kind: "agent-session";
  engine?: WorkboardExecutionEngine;
  mode: WorkboardExecutionMode;
  status: WorkboardExecutionStatus;
  model?: string;
  sessionKey?: string;
  runId?: string;
  startedAt: number;
  updatedAt: number;
};

export type WorkboardEvent = {
  id: string;
  kind: WorkboardEventKind;
  at: number;
  fromStatus?: WorkboardStatus;
  toStatus?: WorkboardStatus;
  sessionKey?: string;
  runId?: string;
  /** Agent whose tool call caused the change, from the server tool context; absent when unknown. */
  agentId?: string;
};

/**
 * The session that is editing a card: a card-bound dictation or chat turn, recorded
 * from the server tool context so surfaces can name it. Reference data only, never
 * authority - the same posture as the voice board binding: it grants no permissions,
 * gates no write, and is never read as an execution link. Execution stays
 * `WorkboardCard.sessionKey` / `WorkboardCard.execution`.
 */
export type WorkboardInteraction = {
  sessionKey: string;
  agentId?: string;
  /** First turn of the interaction. */
  startedAt: number;
  /** Last turn (heartbeat). */
  updatedAt: number;
  surface?: WorkboardInteractionSurface;
};

/** Resolutions an annotation can record on its own; see {@link WorkboardReviewAnnotation}. */
export const WORKBOARD_REVIEW_RESOLUTIONS = [
  "accepted",
  "changed",
  "rejected",
  "deferred",
  "answered",
] as const;
export type WorkboardReviewResolution = (typeof WORKBOARD_REVIEW_RESOLUTIONS)[number];

/** The four allowed overall verdicts; anything else is refused, never defaulted (R16). */
export const WORKBOARD_REVIEW_VERDICT_VALUES = ["accept", "rework", "reject", "hold"] as const;
export type WorkboardReviewVerdictValue = (typeof WORKBOARD_REVIEW_VERDICT_VALUES)[number];

/** Where an annotation sits in its document. Own family, not in WorkboardComment. */
export type WorkboardReviewAnchor =
  | { kind: "pdf-rect"; page: number; rect: [number, number, number, number] }
  | { kind: "text-quote"; quote: string; hash: string; page?: number }
  | { kind: "text-range"; start: number; end: number; hash: string };

/** One annotation with its own resolution. */
export type WorkboardReviewAnnotation = {
  id: string;
  /** Attachment/artifact id the anchor refers to. */
  documentRef: string;
  anchor: WorkboardReviewAnchor;
  body: string;
  /** "operator" or an agent identifier. */
  author: string;
  createdAt: number;
  /** "Resolved" is its own time, never a status change. */
  resolvedAt?: number;
  resolution?: WorkboardReviewResolution;
};

/** The overall verdict - one record, never a status. */
export type WorkboardReviewVerdict = {
  verdict: WorkboardReviewVerdictValue;
  note?: string;
  decidedAt: number;
  /** Identity of the decider (R15). */
  decidedBy: string;
  /** What was still open when the verdict fell (R14). */
  unresolvedAnnotationIds: readonly string[];
  /** Ref -> source hash (R17). */
  documentHashes: Record<string, string>;
};

/**
 * The review case a card carries: its annotated documents, each annotation with its own
 * resolution, and one overall verdict that names what was still open. Its own field
 * family (`metadata.review` -> `review_json`), so `WorkboardComment` and
 * `WorkboardAttachment` stay unchanged (R25).
 */
export type WorkboardReviewSession = {
  id: string;
  cardId: string;
  /** Empty reads back as absent, the same shape the neighbouring list members use. */
  documents?: Array<{ ref: string; label: string; sourceHash: string }>;
  annotations?: WorkboardReviewAnnotation[];
  overall?: WorkboardReviewVerdict;
};

export type WorkboardRunAttempt = {
  id: string;
  status: WorkboardAttemptStatus;
  startedAt: number;
  endedAt?: number;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  model?: string;
  sessionKey?: string;
  runId?: string;
  error?: string;
};

export type WorkboardComment = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
};

export type WorkboardLink = {
  id: string;
  type: WorkboardLinkType;
  createdAt: number;
  targetCardId?: string;
  title?: string;
  url?: string;
};

export type WorkboardProof = {
  id: string;
  status: WorkboardProofStatus;
  createdAt: number;
  label?: string;
  command?: string;
  url?: string;
  note?: string;
};

export type WorkboardArtifact = {
  id: string;
  createdAt: number;
  label?: string;
  url?: string;
  path?: string;
  mimeType?: string;
};

export type WorkboardAttachment = {
  id: string;
  cardId: string;
  createdAt: number;
  fileName: string;
  byteSize: number;
  mimeType?: string;
  note?: string;
};

export type WorkboardWorkerLog = {
  id: string;
  createdAt: number;
  level: "info" | "warning" | "error";
  message: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardWorkerProtocol = {
  state: "idle" | "running" | "completed" | "blocked" | "violated";
  updatedAt: number;
  detail?: string;
};

export type WorkboardStaleState = {
  detectedAt: number;
  lastSessionUpdatedAt?: number;
  reason: string;
};

export type WorkboardClaim = {
  ownerId: string;
  token: string;
  claimedAt: number;
  lastHeartbeatAt: number;
  expiresAt?: number;
};

export type WorkboardDiagnosticAction = {
  kind: "claim" | "unblock" | "promote" | "reclaim" | "reassign" | "add_proof" | "open_session";
  label: string;
};

export type WorkboardDiagnostic = {
  kind: WorkboardDiagnosticKind;
  severity: WorkboardDiagnosticSeverity;
  title: string;
  detail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  actions: WorkboardDiagnosticAction[];
};

export type WorkboardNotification = {
  id: string;
  kind: WorkboardNotificationKind;
  createdAt: number;
  sequence?: number;
  message: string;
  sessionKey?: string;
  runId?: string;
};

export const WORKBOARD_CHANGED_EVENT = "plugin.workboard.changed";

export type WorkboardChange = {
  epoch: string;
  revision: number;
  cardsRevision?: number;
  sessionsRevision?: number;
};

export type WorkboardWorkspace = {
  kind: "scratch" | "dir" | "worktree";
  path?: string;
  branch?: string;
  sourcePath?: string;
  sourceBranch?: string;
};

export type WorkboardWorkspaceAccess =
  | { unrestricted: true }
  | { unrestricted: false; roots: string[]; writable: boolean };

type WorkboardLaunchIdentity = {
  requestedSessionKey: string;
  provisionalRunId: string;
  preparedAt: number;
};

export type WorkboardLaunchState =
  | (WorkboardLaunchIdentity & { phase: "prepared" })
  | (WorkboardLaunchIdentity & {
      phase: "accepted";
      acceptedAt: number;
      acceptedSessionKey: string;
      acceptedRunId?: string;
    })
  | (WorkboardLaunchIdentity & {
      phase: "failed";
      failedAt: number;
      reason: string;
    });

export type WorkboardAutomation = {
  tenant?: string;
  boardId?: string;
  createdByCardId?: string;
  idempotencyKey?: string;
  skills?: string[];
  workspace?: WorkboardWorkspace;
  workspaceAccess?: WorkboardWorkspaceAccess;
  maxRuntimeSeconds?: number;
  maxRetries?: number;
  /**
   * Opt-in marker for running this card alongside other cards of the same owner.
   * Default off: cards without it keep the historical single owner slot.
   */
  parallelizable?: boolean;
  /**
   * Maximum concurrent cards for the card's owner when `parallelizable` is on.
   * Defaults to 1, so unmarked cards behave exactly as before.
   */
  maxConcurrentPerOwner?: number;
  /**
   * Who owns placement and transport for this card. Absent means `native`: the
   * local dispatcher claims the card and starts the worker run itself.
   * `external` cards are owned by an external controller that claims, heartbeats,
   * and completes them; the local dispatcher never claims or starts them, though
   * dependency promotion and claim cleanup still run for them.
   */
  dispatchMode?: WorkboardDispatchMode;
  scheduledAt?: number;
  summary?: string;
  createdCardIds?: string[];
  dispatchCount?: number;
  lastDispatchAt?: number;
  launch?: WorkboardLaunchState;
  /**
   * The worker reported completion and the card waits in `review` until someone
   * moves it to `done`. Any manual status change away from `review` clears it.
   */
  awaitingAcceptance?: boolean;
  /** When the worker reported completion with `workboard_complete`. */
  autoCompletedAt?: number;
  /**
   * Who reported that completion. Only a different owner, or the operator, can
   * accept it; the same owner completing again keeps the card in `review`, and
   * its own status writes to `done` are refused.
   */
  autoCompletedBy?: string;
  /** When the operator first opened the card after that automatic completion. */
  acceptanceSeenAt?: number;
  /**
   * A Gateway restart tombstoned the linked session and no replacement started, so
   * lifecycle sync blocked the card. Cleared when the card leaves `blocked`.
   */
  restartTombstone?: { sessionKey: string; detectedAt: number };
  /**
   * Complete lifecycle sweeps no longer found the linked session. The first miss is
   * recorded; a second consecutive miss blocks the card once without claiming the
   * run ended. Cleared when the session reappears first or the card leaves `blocked`.
   */
  danglingSession?: { sessionKey: string; runId?: string; detectedAt: number; misses: number };
  /**
   * Choices a blocked decision card offers the operator as a numbered picker. The
   * number is the list index; at most one `recommended` takes effect (the first).
   */
  decisionOptions?: WorkboardDecisionOption[];
  /**
   * One line naming what the operator must supply before work continues. Stored in
   * `metadata.automation` like its neighbours; absent leaves it unchanged and `""`
   * clears it. The write rule lives in `workboardOperatorAskKind`'s module so the
   * server refuses and the Control UI shows the same bound.
   */
  ask?: string;
  /**
   * Why the card waits on the operator: `input` when an answer is needed, `external`
   * when it waits on something outside the board. Unknown values are refused at the
   * tool boundary. A multiple-choice decision stays the `decision` label's job, so a
   * card is never decidable by two fields.
   */
  askKind?: WorkboardOperatorAskKind;
};

/** One answer the operator can pick on a decision card; the shape of `ask_user` options. */
export type WorkboardDecisionOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

/** Bounds shared by store normalization, the agent tool schemas, and the browser picker. */
export const WORKBOARD_DECISION_OPTION_LIMITS = {
  min: 2,
  max: 6,
  labelMax: 64,
  descriptionMax: 240,
} as const;

/** Named session colors; the Control UI resolves each id to its `--session-color-*` token. */
export const WORKBOARD_CLASSIFICATION_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

export type WorkboardClassificationColor = (typeof WORKBOARD_CLASSIFICATION_COLORS)[number];

/** One slot of a board's closed classification palette; the name is the identity. */
export type WorkboardClassification = {
  name: string;
  color: WorkboardClassificationColor;
};

export type WorkboardBoardMetadata = {
  id: string;
  kind?: "cards" | "sessions";
  sessions?: WorkboardSessionsBoardSpec;
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  automationJobId?: string;
  defaultWorkspace?: WorkboardWorkspace;
  orchestration?: WorkboardOrchestrationSettings;
  /**
   * Closed label vocabulary of a cards board, at most 10 entries. Absent until the
   * board is seeded from its existing card labels; an empty array is a seeded board.
   */
  classifications?: WorkboardClassification[];
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
};

export type WorkboardBoardSummary = Omit<WorkboardBoardMetadata, "createdAt" | "updatedAt"> & {
  total: number;
  active: number;
  archived: number;
  byStatus: Partial<Record<WorkboardStatus, number>>;
  updatedAt?: number;
};

/**
 * `workboard.cards.draft` answer: New card form fields drafted from one utterance.
 * An absent field means the utterance did not state it; nothing is stored.
 */
export type WorkboardCardDraft = {
  title?: string;
  notes?: string;
  status?: WorkboardStatus;
  priority?: WorkboardPriority;
  labels?: string[];
  agentId?: string;
};

export type WorkboardCardDraftResult = {
  draft: WorkboardCardDraft;
  /** Short plain-text notes about values that were left out or shortened. */
  hints: string[];
};

export type WorkboardOrchestrationSettings = {
  autoDecompose?: boolean;
  autoDecomposePerDispatch?: number;
  defaultAssignee?: string;
  orchestratorProfile?: string;
};

export type WorkboardNotificationSubscription = {
  id: string;
  boardId: string;
  cardId?: string;
  sessionKey?: string;
  runId?: string;
  target?: string;
  eventKinds?: WorkboardNotificationKind[];
  lastEventAt?: number;
  lastEventId?: string;
  lastEventSequence?: number;
  deliveredEventIds?: string[];
  createdAt: number;
  updatedAt: number;
};

export type WorkboardMetadata = {
  attempts?: WorkboardRunAttempt[];
  comments?: WorkboardComment[];
  links?: WorkboardLink[];
  proof?: WorkboardProof[];
  artifacts?: WorkboardArtifact[];
  attachments?: WorkboardAttachment[];
  workerLogs?: WorkboardWorkerLog[];
  workerProtocol?: WorkboardWorkerProtocol;
  automation?: WorkboardAutomation;
  claim?: WorkboardClaim;
  diagnostics?: WorkboardDiagnostic[];
  notifications?: WorkboardNotification[];
  templateId?: WorkboardTemplateId;
  archivedAt?: number;
  stale?: WorkboardStaleState;
  lifecycleStatusSourceUpdatedAt?: number;
  failureCount?: number;
  /**
   * Session whose turn last edited this card. Reference data only, never authority:
   * same posture as the voice board binding, and never an execution link.
   */
  interaction?: WorkboardInteraction;
  /**
   * Review case carried by the card: annotated documents, per-annotation resolutions, and
   * one verdict that names what was open when it fell. One record per card; a write that
   * carries it replaces it wholesale, and every write passes the store's review rules.
   */
  review?: WorkboardReviewSession;
};

export type WorkboardCard = {
  id: string;
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  sourceUrl?: string;
  execution?: WorkboardExecution;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  events?: WorkboardEvent[];
  metadata?: WorkboardMetadata;
};

export type WorkboardListResult = {
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
};
export {
  createDefaultWorkboardSessionsBoardSpec,
  normalizeWorkboardSessionsBoardSpec,
  patchWorkboardSessionsBoardSpec,
} from "./sessions-board.js";
export type {
  WorkboardSessionFacts,
  WorkboardSessionPlacement,
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
  WorkboardSessionsBoardRevision,
  WorkboardSessionsBoardSpec,
  WorkboardSessionsBoardView,
  WorkboardSessionsColumn,
  WorkboardSessionsColumnMatch,
  WorkboardSessionsObserverHealth,
} from "./sessions-board.js";
