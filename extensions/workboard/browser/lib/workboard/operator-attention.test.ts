import { describe, expect, it } from "vitest";
import {
  WORKBOARD_ATTENTION_REASON_TIERS,
  attentionSinceMs,
  isWorkboardInboxUnownedEntry,
  needsOperatorAttention,
  partitionWorkboardInboxEntries,
  workboardAttentionReasons,
  workboardInboxEntries,
} from "./operator-attention.ts";
import { createWorkboardCard } from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";

function assigned(overrides: Partial<WorkboardCard> = {}) {
  return createWorkboardCard({ agentId: "b", status: "running", ...overrides });
}

describe("Workboard operator attention", () => {
  it("marks a review card", () => {
    expect(needsOperatorAttention(assigned({ status: "review" }))).toBe(true);
  });

  it("marks a blocked decision card, ignoring case and surrounding spaces", () => {
    expect(needsOperatorAttention(assigned({ status: "blocked", labels: ["decision"] }))).toBe(
      true,
    );
    expect(
      needsOperatorAttention(assigned({ status: "blocked", labels: ["infra", " Decision "] })),
    ).toBe(true);
  });

  it("ranks an ask-kind card at the decision tier through the shared predicate", () => {
    // The reason comes from `workboardOperatorAskKind`, not from a second copy of the rule:
    // this is the same predicate the store validates `askKind` with.
    const input = assigned({
      status: "blocked",
      metadata: { automation: { ask: "Which tenant?", askKind: "input" } },
    });
    expect(workboardAttentionReasons(input)).toEqual(["input"]);
    const external = assigned({
      status: "blocked",
      metadata: { automation: { askKind: "external" } },
    });
    expect(workboardAttentionReasons(external)).toEqual(["external"]);
    expect(workboardInboxEntries([input, external])[0]?.tier).toBe(0);
  });

  it("leaves the `decision` label on a non-blocked card unmarked", () => {
    // The label names the operator's step only while the card is blocked; afterwards it is
    // stale history and must not keep the card in the inbox. `review` still marks on its own,
    // so the assertion is about the `decision` reason, not about the card's overall marker.
    for (const status of ["todo", "ready", "running", "scheduled", "review", "done"] as const) {
      expect(workboardAttentionReasons(assigned({ status, labels: ["decision"] }))).not.toContain(
        "decision",
      );
    }
  });

  it("does not keep asking for a stored kind once the card is running, scheduled, done or ready", () => {
    // A stored `askKind` is a question aimed at one block; settling the card out of `blocked`
    // retires it in the store, so the lens reads no live ask there. `ready` matters most: an
    // agent picks that card up now, and a decidable face there invites a second answer.
    for (const status of ["ready", "running", "scheduled", "done", "review"] as const) {
      expect(
        workboardAttentionReasons(
          assigned({ status, metadata: { automation: { askKind: "input" } } }),
        ),
      ).not.toContain("input");
    }
    for (const status of ["triage", "backlog", "todo", "blocked"] as const) {
      expect(
        workboardAttentionReasons(
          assigned({ status, metadata: { automation: { askKind: "input" } } }),
        ),
      ).toContain("input");
    }
  });

  it("marks an open card without an agent, including a whitespace-only agent", () => {
    for (const status of ["triage", "backlog", "todo", "ready"] as const) {
      expect(needsOperatorAttention(createWorkboardCard({ status }))).toBe(true);
    }
    expect(needsOperatorAttention(assigned({ agentId: "   ", status: "todo" }))).toBe(true);
  });

  it("leaves an unassigned card unmarked outside the open statuses", () => {
    // Scheduled, running and finished work waits on nobody, even with no agent set.
    for (const status of ["scheduled", "running", "done"] as const) {
      expect(needsOperatorAttention(createWorkboardCard({ status }))).toBe(false);
    }
    // A blocked card without a decision label waits on a third party, not on the operator.
    expect(needsOperatorAttention(createWorkboardCard({ status: "blocked" }))).toBe(false);
  });

  it("leaves an assigned card without review or decision unmarked", () => {
    expect(needsOperatorAttention(assigned({ labels: ["infra"] }))).toBe(false);
    expect(needsOperatorAttention(assigned({ status: "done" }))).toBe(false);
  });

  it("names the reasons a card really waits for, most urgent first", () => {
    // The gates can overlap by design (an open card with nobody on it and a live `input` ask
    // waits for two things), so a card may carry more than one reason. What must hold: no
    // duplicates, tier order, and the most urgent reason first -- a housekeeping reason must
    // never lead while a real operator step is also named.
    const statuses = [
      "triage",
      "backlog",
      "todo",
      "scheduled",
      "ready",
      "running",
      "review",
      "blocked",
      "done",
    ] as const;
    for (const status of statuses) {
      for (const agentId of ["b", "   "] as const) {
        for (const labels of [[], ["decision"], ["infra", " Decision "]] as const) {
          for (const askKind of [undefined, "input", "external"] as const) {
            const reasons = workboardAttentionReasons(
              createWorkboardCard({
                status,
                agentId,
                labels,
                ...(askKind ? { metadata: { automation: { askKind } } } : {}),
              }),
            );
            expect(new Set(reasons).size).toBe(reasons.length);
            expect(reasons.map((reason) => WORKBOARD_ATTENTION_REASON_TIERS[reason])).toEqual(
              reasons
                .map((reason) => WORKBOARD_ATTENTION_REASON_TIERS[reason])
                .toSorted((left, right) => left - right),
            );
            // The most urgent reason is first, and it is never housekeeping while an operator
            // step is also named -- otherwise the lens would hide a decision behind "no agent".
            expect(reasons[0]).toBe(
              reasons.toSorted(
                (left, right) =>
                  WORKBOARD_ATTENTION_REASON_TIERS[left] - WORKBOARD_ATTENTION_REASON_TIERS[right],
              )[0],
            );
          }
        }
      }
    }
  });

  it("leaves a done card without an agent unmarked", () => {
    expect(needsOperatorAttention(createWorkboardCard({ status: "done" }))).toBe(false);
  });

  it("drops the marker once the operator answers or accepts", () => {
    // blocked + decision -> ready (answer) and review -> done (acceptance) both go quiet.
    expect(needsOperatorAttention(assigned({ status: "ready", labels: ["decision"] }))).toBe(false);
    expect(needsOperatorAttention(assigned({ status: "done", labels: ["decision"] }))).toBe(false);
  });

  it("leaves the lens once an answered `input` card is settled out of blocked", () => {
    // The settled card the store returns after the operator answers ("Other answer"): `ready`,
    // and the ask the agent left is retired by the settle, so the reason the operator acted on
    // is gone from the lens. The status gate below is the second half: a kind left on a `ready`
    // card by any other path still never renders as a live ask.
    const settled: WorkboardCard = {
      ...assigned({
        status: "ready",
        metadata: { automation: { ask: undefined, askKind: undefined } },
      }),
    };
    expect(workboardAttentionReasons(settled)).not.toContain("input");
    expect(workboardInboxEntries([settled]).some((entry) => entry.card.id === settled.id)).toBe(
      false,
    );
    // Without retiring the ask, a `ready` card would keep a decidable face: the defect this
    // pins. Neither the store fields nor the lens may still read a live ask here.
    expect(
      workboardAttentionReasons(
        assigned({ status: "ready", metadata: { automation: { askKind: "input" } } }),
      ),
    ).not.toContain("input");
  });

  it("leaves archived cards unmarked, even in review", () => {
    const archived = { metadata: { archivedAt: 5_000 } };
    expect(needsOperatorAttention(assigned({ status: "review", ...archived }))).toBe(false);
    expect(
      needsOperatorAttention(
        createWorkboardCard({ status: "review", labels: ["decision"], ...archived }),
      ),
    ).toBe(false);
  });
});

