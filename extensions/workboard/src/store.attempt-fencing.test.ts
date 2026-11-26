import type { WorkboardExecution } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const SESSION_KEY = "agent:main:subagent:workboard-default-fenced";

function runningExecution(cardId: string, runId: string): WorkboardExecution {
  return {
    id: `${cardId}:agent-session`,
    kind: "agent-session",
    mode: "autonomous",
    status: "running",
    sessionKey: SESSION_KEY,
    runId,
    startedAt: 1_000,
    updatedAt: 1_000,
  };
}

async function launch(store: WorkboardStore, cardId: string) {
  const claimed = await store.claim(cardId, { ownerId: "worker" });
  return await store.prepareExecutionLaunch(cardId, {
    requestedSessionKey: SESSION_KEY,
    now: Date.now(),
    scope: { ownerId: "worker", token: claimed.token },
  });
}

async function accept(
  store: WorkboardStore,
  cardId: string,
  prepared: Awaited<ReturnType<typeof launch>>,
  runId: string,
) {
  return await store.acceptExecutionLaunch(cardId, {
    expectedLaunch: prepared.launch,
    acceptedAt: prepared.launch.preparedAt + 1,
    expectedSessionKey: SESSION_KEY,
    expectedRunId: prepared.launch.provisionalRunId,
    sessionKey: SESSION_KEY,
    runId,
    execution: runningExecution(cardId, runId),
  });
}

/** First attempt ran as run-1 and was blocked; the second attempt is prepared. */
async function createRetriedCard(store: WorkboardStore) {
  const card = await store.create({ title: "Retried worker", status: "ready" });
  await accept(store, card.id, await launch(store, card.id), "run-1");
  await store.block(card.id, { reason: "first attempt failed" }, null);
  await store.unblock(card.id);
  const retry = await launch(store, card.id);
  return { card: retry.card, retry };
}

function lifecycle(
  card: { sessionKey?: string; runId?: string },
  input: {
    state: "running" | "blocked" | "review";
    runId?: string;
    sourceUpdatedAt?: number;
  },
) {
  return {
    targetStatus: input.state,
    executionStatus: input.state,
    sourceUpdatedAt: input.sourceUpdatedAt,
    stale: undefined,
    now: Date.now(),
    association: {
      expectedSessionKey: card.sessionKey,
      expectedRunId: card.runId,
      sessionKey: SESSION_KEY,
      ...(input.runId ? { runId: input.runId } : {}),
      acceptedAt: input.sourceUpdatedAt ?? Date.now(),
    },
  } as const;
}

describe("Workboard lifecycle writes fence superseded attempts", () => {
  it("ignores a late running update from the previous attempt and applies the current one", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card } = await createRetriedCard(store);
    const late = Date.now() + 10_000;

    await expect(
      store.syncLifecycle(
        card.id,
        lifecycle(card, { state: "running", runId: "run-1", sourceUpdatedAt: late }),
      ),
    ).resolves.toBe(false);
    expect(await store.get(card.id)).toEqual(card);

    await expect(
      store.syncLifecycle(
        card.id,
        lifecycle(card, { state: "running", runId: "run-2", sourceUpdatedAt: late }),
      ),
    ).resolves.toBe(true);
    const current = await store.get(card.id);
    expect(current).toMatchObject({
      status: "running",
      runId: "run-2",
      execution: { status: "running", runId: "run-2" },
      metadata: { automation: { launch: { phase: "accepted", acceptedRunId: "run-2" } } },
    });
    expect(current?.metadata?.attempts?.map(({ runId, status }) => ({ runId, status }))).toEqual([
      { runId: "run-1", status: "blocked" },
      { runId: "run-2", status: "running" },
    ]);
  });

  it("keeps a reviewed card's execution and attempts against older or running reports", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, retry } = await createRetriedCard(store);
    const accepted = (await accept(store, card.id, retry, "run-2"))!;
    await expect(
      store.syncLifecycle(
        card.id,
        lifecycle(accepted, { state: "review", runId: "run-2", sourceUpdatedAt: Date.now() }),
      ),
    ).resolves.toBe(true);
    const reviewed = (await store.get(card.id))!;
    expect(reviewed).toMatchObject({ status: "review", execution: { status: "review" } });

    // A superseded run's report without a timestamp is fenced by identity alone.
    await expect(
      store.syncLifecycle(card.id, lifecycle(reviewed, { state: "blocked", runId: "run-1" })),
    ).resolves.toBe(false);
    // The current session still reporting running must not reopen the finished attempt.
    await expect(
      store.syncLifecycle(card.id, lifecycle(reviewed, { state: "running" })),
    ).resolves.toBe(false);
    expect(await store.get(card.id)).toEqual(reviewed);
  });
});
