// @vitest-environment node
import "../../test/host.setup.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import {
  acceptWorkboardCard,
  moveWorkboardCardToStatus,
  recordWorkboardDecision,
  sendBackWorkboardCard,
} from "./card-settle.ts";
import { getWorkboardState } from "./runtime.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";

type MoveRecord = {
  status?: WorkboardCard["status"];
  labelsRemove?: string[];
  expectedUpdatedAt?: number;
};

/**
 * A stand-in for the Gateway that owns the card, so the assertions read the same facts the
 * store would record: the comment is appended, the move is refused when `expectedUpdatedAt`
 * no longer matches, and the card only leaves `review` on the move that succeeded.
 */
function createSettleServer(
  initial: WorkboardCard,
  onComment?: (client: unknown, params: unknown) => void,
  beforeMove?: () => void,
) {
  let current = initial;
  const requests: [string, unknown][] = [];
  const client = createWorkboardTestClient(async (method, params) => {
    const record = params as { id: string; body?: string } & MoveRecord;
    requests.push([method, params]);
    if (method === "workboard.cards.comment") {
      current = {
        ...current,
        updatedAt: current.updatedAt + 1,
        metadata: {
          ...current.metadata,
          comments: [
            ...(current.metadata?.comments ?? []),
            {
              id: `c${requests.length}`,
              body: record.body ?? "",
              createdAt: current.updatedAt + 1,
            },
          ],
        },
      };
      onComment?.(client, params);
      return { card: current };
    }
    if (method === "workboard.cards.move") {
      // A change landing between the comment and the move: the store's own copy moved on.
      beforeMove?.();
      if (
        record.expectedUpdatedAt !== undefined &&
        record.expectedUpdatedAt !== current.updatedAt
      ) {
        throw new GatewayProtocolRequestError({
          code: "workboard_conflict",
          message: "Card changed. Review and retry.",
          details: { type: "workboard_card_conflict", card: current },
        });
      }
      current = {
        ...current,
        status: record.status ?? current.status,
        labels: current.labels.filter((label) => !record.labelsRemove?.includes(label)),
        updatedAt: current.updatedAt + 1,
      };
      return { card: current };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  return { client, requests, card: () => current };
}

function seeded(initial: WorkboardCard, onComment?: () => void, beforeMove?: () => void) {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [initial];
  const server = createSettleServer(initial, () => onComment?.(), beforeMove);
  const target = {
    host,
    client: server.client,
    connected: true,
    canWrite: true,
    requestUpdate: () => undefined,
  };
  return { ...server, host, state, target };
}

describe("Workboard card settle owner", () => {
  it("records the decision and settles the card exactly as the inline path did", async () => {
    const card = createWorkboardCard({
      status: "blocked",
      labels: ["decision"],
      notes: "Pick a store\n- [ ] SQLite",
    });
    const { state, target, requests, card: authoritative } = seeded(card);

    expect(
      await recordWorkboardDecision({
        ...target,
        cardId: card.id,
        decision: "Use SQLite",
        made: true,
      }),
    ).toBe(true);

    // Comment first, then one move that drops the label in its own write. The move is pinned to
    // the revision the comment returned, so a change landing in between refuses instead of
    // overwriting the newer card (and a refusal leaves the recorded comment standing).
    expect(requests).toEqual([
      ["workboard.cards.comment", { id: card.id, body: "Decision: Use SQLite" }],
      [
        "workboard.cards.move",
        {
          id: card.id,
          status: "ready",
          position: 1000,
          labelsRemove: ["decision"],
          expectedUpdatedAt: 2,
        },
      ],
    ]);
    expect(authoritative()).toMatchObject({ status: "ready", labels: [] });
    expect(authoritative().metadata?.comments?.at(-1)?.body).toBe("Decision: Use SQLite");
    expect(state.cards[0]).toMatchObject({ status: "ready", labels: [] });
    expect(state.error).toBeNull();
  });

  it("leaves the card blocked when the operator only adds a note", async () => {
    const card = createWorkboardCard({ status: "blocked", labels: ["decision"] });
    const { state, target, requests, card: authoritative } = seeded(card);

    expect(
      await recordWorkboardDecision({
        ...target,
        cardId: card.id,
        decision: "Not yet",
        made: false,
      }),
    ).toBe(true);

    expect(requests.map(([method]) => method)).toEqual(["workboard.cards.comment"]);
    expect(authoritative()).toMatchObject({ status: "blocked", labels: ["decision"] });
    expect(state.cards[0]).toMatchObject({ status: "blocked", labels: ["decision"] });
  });

  it("keeps the refusal visible when the move is refused after the comment was recorded", async () => {
    const card = createWorkboardCard({ status: "blocked", labels: ["decision"] });
    // A dispatch run starts while the comment is in flight, so the move guard refuses.
    const {
      state,
      target,
      requests,
      card: authoritative,
    } = seeded(card, () => {
      state.dispatching = true;
    });

    expect(
      await recordWorkboardDecision({
        ...target,
        cardId: card.id,
        decision: "Use SQLite",
        made: true,
      }),
    ).toBe(false);

    expect(requests.map(([method]) => method)).toEqual(["workboard.cards.comment"]);
    // The note stands and the card stays blocked, so the operator sees what was saved.
    expect(authoritative()).toMatchObject({ status: "blocked", labels: ["decision"] });
    expect(state.error).toBe(
      "Your decision comment was saved, but the card could not move to Ready. Deciding again records a second comment.",
    );
  });

  it("refuses a stale accept instead of overwriting the card that moved on", async () => {
    const rendered = createWorkboardCard({ status: "review", updatedAt: 5 });
    const newer: WorkboardCard = { ...rendered, status: "running", updatedAt: 9 };
    const { state, target, requests, card: authoritative } = seeded(newer);
    state.cards = [rendered];

    expect(
      await acceptWorkboardCard(target, rendered, { expectedUpdatedAt: rendered.updatedAt }),
    ).toBe(false);

    expect(authoritative()).toMatchObject({ status: "running", updatedAt: 9 });
    // The canonical card is reconciled into the board; the stale `done` is not written.
    expect(state.cards[0]).toMatchObject({ status: "running", updatedAt: 9 });
    expect(requests).toHaveLength(1);
  });

  it("accepts from the rendered revision and lets the store stamp the acceptance", async () => {
    const card = createWorkboardCard({ status: "review", updatedAt: 5 });
    const { target, requests, card: authoritative } = seeded(card);

    expect(await acceptWorkboardCard(target, card, { expectedUpdatedAt: card.updatedAt })).toBe(
      true,
    );

    expect(requests).toEqual([
      [
        "workboard.cards.move",
        {
          id: card.id,
          status: "done",
          position: 1000,
          expectedUpdatedAt: 5,
        },
      ],
    ]);
    expect(authoritative()).toMatchObject({ status: "done" });
  });

  it("sends a result back with its reason and pins the move to the comment's revision", async () => {
    const card = createWorkboardCard({ status: "review", updatedAt: 5 });
    const { target, requests, card: authoritative } = seeded(card);

    expect(
      await sendBackWorkboardCard(target, card, {
        reason: "Tests still fail on the migration.",
        expectedUpdatedAt: card.updatedAt,
      }),
    ).toBe(true);

    expect(requests).toEqual([
      ["workboard.cards.comment", { id: card.id, body: "Tests still fail on the migration." }],
      [
        "workboard.cards.move",
        {
          id: card.id,
          status: "ready",
          position: 1000,
          expectedUpdatedAt: 6,
        },
      ],
    ]);
    // Ready, not Todo: the same lane picks the card up again with its context intact.
    expect(authoritative()).toMatchObject({ status: "ready" });
    expect(authoritative().metadata?.comments?.at(-1)?.body).toBe(
      "Tests still fail on the migration.",
    );
  });

  it("refuses a stale send-back before it writes the reason", async () => {
    const rendered = createWorkboardCard({ status: "review", updatedAt: 5 });
    const { state, target, requests, card: authoritative } = seeded(rendered);
    state.cards = [{ ...rendered, updatedAt: 9 }];

    expect(
      await sendBackWorkboardCard(target, rendered, {
        reason: "Too early.",
        expectedUpdatedAt: rendered.updatedAt,
      }),
    ).toBe(false);

    expect(requests).toHaveLength(0);
    expect(authoritative()).toMatchObject({ status: "review", updatedAt: 5 });
  });

  it("refuses a decision move when a change landed between the comment and the move", async () => {
    // The comment established revision 6; a change lands before the move reaches the store. The
    // move is pinned to the comment's revision, so the store refuses it instead of overwriting
    // the newer card, and the recorded comment stays with its refusal shown.
    const card = createWorkboardCard({ status: "blocked", labels: ["decision"], updatedAt: 5 });
    const {
      state,
      target,
      requests,
      card: authoritative,
    } = seeded(card, undefined, () => {
      // One landed change: a newer revision the comment's move no longer matches.
      const next = authoritative();
      Object.assign(next, { status: "running" as const, updatedAt: next.updatedAt + 10 });
    });

    const recorded = await recordWorkboardDecision({
      ...target,
      cardId: card.id,
      decision: "Use SQLite",
      made: true,
    });

    expect(recorded).toBe(false);
    // The comment was written and the move attempted with the comment's revision; the newer card
    // was not overwritten.
    expect(requests).toEqual([
      ["workboard.cards.comment", { id: card.id, body: "Decision: Use SQLite" }],
      [
        "workboard.cards.move",
        {
          id: card.id,
          status: "ready",
          position: 1000,
          labelsRemove: ["decision"],
          expectedUpdatedAt: 6,
        },
      ],
    ]);
    expect(authoritative()).toMatchObject({ status: "running", updatedAt: 16 });
    // The refusal is visible; the caller keeps the text so the operator can decide again.
    expect(state.error).toBeTruthy();
  });

  it("refuses a stale move that names the rendered revision", async () => {
    const card = createWorkboardCard({ status: "ready", updatedAt: 3 });
    const { state, target, requests, card: authoritative } = seeded(card);

    expect(
      await moveWorkboardCardToStatus(target, card, "blocked", {
        expectedUpdatedAt: card.updatedAt + 1,
      }),
    ).toBe(false);

    expect(authoritative()).toMatchObject({ status: "ready", updatedAt: 3 });
    expect(state.cards[0]).toMatchObject({ status: "ready", updatedAt: 3 });
    expect(requests).toHaveLength(1);
  });
});
