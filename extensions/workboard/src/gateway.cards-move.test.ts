import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("workboard.cards.move", () => {
  it("drops labels in the same write as a move", async () => {
    const { api, invoke } = createGatewayMethodCapture();
    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });
    const base = await store.create({
      title: "Pick a store",
      status: "blocked",
      labels: ["Decision", "backend"],
    });
    const invalid = await invoke("workboard.cards.move", {
      id: base.id,
      status: "ready",
      labelsRemove: "decision",
    });
    expect(invalid.mock.calls[0]?.[2]?.message).toBe("labelsRemove must be an array of strings.");
    await expect(store.get(base.id)).resolves.toEqual(base);

    const respond = await invoke("workboard.cards.move", {
      id: base.id,
      status: "ready",
      position: 1000,
      expectedUpdatedAt: base.updatedAt,
      labelsRemove: ["decision"],
    });
    const [ok, payload] = expectDefined(respond.mock.calls[0], "move response");
    expect(ok).toBe(true);
    const moved = (payload as { card: WorkboardCard }).card;
    expect(moved).toMatchObject({ status: "ready", labels: ["backend"], position: 1000 });
    // One write: the status move and the label removal share a single revision.
    expect(moved.events?.slice(base.events?.length ?? 0)).toHaveLength(1);
    await expect(store.get(base.id)).resolves.toEqual(moved);
  });
});
