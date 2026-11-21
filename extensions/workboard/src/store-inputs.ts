import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardDiagnostic,
  WorkboardEvent,
  WorkboardInteractionSurface,
  WorkboardLaunchState,
  WorkboardWorkspace,
  WorkboardWorkspaceAccess,
} from "@openclaw/workboard-contract";
import type { WorkboardClassificationChange } from "./classification-palette.js";

type WorkboardCardInput = {
  title?: unknown;
  notes?: unknown;
  status?: unknown;
  priority?: unknown;
  labels?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  sourceUrl?: unknown;
  execution?: unknown;
  metadata?: unknown;
  templateId?: unknown;
  position?: unknown;
  tenant?: unknown;
  boardId?: unknown;
  createdByCardId?: unknown;
  idempotencyKey?: unknown;
  skills?: unknown;
  workspace?: unknown;
  /** Trusted mutation provenance; not accepted from public tool schemas. */
  workspaceAccess?: unknown;
  maxRuntimeSeconds?: unknown;
  maxRetries?: unknown;
  /** Opt-in marker for parallel dispatch; only `true` counts. */
  parallelizable?: unknown;
  /** Owner slot ceiling for opt-in cards; defaults to 1. */
  maxConcurrentPerOwner?: unknown;
  /** Opt-in placement owner: `native` (default) or `external`. */
  dispatchMode?: unknown;
  scheduledAt?: unknown;
  /** Decision picker choices; stored in `metadata.automation`, `[]` clears them. */
  decisionOptions?: unknown;
  /** One line naming what the operator must supply; `""` clears it. */
  ask?: unknown;
  /** Why the card waits on the operator: `input` or `external`; unknown values are refused. */
  askKind?: unknown;
  /** Control UI marks an automatically completed card as seen when it is opened. */
  acceptanceSeenAt?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  parents?: unknown;
  /** Classification a new label overwrites when the board palette is full. */
  replaces?: unknown;
};

