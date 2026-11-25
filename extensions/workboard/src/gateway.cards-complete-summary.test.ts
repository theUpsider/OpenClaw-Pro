// Gateway-level proof that an over-long completion summary is capped at the RPC
// boundary instead of rejecting the whole `workboard.cards.complete` call.
import { describe, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("workboard gateway completion summary cap", () => {
  it("caps an over-long completion summary instead of rejecting the Gateway call", async () => {
    const { api, methods, invoke } = createGatewayMethodCapture();
    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });
    const created = await invoke("workboard.cards.create", {
      title: "Long gateway completion",
    });
    const cardId = created.mock.calls[0]?.[1]?.card.id as string;
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: cardId, ownerId: "main" },
      respond: vi.fn(),
    } as never);

    const completeRespond = await invoke("workboard.cards.complete", {
      id: cardId,
      summary: "x".repeat(2200),
      proof: { status: "passed", command: "pnpm test" },
      artifacts: [{ url: "https://example.com/report" }],
    });

    // The operator completion used to reject with a workboard_error; now it succeeds.
    expect(completeRespond.mock.calls[0]?.[0]).toBe(true);
    const card = completeRespond.mock.calls[0]?.[1]?.card;
    expect(card.status).toBe("done");
    expect(card.metadata?.proof).toEqual([expect.objectContaining({ status: "passed" })]);
    expect(card.metadata?.artifacts).toEqual([
      expect.objectContaining({ url: "https://example.com/report" }),
    ]);
    const stored = card.metadata?.automation?.summary ?? "";
    expect(stored.length).toBeLessThanOrEqual(2000);
    expect(stored).toMatch(/ … \[truncated: \d+ characters omitted\]$/);
    expect(card.metadata?.workerLogs?.at(-1)).toMatchObject({ level: "warning" });
  });
});
