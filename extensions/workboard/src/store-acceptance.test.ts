import { describe, expect, it } from "vitest";
import { syncWorkboardSubagentEnded } from "./lifecycle-sync.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

async function completedByWorker() {
  const store = createWorkboardSqliteTestStore();
  const card = await store.create({
    title: "Worker card",
    status: "running",
    execution: {
      id: "exec-worker",
      kind: "agent-session",
      mode: "autonomous",
      status: "running",
      sessionKey: "agent:main:worker",
      runId: "run-worker",
      startedAt: 1_000,
      updatedAt: 1_000,
    },
  });
  const child = await store.create({ title: "Follow-up", parents: [card.id] });
  await store.claim(card.id, { ownerId: "main", token: "worker-token" });
  const subscription = await store.subscribeNotifications({ runId: "run-worker" });
  const completed = await store.complete(card.id, {
    ownerId: "main",
    token: "worker-token",
    summary: "Implemented and verified.",
    proof: { status: "passed", command: "pnpm test" },
    artifacts: [{ path: "/tmp/report.txt", label: "report" }],
    createdCardIds: [child.id],
  });
  return { store, card, child, subscription, completed };
}

describe("Workboard worker completion and acceptance", () => {
  it("lands a worker's completion in review awaiting acceptance with its full handoff", async () => {
    const { store, child, subscription, completed } = await completedByWorker();

    expect(completed).toMatchObject({
      status: "review",
      execution: { status: "review" },
      metadata: {
        attempts: [expect.objectContaining({ status: "succeeded" })],
        comments: [expect.objectContaining({ body: "Implemented and verified." })],
        proof: [expect.objectContaining({ status: "passed", command: "pnpm test" })],
        artifacts: [expect.objectContaining({ path: "/tmp/report.txt" })],
        notifications: [expect.objectContaining({ kind: "completed", runId: "run-worker" })],
        automation: {
          summary: "Implemented and verified.",
          createdCardIds: [child.id],
          awaitingAcceptance: true,
          autoCompletedAt: expect.any(Number),
        },
      },
    });
    expect(completed.completedAt).toBeUndefined();
    expect(completed.metadata?.claim).toBeUndefined();
    expect(await store.notificationEvents({ subscriptionId: subscription.id })).toMatchObject({
      events: [expect.objectContaining({ kind: "completed", runId: "run-worker" })],
    });
  });

  it("accepts the result when the card moves to done, without a second notification", async () => {
    const { store, card, completed } = await completedByWorker();

    const accepted = await store.update(card.id, { status: "done" });

    expect(accepted).toMatchObject({ status: "done", execution: { status: "done" } });
    expect(accepted.completedAt).toEqual(expect.any(Number));
    expect(accepted.metadata?.automation?.awaitingAcceptance).toBeUndefined();
    expect(accepted.metadata?.automation?.autoCompletedAt).toBe(
      completed.metadata?.automation?.autoCompletedAt,
    );
    expect(accepted.metadata?.notifications).toEqual(completed.metadata?.notifications);
  });

  it("clears the marker when the result is sent back instead of accepted", async () => {
    const { store, card } = await completedByWorker();

    const reopened = await store.update(card.id, { status: "todo" });

    expect(reopened.status).toBe("todo");
    expect(reopened.metadata?.automation?.awaitingAcceptance).toBeUndefined();
  });

  it("treats a reviewer's completion of the review card as acceptance", async () => {
    const { store, card } = await completedByWorker();
    await store.claim(card.id, { ownerId: "reviewer", token: "review-token" });

    const accepted = await store.complete(card.id, {
      ownerId: "reviewer",
      token: "review-token",
      summary: "Looks right.",
    });

    expect(accepted.status).toBe("done");
    expect(accepted.metadata?.automation?.awaitingAcceptance).toBeUndefined();
  });

  it("does not let the worker accept its own result by re-claiming the review card", async () => {
    const { store, card } = await completedByWorker();
    await store.claim(card.id, { ownerId: "main", token: "second-token" });

    const again = await store.complete(card.id, {
      ownerId: "main",
      token: "second-token",
      summary: "Done, really.",
    });

    expect(again.status).toBe("review");
    expect(again.completedAt).toBeUndefined();
    expect(again.metadata?.automation).toMatchObject({
      awaitingAcceptance: true,
      autoCompletedBy: "main",
    });
  });

  it("does not let a claim that survived the running-to-review sync accept the card", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Synced card",
      status: "running",
      execution: {
        id: "exec-synced",
        kind: "agent-session",
        mode: "autonomous",
        status: "running",
        sessionKey: "agent:main:synced",
        runId: "run-synced",
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });
    await store.claim(card.id, { ownerId: "main", token: "worker-token" });
    await syncWorkboardSubagentEnded({
      store,
      event: { targetSessionKey: "agent:main:synced", runId: "run-synced", outcome: "ok" },
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { claim: { ownerId: "main" } },
    });

    const completed = await store.complete(card.id, {
      ownerId: "main",
      token: "worker-token",
      summary: "Finished after the session ended.",
    });

    expect(completed.status).toBe("review");
    expect(completed.metadata?.automation?.awaitingAcceptance).toBe(true);
  });

  it("does not let the worker accept its own result by decomposing the review card", async () => {
    const { store, card } = await completedByWorker();

    const { parent } = await store.decompose(
      card.id,
      { children: [{ title: "More work" }] },
      { ownerId: "main" },
    );

    expect(parent.status).toBe("review");
    expect(parent.metadata?.automation?.awaitingAcceptance).toBe(true);
  });

  it("keeps the worker's claim when its release as done is refused", async () => {
    const { store, card } = await completedByWorker();
    await store.claim(card.id, { ownerId: "main", token: "again" });

    await expect(
      store.releaseClaim(card.id, { ownerId: "main", token: "again", status: "done" }),
    ).rejects.toThrow(/operator or another agent/);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { automation: { awaitingAcceptance: true }, claim: { ownerId: "main" } },
    });
  });

  type ReviewStore = Awaited<ReturnType<typeof completedByWorker>>["store"];
  it.each<[string, (store: ReviewStore, id: string) => Promise<unknown>]>([
    ["moving it to todo", (store, id) => store.move(id, "todo", undefined, { ownerId: "main" })],
    [
      "releasing it to todo",
      (store, id) => store.releaseClaim(id, { ownerId: "main", token: "t", status: "todo" }),
    ],
    [
      "reassigning it to todo",
      (store, id) => store.reassign(id, { status: "todo" }, { ownerId: "main" }),
    ],
    [
      "reclaiming it to todo",
      (store, id) => store.reclaim(id, { status: "todo" }, { ownerId: "main" }),
    ],
    [
      "re-claiming and blocking it",
      async (store, id) => {
        await store.claim(id, { ownerId: "main", token: "again" });
        return await store.block(id, { ownerId: "main", token: "again", reason: "Stuck." });
      },
    ],
  ])(
    "does not let the worker shed the acceptance marker by %s and then move it to done",
    async (_route, sendBack) => {
      const { store, card, child } = await completedByWorker();

      const hops = [
        await sendBack(store, card.id).catch((error: unknown) => error),
        await store.move(card.id, "done", undefined, { ownerId: "main" }).catch((error) => error),
      ];

      expect((await store.get(card.id))?.status).toBe("review");
      await expect(store.get(card.id)).resolves.toMatchObject({
        metadata: { automation: { awaitingAcceptance: true, autoCompletedBy: "main" } },
      });
      for (const hop of hops) {
        expect(hop).toBeInstanceOf(Error);
        expect((hop as Error).message).toMatch(/operator or another agent/);
      }
      const dispatch = await store.dispatch();
      expect(dispatch.promoted.map((entry) => entry.id)).not.toContain(child.id);
      await expect(store.get(child.id)).resolves.toMatchObject({ status: "todo" });
    },
  );

  // Ported from the round-4 probe: workboard_unblock wrote `todo` with no settle check,
  // dropping the marker, after which each of these follow-ups ended in `done`.
  it.each<[string, (store: ReviewStore, id: string) => Promise<unknown>]>([
    ["moving it to done", (store, id) => store.move(id, "done", undefined, { ownerId: "main" })],
    [
      "releasing it as done",
      (store, id) => store.releaseClaim(id, { ownerId: "main", status: "done" }),
    ],
    [
      "decomposing it",
      (store, id) =>
        store.decompose(id, { children: [{ title: "Follow-up" }] }, { ownerId: "main" }),
    ],
  ])(
    "refuses the worker's unblock of its awaiting card, so %s afterwards cannot accept it",
    async (_route, followUp) => {
      const { store, card, child } = await completedByWorker();

      const unblocked = await store
        .unblock(card.id, { ownerId: "main" })
        .catch((error: unknown) => error);
      await followUp(store, card.id).catch(() => undefined);

      await expect(store.get(card.id)).resolves.toMatchObject({
        status: "review",
        metadata: { automation: { awaitingAcceptance: true, autoCompletedBy: "main" } },
      });
      expect(unblocked).toBeInstanceOf(Error);
      expect((unblocked as Error).message).toMatch(/operator or another agent/);
      await store.dispatch();
      await expect(store.get(child.id)).resolves.toMatchObject({ status: "todo" });
    },
  );

  it("re-stamps the reporter when a sent-back result is reworked and completed again", async () => {
    const { store, card } = await completedByWorker();
    const sentBack = await store.move(card.id, "todo", undefined, { ownerId: "reviewer" });
    expect(sentBack.metadata?.automation?.awaitingAcceptance).toBeUndefined();

    await store.claim(card.id, { ownerId: "main", token: "rework-token" });
    const reworked = await store.complete(card.id, {
      ownerId: "main",
      token: "rework-token",
      summary: "Reworked.",
    });

    expect(reworked.status).toBe("review");
    expect(reworked.metadata?.automation).toMatchObject({
      awaitingAcceptance: true,
      autoCompletedBy: "main",
      summary: "Reworked.",
    });
    await expect(store.move(card.id, "done", undefined, { ownerId: "main" })).rejects.toThrow(
      /operator or another agent/,
    );
    await expect(
      store.move(card.id, "done", undefined, { ownerId: "reviewer" }),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("lets the operator send the result back for another owner's rework", async () => {
    const { store, card } = await completedByWorker();
    await store.move(card.id, "todo", undefined, undefined);
    await store.reassign(card.id, { agentId: "reviewer" }, null);
    await store.claim(card.id, { ownerId: "reviewer", token: "rework-token" });

    const reworked = await store.complete(card.id, {
      ownerId: "reviewer",
      token: "rework-token",
      summary: "Reworked by reviewer.",
    });

    expect(reworked.status).toBe("review");
    expect(reworked.metadata?.automation?.autoCompletedBy).toBe("reviewer");
    await expect(
      store.move(card.id, "done", undefined, { ownerId: "main" }),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("treats operator completion through the Gateway scope as acceptance", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Operator card", status: "running" });

    const completed = await store.complete(card.id, { summary: "Closed by operator." }, null);

    expect(completed.status).toBe("done");
    expect(completed.metadata?.automation?.awaitingAcceptance).toBeUndefined();
  });

  it("reports unaccepted automatic completions in diagnostics until accepted", async () => {
    const { store, card } = await completedByWorker();

    const pending = await store.refreshDiagnostics();
    expect(pending.diagnostics.find((entry) => entry.card.id === card.id)?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "awaiting_acceptance", severity: "warning" }),
      ]),
    );

    await store.update(card.id, { status: "done" });
    const accepted = await store.refreshDiagnostics();
    expect(
      accepted.diagnostics
        .find((entry) => entry.card.id === card.id)
        ?.diagnostics.some((diagnostic) => diagnostic.kind === "awaiting_acceptance") ?? false,
    ).toBe(false);
  });

  it("records when the operator saw the automatic completion, guarded by the read revision", async () => {
    const { store, card, completed } = await completedByWorker();

    const seen = await store.update(
      card.id,
      { acceptanceSeenAt: 5_000_000 },
      { expectedUpdatedAt: completed.updatedAt },
    );
    expect(seen).toMatchObject({
      status: "review",
      metadata: { automation: { awaitingAcceptance: true, acceptanceSeenAt: 5_000_000 } },
    });
    await expect(
      store.update(card.id, { acceptanceSeenAt: 6_000_000 }, { expectedUpdatedAt: 1 }),
    ).rejects.toThrow(/changed/);
  });

  it("keeps the review state when the worker's session ends afterwards (manual review states win)", async () => {
    const { store, card } = await completedByWorker();

    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: "agent:main:worker",
        runId: "run-worker",
        outcome: "error",
        endedAt: Date.now() + 1_000,
      },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { automation: { awaitingAcceptance: true } },
    });
  });
});
