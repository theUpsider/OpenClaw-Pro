import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { WORKBOARD_FACE_DECIDE_DELAY_MS } from "./view-inbox-face.tsx";
import { createWorkboardView } from "./view.test-support.ts";

const notes = "Which store should this use?\n- [ ] SQLite\n- [ ] Postgres";

function decisionCard(overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  return createWorkboardCard({
    id: "decision-card",
    title: "Pick a store",
    status: "blocked",
    labels: ["decision"],
    notes,
    ...overrides,
  });
}

function reviewCard(overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  return createWorkboardCard({
    id: "review-card",
    title: "Accept the report",
    status: "review",
    agentId: "b",
    notes: "Stand: The report is written and the gates are green.\nWas: Rewrote the report.",
    metadata: {
      proof: [{ id: "p1", status: "passed", createdAt: 3, url: "https://example.com/proof" }],
    },
    ...overrides,
  });
}

/**
 * The face settles through `card-settle.ts` and the mutations owner, which both read the live
 * client and the store, so this builds one mocked Gateway client whose responses carry the card
 * forward and let the write path complete.
 */
function faceView(cards: WorkboardCard[], canWrite = true) {
  let current = cards;
  let revision = 10;
  const client = createWorkboardTestClient(async (method, params) => {
    const record = params as { id?: string; status?: string; body?: string };
    const card = current.find((entry) => entry.id === record.id) ?? cards[0]!;
    if (method === "workboard.cards.comment") {
      revision += 1;
      return {
        card: {
          ...card,
          updatedAt: revision,
          metadata: {
            ...card.metadata,
            comments: [{ id: `c${revision}`, body: record.body ?? "", createdAt: revision }],
          },
        },
      };
    }
    revision += 1;
    const moved: WorkboardCard = {
      ...card,
      status: "ready",
      labels: card.labels.filter((label) => label !== "decision"),
      updatedAt: revision,
    };
    current = current.map((entry) => (entry.id === card.id ? moved : entry));
    return { card: moved };
  });
  const view = createWorkboardView({
    client,
    canWrite,
    onRequestUpdate: () => view.renderView(),
  });
  view.state.cards = cards;
  view.state.attentionInbox = true;
  view.renderView();
  return { ...view, client };
}

function faces(container: Element) {
  return [...container.querySelectorAll<HTMLElement>(".workboard-face")];
}

function face(container: Element, index = 0) {
  return expectDefined(faces(container)[index], `face ${index}`);
}

function optionButtons(root: Element) {
  return [...root.querySelectorAll<HTMLButtonElement>(".workboard-face__option")];
}

