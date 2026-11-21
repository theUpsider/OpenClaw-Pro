import { randomUUID } from "node:crypto";
import type {
  WorkboardCard,
  WorkboardExecution,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
  lifecycleStatusSourceUpdatedAtFromPatch,
  shouldSkipPersistedLifecycleStatusUpdate,
} from "./store-card-helpers.js";
import { MAX_CARD_NOTIFICATIONS } from "./store-constants.js";
import type { WorkboardCardPatch } from "./store-inputs.js";
import { trimMetadataToBudget } from "./store-normalizers.js";

/**
 * Statuses where a card may legitimately carry a live operator question. Mirrors
 * `ASKING_STATUSES` in `browser/lib/workboard/operator-attention.ts`, which gates the lens on the
 * same set; the two must agree on what "leaving the asking statuses" means. A card that moves
 * between two of these keeps its question; one that settles into `ready`, `running`, `review`,
 * `scheduled` or `done` has answered it.
 */
const ASKING_STATUSES: ReadonlySet<WorkboardStatus> = new Set([
  "triage",
  "backlog",
  "todo",
  "blocked",
]);

export function finishRun<Status extends "done" | "review" | "blocked">(
  card: WorkboardCard,
  status: Status,
  now: number,
  reason?: string,
): { status: Status; execution?: WorkboardExecution; metadata: WorkboardMetadata } {
  const execution =
    card.execution?.status === "running"
      ? { ...card.execution, status, updatedAt: now }
      : card.execution;
  return {
    status,
    ...(execution ? { execution } : {}),
    metadata: {
      ...card.metadata,
      claim: undefined,
      attempts: closeRunningAttempts(
        card.metadata?.attempts,
        now,
        status === "blocked" ? "blocked" : "succeeded",
        reason,
      ),
      failureCount: status === "blocked" ? (card.metadata?.failureCount ?? 0) + 1 : 0,
    },
  };
}

export function appendCardNotification(
  metadata: WorkboardMetadata | undefined,
  now: number,
  sequence: number,
  notification: Omit<WorkboardNotification, "id" | "createdAt" | "sequence">,
): WorkboardNotification[] {
  return [
    ...(metadata?.notifications ?? []),
    { id: randomUUID(), createdAt: now, sequence, ...notification },
  ].slice(-MAX_CARD_NOTIFICATIONS);
}

/** Returns the patch updateCard should apply, or undefined when a stale lifecycle write has nothing left. */
export function resolveLifecycleStatusWrite(
  existing: WorkboardCard,
  patch: WorkboardCardPatch,
): { effectivePatch: WorkboardCardPatch; hasFreshLifecycleStatusSource: boolean } | undefined {
  const lifecycleStatusSourceUpdatedAt = lifecycleStatusSourceUpdatedAtFromPatch(patch.metadata);
  const existingLifecycleStatusSourceUpdatedAt = existing.metadata?.lifecycleStatusSourceUpdatedAt;
  const hasFreshLifecycleStatusSource =
    lifecycleStatusSourceUpdatedAt !== undefined &&
    lifecycleStatusSourceUpdatedAt !== existingLifecycleStatusSourceUpdatedAt;
  let effectivePatch = patch;
  if (
    patch.status !== undefined &&
    lifecycleStatusSourceUpdatedAt !== undefined &&
    shouldSkipPersistedLifecycleStatusUpdate(existing, lifecycleStatusSourceUpdatedAt)
  ) {
    // Ignore stale lifecycle status writes, but still accept any non-status updates in the patch.
    effectivePatch = { ...patch, status: undefined };
    if (isRecord(patch.metadata)) {
      const { lifecycleStatusSourceUpdatedAt: _ignored, ...rest } = patch.metadata;
      effectivePatch.metadata = Object.keys(rest).length > 0 ? rest : undefined;
    }
    const hasSemanticPatch = Object.entries(effectivePatch).some(
      ([key, value]) => key !== "status" && key !== "metadata" && value !== undefined,
    );
    if (!hasSemanticPatch && effectivePatch.metadata === undefined) {
      return undefined;
    }
  }
  return { effectivePatch, hasFreshLifecycleStatusSource };
}

