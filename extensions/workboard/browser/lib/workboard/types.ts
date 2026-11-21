import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardPriority,
  WorkboardStatus,
  WorkboardTemplateId,
} from "@openclaw/workboard-contract";
import type { GatewaySessionRow } from "../../api/types.ts";

export * from "@openclaw/workboard-contract";
export type { WorkboardBoardSummary } from "@openclaw/workboard-contract";

type WorkboardLifecycleState =
  | "unlinked"
  | "unknown"
  | "unavailable"
  | "ambiguous"
  | "idle"
  | "queued"
  | "running"
  | "stale"
  | "succeeded"
  | "failed";

export type WorkboardLifecycle = {
  session: GatewaySessionRow | null;
  state: WorkboardLifecycleState;
};

type WorkboardDependencyParent = {
  id: string;
  title: string;
  status?: WorkboardStatus;
  done: boolean;
  missing: boolean;
};

export type WorkboardDependencyState = {
  parents: WorkboardDependencyParent[];
  blockedParents: WorkboardDependencyParent[];
};

export type WorkboardDispatchSummary = {
  started: number;
  failures: number;
  queued: number;
  promoted: number;
  blocked: number;
  reclaimed: number;
  orchestrated: number;
};

export type WorkboardRefreshSource = "initial" | "manual" | "live";

export type WorkboardHealthKey = "stale" | "missingProof";

export type WorkboardBulkDialog =
  | { kind: "delete"; cardIds: string[]; observedCards: WorkboardCard[] }
  | {
      kind: "edit";
      cardIds: string[];
      observedCards: WorkboardCard[];
      priority: WorkboardPriority | "";
      agentId: string;
      labels: string;
      labelMode: "keep" | "add" | "replace" | "remove";
    };

export type WorkboardUiState = {
  loading: boolean;
  loaded: boolean;
  loadAttempted: boolean;
  mutationReadiness: "ready" | "canonical_reload_required" | "stale_edit_draft";
  error: string | null;
  cards: WorkboardCard[];
  boards: WorkboardBoardSummary[];
  statuses: readonly WorkboardStatus[];
  lastDispatchSummary: WorkboardDispatchSummary | null;
  dispatching: boolean;
  query: string;
  searchOpen: boolean;
  priorityFilter: Set<WorkboardPriority>;
  statusFilter: Set<WorkboardStatus>;
  attentionFilter: Set<WorkboardHealthKey>;
  labelFilter: Set<string>;
  donePeriod: "all" | "week";
  agentFilter: string;
  boardFilter: string;
  showArchived: boolean;
  /** "Needs you" lens: one ordered inbox of the cards waiting on the operator. */
  attentionInbox: boolean;
  /**
   * The lens shows the operator's own steps in full and the "no agent" rest as one collapsed
   * count row; this expands that row. Collapsed by default: housekeeping is not the operator's
   * step, so opening it is a deliberate act. View state only, never stored.
   */
  inboxUnownedExpanded: boolean;
  layout: "comfortable" | "compact";
  sort: "position" | "created" | "updated";
  viewMode: "board" | "list";
  emptyColumnMode: "show" | "collapse" | "hide";
  collapsedStatuses: Set<WorkboardStatus>;
  expandedEmptyStatuses: Set<WorkboardStatus>;
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
  draftOpen: boolean;
  draftDiscardOpen: boolean;
  draftSaving: boolean;
  editingCardId: string | null;
  editingCardBase: WorkboardCard | null;
  draftTitle: string;
  draftNotes: string;
  draftStatus: WorkboardStatus;
  draftPriority: WorkboardPriority;
  draftLabels: string;
  draftAgentId: string;
  draftSessionKey: string;
  draftTemplateId: WorkboardTemplateId | "";
  draftCommentBody: string;
  detailCardId: string | null;
  detailTab: "overview" | "activity" | "session" | "details";
  detailCommentBody: string;
  detailCommentDrafts: Map<string, string>;
  busyCardIds: Set<string>;
  selectedCardIds: Set<string>;
  bulkDialog: WorkboardBulkDialog | null;
  bulkSaving: boolean;
  bulkResult: { completed: number; total: number } | null;
  draggedCardId: string | null;
  dragOverStatus: WorkboardStatus | null;
  dragBeforeCardId: string | null;
};
