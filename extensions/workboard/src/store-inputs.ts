import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardDiagnostic,
  WorkboardEvent,
  WorkboardInteractionSurface,
  WorkboardLaunchState,
  WorkboardResultEvidence,
  WorkboardWorkspace,
  WorkboardWorkspaceAccess,
} from "@openclaw/workboard-contract";
import type { WorkboardOwnerSlot } from "./persistence-types.js";
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
  ownedEvidence?: WorkboardResultEvidence[];
};
export type WorkboardUpdateCardOptions = {
  /**
   * Who makes the write, for the settle check in `updateCard`: the caller's scope, or
   * `null` for the operator and the system. A write that settles a pending result must
   * name one; see `assertCanSettlePendingResult`.
   */
  actor?: WorkboardMutationScope | null;
  automationLaunch?: WorkboardLaunchState;
  /** Replaces automation.evidence; built only by Workboard's evidence writers. */
  automationEvidence?: WorkboardResultEvidence[];
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
  ownerSlot?: WorkboardOwnerSlot;
  preserveProofId?: string;
  preserveNotificationId?: string;
  /**
   * Whether *this write* introduces review data, i.e. whether the review budget guard
   * applies. Resolved by `updateCard` from the patch via `reviewWrittenInPatch`, never
   * supplied by a caller: the metadata trims that run after `normalizeMetadata` have to
   * carry it too, or a later unguarded trim would still drop a comment or a proof to
   * make room for the review (R27/A9).
   */
  reviewWritten?: boolean;
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
export type WorkboardWorkerLogInput = Pick<WorkboardCardInput, "sessionKey" | "runId"> & {
  level?: unknown;
  message?: unknown;
};
export type WorkboardProtocolViolationInput = Pick<WorkboardCardInput, "sessionKey" | "runId"> & {
  detail?: unknown;
};
export type WorkboardClaimInput = WorkboardMutationScope & {
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
export type WorkboardHeartbeatInput = WorkboardMutationScope & {
  note?: unknown;
};
export type WorkboardBulkInput = {
  ids?: unknown;
  patch?: unknown;
  archived?: unknown;
};
export type WorkboardCompleteInput = WorkboardMutationScope & {
  summary?: unknown;
  proof?: unknown;
  proofId?: unknown;
  artifacts?: unknown;
  createdCardIds?: unknown;
  /** Optional worker claims; never required and never checked before completion. */
  claims?: unknown;
};
export type WorkboardVerifyInput = {
  scope?: unknown;
  outcome?: unknown;
  claimId?: unknown;
  proofId?: unknown;
  artifactId?: unknown;
  runId?: unknown;
  note?: unknown;
  url?: unknown;
};
export type WorkboardBlockInput = WorkboardMutationScope & {
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
export type WorkboardReclaimInput = Pick<WorkboardReassignInput, "status" | "reason">;
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
export type WorkboardNotificationSubscribeInput = WorkboardNotificationListOptions & {
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
  /** Host run id of the calling agent turn; refuses writes from a superseded attempt. */
  runId?: unknown;
};

export type WorkboardDiagnosticsResult = {
  diagnostics: Array<{
    card: WorkboardCard;
    diagnostics: WorkboardDiagnostic[];
  }>;
  count: number;
};
