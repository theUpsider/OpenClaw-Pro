import { describe, expect, it } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("workboard.cards.unlinkDependency", () => {
  it("removes a stale dependency link so the gated child can be accepted", async () => {
    const store = createWorkboardSqliteTestStore();
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store });
    const parent = await store.create({ title: "Stuck parent", status: "blocked" });
    const child = await store.create({ title: "Finished child" });
    const linked = await invoke("workboard.cards.linkDependency", {
      parentId: parent.id,
      childId: child.id,
    });
    expect(linked.mock.calls[0]?.[0]).toBe(true);
    // A worker still records completion in review while the parent holds.
    await store.move(child.id, "review", undefined);

    // The gate is real: with the parent open the child cannot be accepted.
    const refused = await invoke("workboard.cards.move", { id: child.id, status: "done" });
    expect(refused.mock.calls[0]?.[0]).toBe(false);
    expect(refused.mock.calls[0]?.[2]?.message).toBe("card dependencies are not done.");

    const missing = await invoke("workboard.cards.unlinkDependency", { parentId: parent.id });
    expect(missing.mock.calls[0]?.[2]?.message).toBe("parentId and childId are required.");

    const unlinked = await invoke("workboard.cards.unlinkDependency", {
      parentId: parent.id,
      childId: child.id,
    });
    expect(unlinked.mock.calls[0]?.[0]).toBe(true);
    expect(unlinked.mock.calls[0]?.[1]?.card.metadata?.links).toBeUndefined();
    expect((await store.get(parent.id))?.metadata?.links).toBeUndefined();

    const accepted = await invoke("workboard.cards.move", { id: child.id, status: "done" });
    expect(accepted.mock.calls[0]?.[0]).toBe(true);
    expect(accepted.mock.calls[0]?.[1]?.card.status).toBe("done");
  });
});