export type WorkboardCardPatch = WorkboardCardInput;
/** Internal builders carry launch state separately from untrusted metadata. */
export type WorkboardOwnedCardPatch = WorkboardCardPatch & {
  ownedLaunch?: WorkboardLaunchState;
};
export type WorkboardUpdateCardOptions = {
  /**
   * Who makes the write, for the settle check in `updateCard`: the caller's scope, or
   * `null` for the operator and the system. A write that settles a pending result must
   * name one; see `assertCanSettlePendingResult`.
   */
  actor?: WorkboardMutationScope | null;
  automationLaunch?: WorkboardLaunchState;
  allowMetadataDependencyLinks?: boolean;
  enforceStatusHolds?: boolean;
  event?: Omit<WorkboardEvent, "id" | "at">;
  eventAt?: number;
  /** Agent recorded on the appended event; attribution only, never authority. */
  agentId?: string;
  /**
   * Card-bound interaction to stamp into the card metadata; reference data only,
   * never authority, and never an execution link. See `WorkboardMutationScope`.
   */
  interaction?: WorkboardInteractionStamp;
  expectedUpdatedAt?: number;
  ownerSlot?: { ownerId: string; now: number };
  preserveProofId?: string;
  preserveNotificationId?: string;
  onClassifications?: (change: WorkboardClassificationChange) => void;
};
export type WorkboardCommentInput = { body?: unknown };
export type WorkboardLinkInput = {
  type?: unknown;
  targetCardId?: unknown;
  title?: unknown;
  url?: unknown;
};
export type WorkboardLinkedCreateInput = WorkboardCardInput;
export type WorkboardProofInput = {
  status?: unknown;
  label?: unknown;
  command?: unknown;
  url?: unknown;
  note?: unknown;
};
export type WorkboardArtifactInput = {
  label?: unknown;
  url?: unknown;
  path?: unknown;
  mimeType?: unknown;
};
export type WorkboardAttachmentInput = {
  fileName?: unknown;
  contentBase64?: unknown;
  mimeType?: unknown;
  note?: unknown;
};
export type WorkboardWorkerLogInput = {
  level?: unknown;
  message?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
};
export type WorkboardProtocolViolationInput = {
  detail?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
};
export type WorkboardClaimInput = {
  ownerId?: unknown;
  token?: unknown;
  ttlSeconds?: unknown;
};
export type WorkboardClaimOptions = {
  assertOwnerCurrent?: () => void;
  /** Trusted dispatcher guard; never accepted from public tool or gateway input. */
  expectedAuthority?: {
    boardId: string;
    status: WorkboardCard["status"];
    agentId?: string;
    /** Placement owner the dispatcher selected the card under; a native start never claims otherwise. */
    externallyDispatched?: boolean;
    workspace?: WorkboardWorkspace;
    workspaceAccess?: WorkboardWorkspaceAccess;
  };
  /** Trusted legacy-card adoption; applied only while expectedAuthority still matches. */
  adoptWorkspaceAccess?: WorkboardWorkspaceAccess;
};
export type WorkboardHeartbeatInput = {
  token?: unknown;
  ownerId?: unknown;
  note?: unknown;
};
export type WorkboardBulkInput = {
  ids?: unknown;
  patch?: unknown;
  archived?: unknown;
};
export type WorkboardCompleteInput = {
  ownerId?: unknown;
  token?: unknown;
  summary?: unknown;
  proof?: unknown;
  proofId?: unknown;
  artifacts?: unknown;
  createdCardIds?: unknown;
};
export type WorkboardBlockInput = {
  ownerId?: unknown;
  token?: unknown;
  reason?: unknown;
  /** Choices the blocked card offers the operator; omitted keeps the stored ones. */
  decisionOptions?: unknown;
  /** One line naming what the operator must supply; `""` clears it. */
  ask?: unknown;
  /** Why the card waits on the operator: `input` or `external`; unknown values are refused. */
  askKind?: unknown;
};
export type WorkboardDispatchResult = {
  promoted: WorkboardCard[];
  reclaimed: WorkboardCard[];
  blocked: WorkboardCard[];
  orchestrated: WorkboardCard[];
  count: number;
};
/** A card a dispatch pass left in its owner's lane queue because the slot is full; not a failure. */
export type WorkboardDispatchSkip = {
  cardId: string;
  title: string;
  ownerId: string;
  reason: "owner_busy";
};
export type WorkboardListOptions = {
  boardId?: unknown;
};
export type WorkboardDispatchOptions = WorkboardListOptions & {
  now?: unknown;
  assertOwnerCurrent?: () => void;
};
export type WorkboardStatsResult = WorkboardBoardSummary & {
  byAgent: Record<string, number>;
  oldestReadyAgeMs?: number;
};
export type WorkboardPromoteInput = {
  force?: unknown;
  reason?: unknown;
};
export type WorkboardReassignInput = {
  agentId?: unknown;
  status?: unknown;
  resetFailures?: unknown;
  reason?: unknown;
};
export type WorkboardReclaimInput = {
  status?: unknown;
  reason?: unknown;
};
export type WorkboardBoardInput = {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  color?: unknown;
  clearAppearance?: unknown;
  automationJobId?: unknown;
  defaultWorkspace?: unknown;
  orchestration?: unknown;
  archived?: unknown;
};
export type WorkboardSpecifyInput = WorkboardCardPatch & {
  summary?: unknown;
};
export type WorkboardDecomposeInput = {
  summary?: unknown;
  children?: unknown;
  completeParent?: unknown;
};
export type WorkboardNotificationSubscribeInput = {
  boardId?: unknown;
  cardId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  target?: unknown;
  eventKinds?: unknown;
};
export type WorkboardNotificationListOptions = {
  boardId?: unknown;
  cardId?: unknown;
};
export type WorkboardNotificationEventsInput = WorkboardNotificationListOptions & {
  subscriptionId?: unknown;
  limit?: unknown;
};
export type WorkboardMutationScope = {
  ownerId?: unknown;
  token?: unknown;
  /** Server-resolved calling agent, recorded on the event; claim checks ignore it. */
  agentId?: string;
  /**
   * Server-resolved card-bound interaction (session key, agent, surface) that
   * `updateCard` merges into the card metadata; claim checks and gates ignore it.
   */
  interaction?: WorkboardInteractionStamp;
};

/** One turn's interaction link; `at` is the turn time the store stamps as `updatedAt`. */
export type WorkboardInteractionStamp = {
  sessionKey: string;
  agentId?: string;
  at: number;
  surface?: WorkboardInteractionSurface;
};

export type WorkboardDiagnosticsResult = {
  diagnostics: Array<{
    card: WorkboardCard;
    diagnostics: WorkboardDiagnostic[];
  }>;
  count: number;
};