describe("Workboard attention reasons", () => {
  it("lists every applicable reason and agrees with the marker on each card", () => {
    const archived = { metadata: { archivedAt: 5_000 } };
    const cases: Array<[WorkboardCard, string[]]> = [
      [createWorkboardCard({ status: "review", labels: ["decision"] }), ["review"]],
      [assigned({ status: "review" }), ["review"]],
      [assigned({ status: "blocked", labels: [" Decision "] }), ["decision"]],
      [createWorkboardCard({ status: "blocked", labels: ["decision"] }), ["decision"]],
      [assigned({ agentId: "   ", status: "todo" }), ["unowned"]],
      [assigned({ status: "running", labels: ["decision"] }), []],
      [createWorkboardCard({ status: "scheduled" }), []],
      [createWorkboardCard({ status: "done" }), []],
      [assigned({ labels: ["infra"] }), []],
      [createWorkboardCard({ status: "review", labels: ["decision"], ...archived }), []],
    ];
    for (const [card, reasons] of cases) {
      expect(workboardAttentionReasons(card)).toEqual(reasons);
      expect(needsOperatorAttention(card)).toBe(reasons.length > 0);
    }
  });

  it("puts the decision label above a stored kind, exactly like the shared predicate", () => {
    // The label wins in `workboardOperatorAskKind`, so the lens must not read two disagreeing
    // values off one card.
    const card = assigned({
      status: "blocked",
      labels: ["decision"],
      metadata: { automation: { askKind: "input" } },
    });
    expect(workboardAttentionReasons(card)).toEqual(["decision"]);
  });
});

describe("Workboard attention since", () => {
  it("uses the latest move into the current status", () => {
    const card = assigned({
      status: "review",
      createdAt: 100,
      events: [
        { id: "e1", kind: "moved", at: 200, fromStatus: "running", toStatus: "review" },
        { id: "e2", kind: "moved", at: 300, fromStatus: "review", toStatus: "running" },
        { id: "e3", kind: "moved", at: 400, fromStatus: "running", toStatus: "review" },
      ],
    });
    expect(attentionSinceMs(card)).toBe(400);
  });

  it("falls back to createdAt without a move into the current status", () => {
    const card = createWorkboardCard({
      status: "todo",
      createdAt: 150,
      events: [{ id: "e1", kind: "moved", at: 250, fromStatus: "todo", toStatus: "ready" }],
    });
    expect(attentionSinceMs(card)).toBe(150);
  });

  it("ignores a later edit, which records no label or agent change", () => {
    const card = assigned({
      status: "blocked",
      labels: ["decision"],
      createdAt: 100,
      updatedAt: 900,
      events: [
        { id: "e1", kind: "moved", at: 500, fromStatus: "running", toStatus: "blocked" },
        { id: "e2", kind: "edited", at: 900 },
      ],
    });
    expect(attentionSinceMs(card)).toBe(500);
  });
});

