import { describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard dispatch mode ownership", () => {
  it.each(["controller", "successor"])(
    "keeps an expired external claim until explicit reclaim, including replacement by %s",
    async (nextOwner) => {
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({
        title: "Externally hosted work remains occupied",
        status: "ready",
        dispatchMode: "external",
      });
      const { card: claimed, token } = await store.claim(card.id, {
        ownerId: "controller",
        ttlSeconds: 1,
      });
      const expiredNow = (claimed.metadata?.claim?.expiresAt ?? 0) + 10 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(expiredNow);
      try {
        await expect(store.claim(card.id, { ownerId: nextOwner })).rejects.toThrow(
          "already claimed",
        );
        expect((await store.get(card.id))?.metadata?.claim).toEqual(claimed.metadata?.claim);
        // The current secret holder may recover its lease after an outage.
        await expect(
          store.heartbeat(card.id, { ownerId: "controller", token }),
        ).resolves.toMatchObject({
          metadata: { claim: { ownerId: "controller", token } },
        });
        await store.reclaim(card.id, {}, null);
        const replacement = await store.claim(card.id, { ownerId: nextOwner });
        expect(replacement.card.metadata?.claim?.ownerId).toBe(nextOwner);
        expect(replacement.token).not.toBe(token);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("holds placement past claim expiry and grace until the owner is explicitly reclaimed", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Suspended dispatcher", status: "ready" });
    const { card: claimed } = await store.claim(card.id, { ownerId: "dispatcher", ttlSeconds: 1 });
    const expiredNow = (claimed.metadata?.claim?.expiresAt ?? 0) + 10 * 60 * 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiredNow);
    try {
      await expect(store.update(card.id, { dispatchMode: "external" })).rejects.toThrow(
        "dispatch mode cannot change",
      );
    } finally {
      clock.mockRestore();
    }
    await store.reclaim(card.id, {}, null);
    await expect(store.update(card.id, { dispatchMode: "external" })).resolves.toMatchObject({
      metadata: { automation: { dispatchMode: "external" } },
    });
  });

  it.each(["native", "external"] as const)(
    "rejects every effective mode flip under a live %s claim, including metadata replacement",
    async (dispatchMode) => {
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({ title: "Owned work", status: "ready", dispatchMode });
      const { card: claimed, token } = await store.claim(card.id, { ownerId: "controller" });
      if (dispatchMode === "external") {
        await expect(
          store.prepareExecutionLaunch(card.id, {
            requestedSessionKey: "external-must-not-launch",
            now: Date.now(),
            scope: { ownerId: "controller", token },
          }),
        ).rejects.toThrow("external dispatch mode");
        expect(await store.get(card.id)).toEqual(claimed);
      }
      const otherMode = dispatchMode === "native" ? "external" : "native";
      for (const patch of [
        { dispatchMode: otherMode },
        { metadata: { automation: { dispatchMode: otherMode } } },
        // A replacement cannot evade the guard by dropping the claim or ending execution.
        {
          status: "blocked",
          execution: null,
          metadata: { claim: null, automation: { dispatchMode: otherMode } },
        },
        ...(dispatchMode === "external"
          ? [{ metadata: { automation: { dispatchMode: null } } }]
          : []),
      ]) {
        await expect(store.update(card.id, patch)).rejects.toThrow("dispatch mode cannot change");
        expect(await store.get(card.id)).toEqual(claimed);
      }
      await expect(store.update(card.id, { dispatchMode })).resolves.toMatchObject({
        metadata: { automation: { dispatchMode } },
      });
      await store.complete(card.id, { ownerId: "controller", token, summary: "Finished" });
      await expect(store.update(card.id, { dispatchMode: otherMode })).resolves.toMatchObject({
        metadata: { automation: { dispatchMode: otherMode } },
      });
    },
  );

  it("keeps an execution's placement fixed without a claim and allows equivalent native writes", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Running execution",
      execution: { id: "exec", kind: "agent-session", mode: "autonomous", status: "running" },
    });
    await expect(store.update(card.id, { dispatchMode: "external" })).rejects.toThrow(
      "dispatch mode cannot change",
    );
    await expect(store.update(card.id, { dispatchMode: "native" })).resolves.toMatchObject({
      metadata: { automation: { dispatchMode: "native" } },
    });
    await store.update(card.id, { execution: null });
    // A still-running attempt also owns placement after execution detachment.
    await expect(store.update(card.id, { dispatchMode: "external" })).rejects.toThrow(
      "dispatch mode cannot change",
    );
  });
});