// Manual terminal writes share complete/block teardown. Already-ended runs only release
// their stale claim, without counting another failure or emitting another notification.
export function settleManualStatusTransition(params: {
  existing: WorkboardCard;
  status: WorkboardStatus;
  execution: WorkboardExecution | undefined;
  metadata: WorkboardMetadata;
  now: number;
  /** The operator (null actor) is the one settling, so acceptance is theirs to stamp. */
  acceptedByOperator?: boolean;
  nextNotificationSequence: () => number;
  preserveProofId?: string;
}): { execution: WorkboardExecution | undefined; metadata: WorkboardMetadata } {
  const { existing, status, now } = params;
  // Status patches often spread existing metadata. Only a newly supplied
  // lifecycle source is provenance; copied markers must not survive a manual transition.
  let metadata: WorkboardMetadata = {
    ...params.metadata,
    lifecycleStatusSourceUpdatedAt: undefined,
  };
  let execution = params.execution;
  // Leaving review settles a worker's automatic completion: `done` accepts it,
  // anything else sends it back. Either way it no longer awaits acceptance.
  // updateCard refuses the write before it persists unless its actor may settle.
  // The operator's acceptance of a pending result stamps `acceptanceSeenAt` in this
  // same write: as a separate write the card the operator just accepted could still
  // read as "New" through `workboardCardAcceptanceUnseen` until the stamp landed.
  const settledPendingResult = Boolean(existing.metadata?.automation?.awaitingAcceptance);
  if (status !== "review" && metadata.automation?.awaitingAcceptance) {
    metadata = {
      ...metadata,
      automation: { ...metadata.automation, awaitingAcceptance: undefined },
    };
    if (status === "done" && execution?.status === "review") {
      execution = { ...execution, status: "done", updatedAt: now };
    }
  }
  if (
    settledPendingResult &&
    status === "done" &&
    params.acceptedByOperator &&
    metadata.automation &&
    metadata.automation.acceptanceSeenAt === undefined
  ) {
    metadata = { ...metadata, automation: { ...metadata.automation, acceptanceSeenAt: now } };
  }
  // Tombstone and dangling-link reasons describe this block only; leaving `blocked` retires them.
  // `ask`/`askKind` are the same kind of reason: the agent's question was aimed at this block,
  // so settling the card out of `blocked` answers it. They are ordinary card fields, but a
  // stored kind keeps reading as a live ask in every status (`workboardOperatorAskKind` answers
  // from it alone), which would leave an already-answered card with a decidable face in the
  // lens. Retiring them here keeps the stored state honest instead of gating the lens on it.
  //
  // Both fields are gated on the card LEAVING `blocked`: `triage`, `backlog` and `todo` cards can
  // legitimately carry a live ask, so a move between those statuses must not delete the agent's
  // question.
  if (
    status !== "blocked" &&
    (metadata.automation?.restartTombstone || metadata.automation?.danglingSession)
  ) {
    metadata = {
      ...metadata,
      automation: {
        ...metadata.automation,
        restartTombstone: undefined,
        danglingSession: undefined,
      },
    };
  }
  // `triage`, `backlog`, `todo` and `blocked` can all legitimately carry a live question, so the
  // ask is retired only when the card leaves that set -- a move between two asking statuses keeps
  // the agent's question, while a settle into `ready` answers it.
  if (
    ASKING_STATUSES.has(existing.status) &&
    !ASKING_STATUSES.has(status) &&
    (metadata.automation?.ask !== undefined || metadata.automation?.askKind !== undefined)
  ) {
    metadata = {
      ...metadata,
      automation: { ...metadata.automation, ask: undefined, askKind: undefined },
    };
  }
  if (status !== "done" && status !== "blocked") {
    return { execution, metadata };
  }
  const runActive =
    execution?.status === "running" ||
    metadata.attempts?.some((attempt) => attempt.status === "running");
  if (!runActive) {
    return { execution, metadata: metadata.claim ? { ...metadata, claim: undefined } : metadata };
  }
  const finished = finishRun({ ...existing, execution, metadata }, status, now);
  const notifications = appendCardNotification(
    finished.metadata,
    now,
    params.nextNotificationSequence(),
    {
      kind: status === "done" ? "completed" : "failed",
      message: `Workboard card moved to ${status}.`,
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    },
  );
  return {
    execution: finished.execution,
    metadata: trimMetadataToBudget(
      { ...finished.metadata, notifications },
      { preserveProofId: params.preserveProofId, preserveNotificationId: notifications.at(-1)?.id },
    ),
  };
}
