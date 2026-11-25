// Workboard tests cover the Gateway surface of the external dispatch mode.
import { describe, expect, it } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("workboard.cards dispatch mode", () => {
  it("round-trips the external dispatch mode through create and update", async () => {
    const store = createWorkboardSqliteTestStore();
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store });

    const created = await invoke("workboard.cards.create", {
      title: "Externally placed mission",
      status: "ready",
      dispatchMode: "external",
    });
    expect(created.mock.calls[0]?.[0]).toBe(true);
    expect(created.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: { automation: { dispatchMode: "external" } },
    });
    const createdCard = created.mock.calls[0]?.[1]?.card;

    const promoted = await invoke("workboard.cards.update", {
      id: createdCard.id,
      expectedUpdatedAt: createdCard.updatedAt,
      patch: { dispatchMode: "native" },
    });
    expect(promoted.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: { automation: { dispatchMode: "native" } },
    });

    const refused = await invoke("workboard.cards.update", {
      id: createdCard.id,
      expectedUpdatedAt: promoted.mock.calls[0]?.[1]?.card.updatedAt,
      patch: { dispatchMode: "remote" },
    });
    expect(refused).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "workboard_error",
        message: "dispatch mode must be one of: native, external.",
      }),
    );
  });

  it("lists an external card unchanged for the external controller", async () => {
    const store = createWorkboardSqliteTestStore();
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store });
    const card = await store.create({
      title: "Controller-owned card",
      status: "ready",
      dispatchMode: "external",
    });

    const listed = await invoke("workboard.cards.list", {});
    const [ok, payload] = listed.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      cards: [
        expect.objectContaining({
          id: card.id,
          status: "ready",
          metadata: { automation: { dispatchMode: "external" } },
        }),
      ],
    });
  });

  it("rejects non-string mode updates without silently changing an external card to native", async () => {
    const store = createWorkboardSqliteTestStore();
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store });
    const card = await store.create({
      title: "Strict external placement",
      dispatchMode: "external",
    });
    for (const invalid of [true, 123, {}, []]) {
      for (const patch of [
        { dispatchMode: invalid },
        { metadata: { automation: { dispatchMode: invalid } } },
      ]) {
        const response = await invoke("workboard.cards.update", { id: card.id, patch });
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: "dispatch mode must be one of: native, external." }),
        );
        expect(await store.get(card.id)).toEqual(card);
      }
    }
  });
});
