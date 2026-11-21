import type { WorkboardStatus } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

// Every store method that can write a card's status, run against a card in `review`
// awaiting acceptance of the result owner `main` reported. The settle check lives in
// updateCard alone; these rows prove each writer reaches it with its real actor.
type Actor = { ownerId: string } | null;
type StatusWriter = {
  /** Calls the writer on the awaiting card as `actor`; `null` is the operator or the system. */
  call: (store: WorkboardStore, id: string, actor: Actor) => Promise<unknown>;
  /**
   * The reporter's own call: `refused` names who can settle; `keeps` resolves or fails for
   * its own reason without settling (rework, or a writer that never leaves `review`);
   * `no-scope` writers take no agent scope, so only the operator or the system reaches them.
   */
  reporter: "refused" | "keeps" | "no-scope";
  /** Status after another owner's or the operator's call; `review` means it stays pending. */
  othersLeaveTo: WorkboardStatus;
};

const WORKER_SESSION = "agent:main:worker";

const STATUS_WRITERS: Record<string, StatusWriter> = {
  move: {
    call: (store, id, actor) => store.move(id, "done", undefined, actor ?? undefined),
    reporter: "refused",
    othersLeaveTo: "done",
  },
  unblock: {
    call: (store, id, actor) => store.unblock(id, actor ?? undefined),
    reporter: "refused",
    othersLeaveTo: "todo",
  },
  releaseClaim: {
    call: (store, id, actor) => store.releaseClaim(id, { ...actor, status: "done" }, actor),
    reporter: "refused",
    othersLeaveTo: "done",
  },
  block: {
    call: (store, id, actor) => store.block(id, { reason: "Stuck." }, actor),
    reporter: "refused",
    othersLeaveTo: "blocked",
  },
  reassign: {
    call: (store, id, actor) => store.reassign(id, { status: "done" }, actor),
    reporter: "refused",
    othersLeaveTo: "done",
  },
  reclaim: {
    call: (store, id, actor) => store.reclaim(id, { status: "todo" }, actor),
    reporter: "refused",
    othersLeaveTo: "todo",
  },
  recordProtocolViolation: {
    call: (store, id, actor) =>
      store.recordProtocolViolation(id, { detail: "Stopped early." }, actor ?? undefined),
    reporter: "refused",
    othersLeaveTo: "blocked",
  },
  complete: {
    call: (store, id, actor) => store.complete(id, { summary: "Again." }, actor),
    reporter: "keeps",
    othersLeaveTo: "done",
  },
  decompose: {
    call: (store, id, actor) => store.decompose(id, { children: [{ title: "Follow-up" }] }, actor),
    reporter: "keeps",
    othersLeaveTo: "done",
  },
  claim: {
    call: (store, id, actor) => store.claim(id, { ownerId: actor?.ownerId ?? "operator" }),
    reporter: "keeps",
    othersLeaveTo: "review",
  },
  promote: {
    call: (store, id, actor) => store.promote(id, {}, actor),
    reporter: "keeps",
    othersLeaveTo: "review",
  },
  specify: {
    call: (store, id, actor) => store.specify(id, {}, actor),
    reporter: "keeps",
    othersLeaveTo: "review",
  },
  update: {
    call: (store, id) => store.update(id, { status: "done" }),
    reporter: "no-scope",
    othersLeaveTo: "done",
  },
  bulkUpdate: {
    call: (store, id) => store.bulkUpdate({ ids: [id], patch: { status: "done" } }),
    reporter: "no-scope",
    othersLeaveTo: "done",
  },
  prepareStart: {
    call: (store, id) => store.prepareStart(id),
    reporter: "no-scope",
    othersLeaveTo: "review",
  },
  dispatch: {
    call: (store) => store.dispatch(),
    reporter: "no-scope",
    othersLeaveTo: "review",
  },
  syncLifecycle: {
    call: (store, id) =>
      store.syncLifecycle(id, {
        targetStatus: "blocked",
        executionStatus: "blocked",
        sourceUpdatedAt: Date.now() + 1_000,
        stale: undefined,
        now: Date.now(),
      }),
    reporter: "no-scope",
    othersLeaveTo: "review",
  },
  failPreparedLaunch: {
    call: (store, id) =>
      store.failPreparedLaunch(id, {
        expectedLaunch: {
          phase: "prepared",
          requestedSessionKey: WORKER_SESSION,
          provisionalRunId: `workboard:${id}:0`,
          preparedAt: 0,
        },
        reason: "Could not start.",
        failedAt: Date.now(),
      }),
    reporter: "no-scope",
    othersLeaveTo: "review",
  },
  blockRestartTombstonedSession: {
    call: (store, id) =>
      store.blockRestartTombstonedSession(id, {
        expectedSessionKey: WORKER_SESSION,
        sessionKey: WORKER_SESSION,
        now: Date.now(),
      }),
    reporter: "no-scope",
    othersLeaveTo: "review",
  },
  reconcileDanglingSession: {
    call: (store, id) =>
      store.reconcileDanglingSession(id, {
        sessionKey: WORKER_SESSION,
        present: false,
        now: Date.now(),
      }),
    reporter: "no-scope",
    othersLeaveTo: "review",
  },
};

