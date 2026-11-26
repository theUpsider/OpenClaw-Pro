import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { redactClaimToken, redactDispatchResult } from "./card-redaction.js";

function createCard(metadata?: WorkboardCard["metadata"]): WorkboardCard {
  return {
    id: "card-1",
    title: "Ship cleanup",
    status: "running",
    priority: "normal",
    labels: ["cleanup"],
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    metadata,
  };
}

describe("redactClaimToken", () => {
  it("preserves card identity when there is no claim", () => {
    const card = createCard({ archivedAt: 1 });

    expect(redactClaimToken(card)).toBe(card);
  });

  it("redacts the token without mutating the card", () => {
    const card = createCard({
      claim: {
        ownerId: "worker",
        token: "secret-token",
        claimedAt: 1,
        lastHeartbeatAt: 2,
      },
    });

    const redacted = redactClaimToken(card);

    expect(redacted).not.toBe(card);
    expect(redacted.labels).toBe(card.labels);
    expect(redacted.metadata).not.toBe(card.metadata);
    expect(redacted.metadata?.claim).not.toBe(card.metadata?.claim);
    expect(redacted.metadata?.claim?.token).toBe("[redacted]");
    expect(card.metadata?.claim?.token).toBe("secret-token");
  });
});

describe("redactDispatchResult", () => {
  it("passes lane-queue skip entries through unchanged", () => {
    const skipped = [
      { cardId: "card-2", title: "Queued", ownerId: "worker", reason: "owner_busy" as const },
    ];
    const result = redactDispatchResult({
      promoted: [],
      reclaimed: [],
      blocked: [],
      orchestrated: [],
      count: 0,
      skipped,
    });

    expect(result.skipped).toBe(skipped);
  });
});