describe("Workboard inbox order", () => {
  const ids = (cards: WorkboardCard[]) =>
    workboardInboxEntries(cards).map((entry) => entry.card.id);

  function decisionCard(id: string, overrides: Partial<WorkboardCard> = {}) {
    return createWorkboardCard({ id, status: "blocked", labels: ["decision"], ...overrides });
  }

  it("orders decision before review before unowned, whatever the priority", () => {
    // The discriminating case: a low-priority decision beats an urgent review, and an urgent
    // unowned card never overtakes a normal review. Priority only decides inside one tier.
    expect(
      ids([
        createWorkboardCard({ id: "unowned-urgent", status: "todo", priority: "urgent" }),
        createWorkboardCard({ id: "review-urgent", status: "review", priority: "urgent" }),
        decisionCard("decision-low", { priority: "low" }),
        createWorkboardCard({ id: "review-normal", status: "review" }),
      ]),
    ).toEqual(["decision-low", "review-urgent", "review-normal", "unowned-urgent"]);
  });

  it("keeps the stored-kind ask in the decision tier", () => {
    expect(
      ids([
        createWorkboardCard({ id: "review", status: "review" }),
        createWorkboardCard({
          id: "input",
          status: "blocked",
          metadata: { automation: { askKind: "input" } },
        }),
      ]),
    ).toEqual(["input", "review"]);
  });

  it("orders urgent before high before normal before low within one tier", () => {
    const cards = (["low", "urgent", "normal", "high"] as const).map((priority) =>
      createWorkboardCard({ id: priority, priority, status: "review" }),
    );
    expect(ids(cards)).toEqual(["urgent", "high", "normal", "low"]);
  });

  it("puts the longest-waiting card first within one priority", () => {
    const cards = [
      createWorkboardCard({ id: "newer", status: "review", createdAt: 300 }),
      createWorkboardCard({ id: "older", status: "review", createdAt: 100 }),
    ];
    expect(ids(cards)).toEqual(["older", "newer"]);
  });

  it("breaks a full tie by id and leaves out cards that need nothing", () => {
    const cards = [
      createWorkboardCard({ id: "b", status: "review" }),
      assigned({ id: "busy" }),
      createWorkboardCard({ id: "a", status: "review" }),
    ];
    expect(ids(cards)).toEqual(["a", "b"]);
    expect(workboardInboxEntries(cards)[0]).toMatchObject({
      reasons: ["review"],
      reason: "review",
      tier: 1,
      since: 1,
    });
  });

  it("keeps one entry per card even when a card would qualify for two reasons", () => {
    // Today the three gates are disjoint (see the test above), so this asserts the shape the
    // lens relies on: one entry per card, carrying the whole reason list and the tier of its
    // first reason. A future rule that widens a reason must not produce a second entry.
    const entries = workboardInboxEntries([
      createWorkboardCard({ id: "both", status: "review", labels: ["decision"], priority: "low" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reasons[0]).toBe(entries[0]?.reason);
    expect(entries[0]?.tier).toBe(WORKBOARD_ATTENTION_REASON_TIERS[entries[0]!.reason]);
  });
});

describe("Workboard inbox partition", () => {
  it("splits the operator's steps from the agentless rest and keeps the order", () => {
    const entries = workboardInboxEntries([
      createWorkboardCard({ id: "unowned-1", status: "backlog" }),
      createWorkboardCard({ id: "unowned-2", status: "todo", priority: "urgent" }),
      createWorkboardCard({
        id: "input",
        status: "blocked",
        metadata: { automation: { askKind: "input" } },
      }),
      createWorkboardCard({ id: "review", status: "review" }),
    ]);
    const { headline, unowned } = partitionWorkboardInboxEntries(entries);
    expect(headline.map((entry) => entry.card.id)).toEqual(["input", "review"]);
    expect(unowned.map((entry) => entry.card.id)).toEqual(["unowned-2", "unowned-1"]);
    // Every entry lands in exactly one group, in the order the inbox produced.
    expect([...headline, ...unowned].map((entry) => entry.card.id)).toEqual(
      entries.map((entry) => entry.card.id),
    );
    expect(unowned.every(isWorkboardInboxUnownedEntry)).toBe(true);
    expect(headline.some(isWorkboardInboxUnownedEntry)).toBe(false);
  });

  it("leaves both groups empty for an empty inbox", () => {
    expect(partitionWorkboardInboxEntries([])).toEqual({ headline: [], unowned: [] });
  });
});
