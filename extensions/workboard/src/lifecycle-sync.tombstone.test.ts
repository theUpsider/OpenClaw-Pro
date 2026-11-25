import { describe, expect, it, vi } from "vitest";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
} from "./lifecycle-sync.js";
import { WORKBOARD_RESTART_TOMBSTONE_REASON, type WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

type SweepSession = {
  key: string;
  updatedAt?: number;
  status?: "running" | "done";
  hasActiveRun?: boolean;
  restartRecoveryStatus?: "tombstoned";
};

async function runSessionSweep(store: WorkboardStore, sessions: SweepSession[]) {
  const readSessions = vi.fn().mockResolvedValue({ sessions, complete: true });
  const onMatched = vi.fn();
  const service = createWorkboardLifecycleService({ store, readSessions, onMatched });
  const runOperation = vi.spyOn(store, "runOperation");
  try {
    await service.start({ logger: { warn: vi.fn() } } as never);
    service.onGatewayStart();
    await runOperation.mock.results[0]?.value;
    // One snapshot read; absent linked sessions add exact reads of their own key.
    expect(readSessions.mock.calls.filter(([options]) => !options.sessionKey)).toHaveLength(1);
  } finally {
    service.onGatewayStop();
    await service.stop?.({ logger: { warn: vi.fn() } } as never);
    runOperation.mockRestore();
  }
  return { onMatched };
}

async function createRunningCard(store: WorkboardStore, sessionKey: string) {
  const card = await store.create({
    title: `Worker on ${sessionKey}`,
    status: "running",
    sessionKey,
    runId: `run-${sessionKey}`,
    execution: {
      id: `exec-${sessionKey}`,
      kind: "agent-session",
      mode: "autonomous",
      status: "running",
      sessionKey,
      runId: `run-${sessionKey}`,
      startedAt: 1_000,
      updatedAt: 1_000,
    },
  });
  await store.claim(card.id, { ownerId: `owner-${sessionKey}`, token: `token-${sessionKey}` });
  return card;
}

describe("Workboard lifecycle sync for restart-tombstoned sessions", () => {
  it("blocks a card whose linked session a gateway restart tombstoned, once", async () => {
    const store = createWorkboardSqliteTestStore();
    const tombstonedKey = "agent:main:subagent:workboard-default-lost";
    const healthyKey = "agent:main:subagent:workboard-default-healthy";
    const lost = await createRunningCard(store, tombstonedKey);
    const healthy = await createRunningCard(store, healthyKey);
    const sessions: SweepSession[] = [
      {
        key: tombstonedKey,
        status: "running",
        updatedAt: Date.now(),
        restartRecoveryStatus: "tombstoned",
      },
      { key: healthyKey, status: "done", hasActiveRun: false, updatedAt: Date.now() + 1_000 },
    ];

    const first = await runSessionSweep(store, sessions);

    const blocked = await store.get(lost.id);
    const reason = `${WORKBOARD_RESTART_TOMBSTONE_REASON} Session: ${tombstonedKey}`;
    expect(blocked).toMatchObject({
      status: "blocked",
      sessionKey: tombstonedKey,
      execution: { status: "blocked" },
      metadata: {
        attempts: [expect.objectContaining({ status: "blocked", error: reason })],
        comments: [expect.objectContaining({ body: reason })],
        notifications: [expect.objectContaining({ kind: "failed", sessionKey: tombstonedKey })],
        automation: {
          restartTombstone: { sessionKey: tombstonedKey, detectedAt: expect.any(Number) },
        },
      },
    });
    expect(blocked?.metadata?.claim).toBeUndefined();
    expect(first.onMatched).toHaveBeenCalledWith({
      cards: [expect.objectContaining({ id: lost.id })],
      sessionKey: tombstonedKey,
    });
    // A healthy finished session still maps exactly as before.
    await expect(store.get(healthy.id)).resolves.toMatchObject({
      status: "review",
      execution: { status: "review" },
    });

    const second = await runSessionSweep(store, sessions);

    expect(await store.get(lost.id)).toEqual(blocked);
    expect(second.onMatched).not.toHaveBeenCalled();
  });

  it("leaves a card alone when its tombstoned session is not the one it links", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createRunningCard(store, "agent:main:subagent:workboard-default-current");

    await runSessionSweep(store, [
      {
        key: "agent:main:subagent:workboard-default-older",
        status: "running",
        restartRecoveryStatus: "tombstoned",
      },
    ]);

    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });
  });

  it("retires the recorded reason once the card leaves blocked", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:subagent:workboard-default-retry";
    const card = await createRunningCard(store, sessionKey);
    await runSessionSweep(store, [
      { key: sessionKey, status: "running", restartRecoveryStatus: "tombstoned" },
    ]);

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: { automation: { restartTombstone: { sessionKey } } },
    });

    const reopened = await store.update(card.id, { status: "todo" });

    expect(reopened.status).toBe("todo");
    expect(reopened.metadata?.automation?.restartTombstone).toBeUndefined();
  });

  it("reads the tombstone from the same sessions.list and sessions.describe payloads", async () => {
    const row = { key: "agent:main:lost", status: "running", restartRecoveryStatus: "tombstoned" };
    const request = vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === "sessions.describe" ? { session: row } : { sessions: [row] },
      );
    const gateway = { isAvailable: async () => true, request };

    await expect(readWorkboardLifecycleSessions(gateway)).resolves.toMatchObject({
      sessions: [{ key: "agent:main:lost", restartRecoveryStatus: "tombstoned" }],
    });
    await expect(
      readWorkboardLifecycleSessions(gateway, { includeUnknown: false, sessionKey: row.key }),
    ).resolves.toMatchObject({
      sessions: [{ key: "agent:main:lost", restartRecoveryStatus: "tombstoned" }],
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.list",
      "sessions.describe",
    ]);
  });
});