// Methods that never write a card's status. A new store method fails the coverage test
// below until it is listed here or, if it can write a status, added to STATUS_WRITERS.
const NON_STATUS_METHODS = [
  // Reads.
  "buildWorkerContext",
  "diagnostics",
  "exportCards",
  "get",
  "getAttachment",
  "getSessionsBoard",
  "list",
  "listAttachments",
  "listBoards",
  "listCards",
  "listNotificationSubscriptions",
  "listSessionPlacements",
  "notificationEvents",
  "readWithWorkerContext",
  "runs",
  "stats",
  // Card writes that never set a status (metadata, evidence, execution association).
  "acceptExecutionLaunch",
  "addArtifact",
  "addAttachment",
  "addComment",
  "addLink",
  "addProof",
  "addProofWithArtifact",
  "addWorkerLog",
  "archive",
  "compensateWorkspaceMutation",
  "deleteAttachment",
  "heartbeat",
  "linkCards",
  "unlinkCards",
  "prepareExecutionLaunch",
  "refreshDiagnostics",
  // Card creation and deletion.
  "captureSession",
  "create",
  "delete",
  // Boards, sessions boards, notification subscriptions.
  "archiveBoard",
  "assertCardsBoard",
  "deleteBoard",
  "deleteNotificationSubscription",
  "advanceNotificationEvents",
  "repairSessionPlacements",
  "subscribeNotifications",
  "updateSessionsBoard",
  "upsertBoard",
  "writeSessionPlacement",
  // Classification palette: board metadata, never a card status.
  "prepareCardClassifications",
  "readClassifications",
  "seedClassifications",
  "seedClassificationsDirect",
  "setClassifications",
  "writeClassificationsDirect",
  // Runtime plumbing.
  "announceChangeEpoch",
  "close",
  "enqueueMutation",
  "invalidateCards",
  "invalidateSessionBoards",
  "emit",
  "ready",
  "refreshWriteReceipt",
  "runMutation",
  "runOperation",
  "subscribeChanges",
  "track",
  "trackCardStore",
  "trackMutation",
  "withMutationAuthority",
  // Internal building blocks, reached only through the writers above. updateCard is the
  // settle check itself; the others hand their status patch to it.
  "appendNotification",
  "buildBlockedCardPatch",
  "completeDirect",
  "createDirect",
  "dependencyTargetStatus",
  "dependsOn",
  "deleteDetachedAttachments",
  "addEvidence",
  "assertActiveStatusAllowed",
  "getAutoOrchestrationBoard",
  "linkCardsDirect",
  "nextNotificationSequence",
  "parentsDone",
  "promoteDependencyReady",
  "recordOrchestrationCandidate",
  "removeReferencesToCard",
  "requireCard",
  "unlinkCardsDirect",
  "updateCard",
  "updateLatestCard",
  "updateMetadata",
  "updateMetadataDirect",
];

async function awaitingCard() {
  const store = createWorkboardSqliteTestStore();
  const card = await store.create({
    title: "Worker card",
    status: "running",
    agentId: "main",
    execution: {
      id: "exec-worker",
      kind: "agent-session",
      mode: "autonomous",
      status: "running",
      sessionKey: WORKER_SESSION,
      runId: "run-worker",
      startedAt: 1_000,
      updatedAt: 1_000,
    },
  });
  await store.claim(card.id, { ownerId: "main", token: "worker-token" });
  await store.complete(card.id, { ownerId: "main", token: "worker-token", summary: "Done." });
  return { store, id: card.id };
}

const PENDING = {
  status: "review",
  metadata: { automation: { awaitingAcceptance: true, autoCompletedBy: "main" } },
};

const writers = Object.entries(STATUS_WRITERS);

describe("Workboard status writers and the pending-result settle check", () => {
  it("classifies every store method, so a new writer fails here until it is wired and listed", () => {
    const methods = new Set<string>();
    for (
      let proto: object | null = WorkboardStore.prototype;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (
          name !== "constructor" &&
          typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function"
        ) {
          methods.add(name);
        }
      }
    }
    const classified = new Set([...Object.keys(STATUS_WRITERS), ...NON_STATUS_METHODS]);
    expect([...methods].filter((name) => !classified.has(name)).toSorted()).toEqual([]);
    expect([...classified].filter((name) => !methods.has(name)).toSorted()).toEqual([]);
  });

  it.each(writers.filter(([, writer]) => writer.reporter !== "no-scope"))(
    "%s by the reporting owner leaves the result pending",
    async (_name, writer) => {
      const { store, id } = await awaitingCard();

      const outcome = await writer
        .call(store, id, { ownerId: "main" })
        .catch((error: unknown) => error);

      await expect(store.get(id)).resolves.toMatchObject(PENDING);
      if (writer.reporter === "refused") {
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toMatch(/operator or another agent/);
      }
    },
  );

  it.each(
    writers.flatMap(([name, writer]) =>
      (writer.reporter === "no-scope" ? [null] : [{ ownerId: "reviewer" }, null]).map(
        (actor) => [name, actor?.ownerId ?? "the operator", writer, actor] as const,
      ),
    ),
  )("%s by %s settles exactly when it leaves review", async (_name, _who, writer, actor) => {
    const { store, id } = await awaitingCard();

    const outcome = await writer.call(store, id, actor).catch((error: unknown) => error);

    const card = await store.get(id);
    if (writer.othersLeaveTo === "review") {
      expect(card).toMatchObject(PENDING);
      return;
    }
    expect(outcome).not.toBeInstanceOf(Error);
    expect(card?.status).toBe(writer.othersLeaveTo);
    expect(card?.metadata?.automation?.awaitingAcceptance).toBeUndefined();
    if (writer.othersLeaveTo === "done") {
      expect(card?.execution?.status).toBe("done");
    }
  });
});