function actionButton(root: Element, label: string) {
  return expectDefined(
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ),
    label,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("needs-you face wiring", () => {
  it("renders the option buttons of a decision card and only SCHEDULES the write on activation", async () => {
    const card = decisionCard();
    const { container, client, state } = faceView([card]);
    const panel = face(container);
    expect(panel.getAttribute("aria-label")).toBe("Decide: Pick a store");
    expect(panel.querySelector(".workboard-face__strip")?.textContent).toContain("Decision");
    expect(panel.querySelector(".workboard-face__question")?.textContent).toBe(
      "Which store should this use?",
    );

    // The options come from the notes' task items through the shared resolver.
    const options = optionButtons(panel);
    expect(
      options.map((button) => button.querySelector(".workboard-face__option-label")?.textContent),
    ).toEqual(["SQLite", "Postgres"]);
    expect(options[0]?.getAttribute("aria-label")).toBe("Choose: SQLite");

    // Activation must not write immediately: a `ready` card can be claimed by a dispatch before
    // an Undo could be clicked, so the write waits for the countdown.
    vi.useFakeTimers();
    options[1]!.click();
    flush();
    expect(client.request).not.toHaveBeenCalled();
    expect(panel.querySelector(".workboard-face__pending")?.textContent).toContain(
      "Deciding: Postgres",
    );

    // Undo cancels the pending write; nothing was written, so the card never moved.
    expectDefined(panel.querySelector<HTMLButtonElement>(".workboard-face__undo"), "undo").click();
    flush();
    await vi.advanceTimersByTimeAsync(WORKBOARD_FACE_DECIDE_DELAY_MS + 1);
    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards[0]?.status).toBe("blocked");
    expect(panel.querySelector(".workboard-face__pending")?.textContent).toBe("");
  });

  it("writes the decision once the countdown expires", async () => {
    const card = decisionCard();
    const { container, client, state } = faceView([card]);
    vi.useFakeTimers();
    optionButtons(face(container))[0]!.click();
    flush();
    await vi.advanceTimersByTimeAsync(WORKBOARD_FACE_DECIDE_DELAY_MS + 1);
    await waitForFast(() => expect(state.cards[0]?.status).toBe("ready"));
    expect(vi.mocked(client.request).mock.calls).toEqual([
      ["workboard.cards.comment", { id: card.id, body: "Decision: SQLite" }],
      [
        "workboard.cards.move",
        {
          id: card.id,
          status: "ready",
          position: expect.any(Number),
          labelsRemove: ["decision"],
          expectedUpdatedAt: expect.any(Number),
        },
      ],
    ]);
    expect(state.cards[0]?.labels).toEqual([]);
  });

  it("refuses the queued write when the card moved on during the countdown", async () => {
    const card = decisionCard();
    const { container, client, state } = faceView([card]);
    const panel = face(container);
    vi.useFakeTimers();
    optionButtons(panel)[0]!.click();
    flush();
    // The store's own read advanced while the operator was still deciding.
    state.cards = [{ ...card, updatedAt: card.updatedAt + 1 }];
    await vi.advanceTimersByTimeAsync(WORKBOARD_FACE_DECIDE_DELAY_MS + 1);
    expect(client.request).not.toHaveBeenCalled();
    expect(panel.querySelector(".workboard-face__error")?.textContent).toBe(
      "The board is busy. Try again in a moment.",
    );
    expect(state.cards[0]?.status).toBe("blocked");
  });

  it("renders the review face with its result line, evidence and no decision options", () => {
    const { container } = faceView([reviewCard()]);
    const panel = face(container);
    expect(panel.getAttribute("aria-label")).toBe("Review: Accept the report");
    expect(panel.querySelector(".workboard-face__strip")?.textContent).toContain("Review");
    expect(panel.querySelector(".workboard-face__question")?.textContent).toBe(
      "The report is written and the gates are green.",
    );
    expect(panel.querySelector(".workboard-face__evidence-counts")?.textContent).toBe("1 proof");
    expect(panel.querySelector<HTMLAnchorElement>(".workboard-face__evidence-link")?.href).toBe(
      "https://example.com/proof",
    );
    // A review card offers accept/send back, never decision options.
    expect(optionButtons(panel)).toHaveLength(0);
  });

  it("marks a review card without proof and makes acceptance the side action", () => {
    const { container } = faceView([reviewCard({ id: "no-proof", metadata: undefined })]);
    const panel = face(container);
    const none = panel.querySelector(".workboard-face__evidence-none");
    expect(none?.textContent).toContain("No proof");
    expect(none?.getAttribute("title")).toContain("blind");
    // Blind acceptance is deliberate, so it is not the one filled action.
    expect(actionButton(panel, "Accept anyway").classList.contains("primary")).toBe(false);
  });

  it("scopes the digit shortcut to the focused panel", async () => {
    // Several decision cards in one lens must not all claim 1-4, or one keypress would settle
    // every card on screen.
    const first = decisionCard({ id: "first", title: "First decision" });
    const second = decisionCard({ id: "second", title: "Second decision", position: 2000 });
    const { container, client, state } = faceView([first, second]);
    const panels = faces(container);
    expect(panels).toHaveLength(2);
    vi.useFakeTimers();
    panels[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "1" }));
    flush();
    await vi.advanceTimersByTimeAsync(WORKBOARD_FACE_DECIDE_DELAY_MS + 1);
    await waitForFast(() =>
      expect(state.cards.find((entry) => entry.id === "first")?.status).toBe("ready"),
    );
    expect(state.cards.find((entry) => entry.id === "second")?.status).toBe("blocked");
    expect(
      vi
        .mocked(client.request)
        .mock.calls.filter(([method]) => method === "workboard.cards.comment"),
    ).toHaveLength(1);
  });

  it("gives each face its own accessible name and heading", () => {
    const { container } = faceView([decisionCard(), reviewCard()]);
    expect(
      [...container.querySelectorAll(".workboard-face__title")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["Pick a store", "Accept the report"]);
    expect(new Set(faces(container).map((panel) => panel.getAttribute("aria-label"))).size).toBe(2);
  });

  it("keeps the face out of the card's own article element", () => {
    // The card root is a `role="button"` article: form controls inside it would be nested
    // interactive content (WCAG 4.1.2), and the card's drag would fight text selection. The
    // face is therefore a sibling of the card inside the same list item.
    const { container } = faceView([decisionCard()]);
    const article = expectDefined(container.querySelector("article.workboard-card"), "card");
    expect(article.querySelector(".workboard-face")).toBeNull();
    expect(article.querySelector("button.workboard-face__option")).toBeNull();
    const panel = face(container);
    expect(panel.closest("article")).toBeNull();
    expect(panel.parentElement).toBe(article.parentElement);
    expect(panel.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("disables every control on a read-only board", () => {
    const { container } = faceView([decisionCard()], false);
    const panel = face(container);
    expect(optionButtons(panel).every((button) => button.disabled)).toBe(true);
    // No keyboard hint on a read-only board: there is nothing to press a digit for.
    expect(panel.querySelector(".workboard-face__hint")?.textContent).toContain("read-only");
  });

  it("announces the pending decision in a live region", () => {
    const { container } = faceView([decisionCard()]);
    const panel = face(container);
    const status = expectDefined(panel.querySelector(".workboard-face__pending"), "pending status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    vi.useFakeTimers();
    optionButtons(panel)[0]!.click();
    flush();
    expect(status.textContent).toContain("Deciding: SQLite");
  });

  it("sends a review card back only with a reason", async () => {
    const card = reviewCard();
    const { container, client, state } = faceView([card]);
    const panel = face(container);
    actionButton(panel, "Send back...").click();
    flush();
    const chips = [...panel.querySelectorAll<HTMLButtonElement>(".workboard-face__chip")];
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual([
      "No proof",
      "Not what was asked",
      "Unfinished",
    ]);
    // Without a reason there is nothing for the agent to act on, so the write stays blocked.
    const submit = expectDefined(
      [...panel.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.textContent?.trim() === "Send back" && button.classList.contains("primary"),
      ),
      "send back submit",
    );
    expect(submit.disabled).toBe(true);

    chips[0]!.click();
    flush();
    expect(submit.disabled).toBe(false);
    submit.click();
    await waitForFast(() =>
      expect(state.cards.find((entry) => entry.id === card.id)?.status).toBe("ready"),
    );
    expect(vi.mocked(client.request).mock.calls).toEqual([
      ["workboard.cards.comment", { id: card.id, body: "No proof" }],
      [
        "workboard.cards.move",
        { id: card.id, status: "ready", position: expect.any(Number), expectedUpdatedAt: 11 },
      ],
    ]);
  });

  it("counts the card in the store the face reads, so the write targets the live card", () => {
    const { host, container } = faceView([decisionCard()]);
    expect(getWorkboardState(host).cards.map((entry) => entry.id)).toEqual(["decision-card"]);
    expect(face(container).querySelector(".workboard-face__option")).toBeTruthy();
  });

  it("keeps the stored order and numbering, marking the recommendation without moving it", () => {
    // The drawer numbers by the STORED order ("the list order is the number"), and its digit
    // handler picks by that order. If the face pulled the recommended option to position 1 and
    // renumbered, one card would have two mappings for "2", and an agent note saying "option 2"
    // could point at the wrong button. The recommendation is therefore only marked, never moved.
    const stored = [
      { label: "Tenant A" },
      { label: "Tenant B" },
      { label: "Tenant C" },
      { label: "Tenant D", description: "The sandbox tenant.", recommended: true },
    ];
    const card = decisionCard({ metadata: { automation: { decisionOptions: stored } } });
    const { container } = faceView([card]);
    const panel = face(container);
    const options = optionButtons(panel);

    // Numbers and order follow the stored list, with the recommendation in place at position 4.
    expect(
      options.map((button) => button.querySelector(".workboard-face__option-label")?.textContent),
    ).toEqual(["Tenant A", "Tenant B", "Tenant C", "Tenant D"]);
    expect(
      options.map((button) => button.querySelector(".workboard-face__option-number")?.textContent),
    ).toEqual(["1.", "2.", "3.", "4."]);
    expect(options.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Choose: Tenant A",
      "Choose: Tenant B",
      "Choose: Tenant C",
      "Recommendation: Tenant D",
    ]);
    // The recommended option is the visually marked one: filled plus the text marker.
    const marked = options.filter((button) => button.classList.contains("primary"));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("Tenant D");
    expect(marked[0]?.querySelector(".workboard-face__option-mark")?.textContent).toContain(
      "Recommendation",
    );

    // The digit that picks position 2 is the stored second option, same as in the drawer.
    vi.useFakeTimers();
    panel.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "2" }));
    flush();
    expect(panel.querySelector(".workboard-face__pending")?.textContent).toContain(
      "Deciding: Tenant B",
    );
  });

  it("puts the roving tab stop on the recommended option without moving it", () => {
    // The face keeps the stored order (previous test), so "recommended first" can only survive as
    // focus order: the option Tab reaches must be the recommended one, not the first stored.
    const stored = [
      { label: "Tenant A" },
      { label: "Tenant B" },
      { label: "Tenant C", description: "The sandbox tenant.", recommended: true },
    ];
    const card = decisionCard({ metadata: { automation: { decisionOptions: stored } } });
    const { container } = faceView([card]);
    const options = optionButtons(face(container));

    expect(options.map((button) => button.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
  });

  it("falls back to the first option when nothing is recommended", () => {
    const card = decisionCard({
      metadata: { automation: { decisionOptions: [{ label: "Tenant A" }, { label: "Tenant B" }] } },
    });
    const { container } = faceView([card]);
    const options = optionButtons(face(container));

    expect(options.map((button) => button.getAttribute("tabindex"))).toEqual(["0", "-1"]);
  });

  it("writes the decision the operator already made when the face unmounts", async () => {
    // Leaving the lens (or any view change) disposes the face. The operator saw "Deciding: X"
    // and made the decision; only the confirmation window was cut short, so the write must
    // still happen rather than vanish with the component.
    const card = decisionCard();
    const { container, client, state, renderView } = faceView([card]);
    const panel = face(container);
    optionButtons(panel)[0]!.click();
    flush();
    expect(client.request).not.toHaveBeenCalled();

    // The lens is switched off: the face unmounts, the card stays in the store at the same
    // revision the click captured.
    state.attentionInbox = false;
    renderView();
    expect(faces(container)).toHaveLength(0);

    await waitForFast(() => expect(state.cards[0]?.status).toBe("ready"));
    expect(vi.mocked(client.request).mock.calls).toEqual([
      ["workboard.cards.comment", { id: card.id, body: "Decision: SQLite" }],
      [
        "workboard.cards.move",
        {
          id: card.id,
          status: "ready",
          position: expect.any(Number),
          labelsRemove: ["decision"],
          expectedUpdatedAt: expect.any(Number),
        },
      ],
    ]);
  });

  it("leads the decision face with the operator's own question line", () => {
    // The convention puts the operator question in the note's PREAMBLE as `Braucht von the operator:`
    // (decision) or `Wartet auf:` (waiting). Reading only `Naechster Schritt` would show the
    // agent's next action instead of what the operator is being asked -- and on the live board the
    // one real decision card leads with exactly that line. No card has `ask` set yet, so this is
    // the path that matters today.
    const card = decisionCard({
      notes:
        "Braucht von the operator: zwei getrennte Freigaben, einzeln waehlbar.\n" +
        "Stand: Geraetevorbereitung ohne Geraet fertig.\n" +
        "Naechster Schritt: deine Wahl, dann kurzer Geraetelauf.",
    });
    const { container } = faceView([card]);

    expect(face(container).querySelector(".workboard-face__question")?.textContent).toBe(
      "Braucht von the operator: zwei getrennte Freigaben, einzeln waehlbar.",
    );
  });

  it("cuts the question at a line break, not at a sentence period", () => {
    // A sentence splitter truncates German mid-abbreviation: "bis 14. November" became "bis 14.".
    // The rule is the first LINE, capped, so an ordinal or an abbreviation cannot cut the text.
    const card = decisionCard({
      notes: "Braucht von the operator: entscheide bis 14. November, ob wir das machen.\nStand: offen.",
    });
    const { container } = faceView([card]);

    expect(face(container).querySelector(".workboard-face__question")?.textContent).toBe(
      "Braucht von the operator: entscheide bis 14. November, ob wir das machen.",
    );
  });

  it("records a visible error when the card moved on before the unmounted face could write", async () => {
    // The other half of the same rule: an unmount must never end silently. When the card no
    // longer carries the revision the click captured, the write is refused and the refusal is
    // recorded on the board state, which outlives the disposed face. The message names the card:
    // the operator has left the lens and cannot tell which decision was not written.
    const card = decisionCard();
    const { container, client, state, renderView } = faceView([card]);
    optionButtons(face(container))[0]!.click();
    flush();

    state.cards = [{ ...card, updatedAt: card.updatedAt + 1 }];
    state.attentionInbox = false;
    renderView();
    expect(faces(container)).toHaveLength(0);

    await waitForFast(() =>
      expect(state.error).toBe(
        `Your decision on \u201c${card.title}\u201d was not recorded: the card changed while you decided. Open the card and decide again.`,
      ),
    );
    expect(client.request).not.toHaveBeenCalled();
  });

  it("reads the note's sections through the notes owner, including a CRLF note", () => {
    // A second reader that split on "\n" would leave the trailing "\r" on the line, fail to
    // match the label and leak `Stand:` / `Nächster Schritt:` into what the face shows. The
    // notes owner splits on `\r?\n`, so both line endings read the same.
    const crlfReview = reviewCard({
      notes: "Stand: The report is written and the gates are green.\r\nWas: Rewrote the report.",
    });
    const crlfDecision = decisionCard({
      notes: "Was: Prepared the drill.\r\nNächster Schritt: Which tenant should the drill land in?",
    });
    const { container } = faceView([crlfDecision, crlfReview]);

    const question = face(container, 0).querySelector(".workboard-face__question")?.textContent;
    expect(question).toBe("Which tenant should the drill land in?");
    expect(question).not.toContain("Nächster Schritt");

    const reviewLine = face(container, 1).querySelector(".workboard-face__question")?.textContent;
    expect(reviewLine).toBe("The report is written and the gates are green.");
    expect(reviewLine).not.toContain("Stand");
  });
});
