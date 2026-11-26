import { describe, expect, it, vi } from "vitest";
import { createWorkboardLifecycleService } from "./lifecycle-sync.js";
import { WORKBOARD_DANGLING_SESSION_REASON } from "./store-workflow.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

type SweepSession = { key: string; status?: "running" | "done"; hasActiveRun?: boolean };

async function runSweep(
  store: WorkboardStore,
  params: {
    sessions?: SweepSession[];
    complete?: boolean;
    exact?: SweepSession[] | Error;
    exactUnavailable?: boolean;
  } = {},
) {
  const readSessions = vi.fn(async (options: { includeUnknown: boolean; sessionKey?: string }) => {
    if (options.sessionKey) {
      if (params.exact instanceof Error) {
        throw params.exact;
      }
      if (params.exactUnavailable) {
        // Mirrors readWorkboardLifecycleSessions while the Gateway is unavailable:
        // an empty list that establishes nothing about the key.
        return { sessions: [], complete: false };
      }
      return { sessions: params.exact ?? [], complete: false, authoritative: true };
    }
    return { sessions: params.sessions ?? [], complete: params.complete ?? true };
  });
  const onMatched = vi.fn();
  const service = createWorkboardLifecycleService({ store, readSessions, onMatched });
  const runOperation = vi.spyOn(store, "runOperation");
  try {
    await service.start({ logger: { warn: vi.fn() } } as never);
    service.onGatewayStart();
    await runOperation.mock.results[0]?.value;
  } finally {
    service.onGatewayStop();
    await service.stop?.({ logger: { warn: vi.fn() } } as never);
    runOperation.mockRestore();
  }
  return { onMatched, readSessions };
}

/** A dispatched card whose launch the Gateway accepted under `sessionKey`. */
async function createAcceptedCard(store: WorkboardStore, sessionKey: string) {
  const card = await store.create({ title: "Accepted worker", status: "ready" });
  const claimed = await store.claim(card.id, { ownerId: "worker" });
  const prepared = await store.prepareExecutionLaunch(card.id, {
    requestedSessionKey: sessionKey,
    now: Date.now(),
    scope: { ownerId: "worker", token: claimed.token },
  });
  const accepted = await store.acceptExecutionLaunch(card.id, {
    expectedLaunch: prepared.launch,
    acceptedAt: prepared.launch.preparedAt + 1,
    expectedSessionKey: sessionKey,
    expectedRunId: prepared.launch.provisionalRunId,
    sessionKey,
    runId: "run-accepted",
    execution: {
      id: `${card.id}:agent-session`,
      kind: "agent-session",
      mode: "autonomous",
      status: "running",
      sessionKey,
      runId: "run-accepted",
      startedAt: 1_000,
      updatedAt: 1_000,
    },
  });
  expect(accepted?.metadata?.automation?.launch?.phase).toBe("accepted");
  return accepted!;
}

describe("Workboard lifecycle sync for dangling session links", () => {
  it("blocks a running card once after two complete misses, keeping its link and history", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:subagent:workboard-default-lost";
    const card = await createAcceptedCard(store, sessionKey);

    const first = await runSweep(store);
    const marked = await store.get(card.id);
    expect(marked).toMatchObject({
      status: "running",
      metadata: {
        automation: { danglingSession: { sessionKey, runId: "run-accepted", misses: 1 } },
      },
    });
    expect(marked?.metadata?.notifications ?? []).toEqual([]);
    expect(first.onMatched).not.toHaveBeenCalled();
    // The exact read of the linked key is what confirms the absence.
    expect(first.readSessions).toHaveBeenCalledWith({ includeUnknown: false, sessionKey });

    const second = await runSweep(store);
    const blocked = await store.get(card.id);
    const reason = `${WORKBOARD_DANGLING_SESSION_REASON} Session: ${sessionKey}`;
    expect(blocked).toMatchObject({
      status: "blocked",
      sessionKey,
      runId: "run-accepted",
      execution: { status: "blocked", sessionKey, runId: "run-accepted" },
      metadata: {
        attempts: [expect.objectContaining({ status: "blocked", runId: "run-accepted" })],
        comments: [expect.objectContaining({ body: reason })],
        notifications: [expect.objectContaining({ kind: "failed", sessionKey })],
        automation: {
          launch: expect.objectContaining({ phase: "accepted" }),
          danglingSession: { sessionKey, runId: "run-accepted", misses: 2 },
        },
      },
    });
    expect(blocked?.metadata?.attempts).toHaveLength(marked?.metadata?.attempts?.length ?? 0);
    expect(blocked?.events?.slice(marked?.events?.length)).toEqual([
      expect.objectContaining({ kind: "moved", fromStatus: "running", toStatus: "blocked" }),
    ]);
    expect(second.onMatched).toHaveBeenCalledOnce();

    const third = await runSweep(store);
    expect(await store.get(card.id)).toEqual(blocked);
    expect(third.onMatched).not.toHaveBeenCalled();

    const reopened = await store.update(card.id, { status: "todo" });
    expect(reopened.metadata?.automation?.danglingSession).toBeUndefined();
  });

  it.each([
    { name: "the snapshot is incomplete", sweep: { complete: false } },
    { name: "the exact read fails", sweep: { exact: new Error("describe timed out") } },
    {
      name: "the exact read cannot consult the Gateway",
      sweep: { exactUnavailable: true },
    },
  ])("changes nothing when $name", async ({ sweep }) => {
    const store = createWorkboardSqliteTestStore();
    const card = await createAcceptedCard(store, "agent:main:subagent:workboard-default-unknown");

    await runSweep(store, sweep);
    await runSweep(store, sweep);

    expect(await store.get(card.id)).toEqual(card);
  });

  it("never reconciles the bare unknown link", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Legacy ownerless link",
      status: "running",
      sessionKey: "unknown",
      execution: {
        id: "legacy-exec",
        kind: "agent-session",
        mode: "autonomous",
        status: "running",
        sessionKey: "unknown",
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });

    await runSweep(store);
    await runSweep(store);

    expect(await store.get(card.id)).toEqual(card);
  });

  it("leaves a prepared launch to its own recovery path", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Prepared worker", status: "ready" });
    const claimed = await store.claim(card.id, { ownerId: "worker" });
    const prepared = await store.prepareExecutionLaunch(card.id, {
      requestedSessionKey: "agent:main:subagent:workboard-default-prepared",
      now: Date.now(),
      scope: { ownerId: "worker", token: claimed.token },
    });

    for (let miss = 0; miss < 2; miss += 1) {
      await expect(
        store.reconcileDanglingSession(card.id, {
          sessionKey: prepared.launch.requestedSessionKey,
          present: false,
          now: Date.now(),
        }),
      ).resolves.toBeUndefined();
    }
    expect(await store.get(card.id)).toEqual(prepared.card);
  });

  it("clears the first miss when the session reappears", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:subagent:workboard-default-back";
    const card = await createAcceptedCard(store, sessionKey);

    await runSweep(store);
    expect((await store.get(card.id))?.metadata?.automation?.danglingSession?.misses).toBe(1);

    await runSweep(store, { sessions: [{ key: sessionKey, status: "running" }] });
    const back = await store.get(card.id);
    expect(back?.status).toBe("running");
    expect(back?.metadata?.automation?.danglingSession).toBeUndefined();

    // The next miss starts over instead of blocking.
    await runSweep(store);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: { automation: { danglingSession: { misses: 1 } } },
    });
  });

  it("counts a session the exact read still finds as present", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:subagent:workboard-default-incatalog";
    const card = await createAcceptedCard(store, sessionKey);

    await runSweep(store, { exact: [{ key: sessionKey, status: "running" }] });
    await runSweep(store, { exact: [{ key: sessionKey, status: "running" }] });

    expect(await store.get(card.id)).toEqual(card);
  });
});
