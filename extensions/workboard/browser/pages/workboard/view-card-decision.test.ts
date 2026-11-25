import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardDecisionOption } from "../../lib/workboard/types.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { createWorkboardView, requireButton, textButton } from "./view.test-support.ts";

describe("decision card", () => {
  function decisionView(
    notes = "Pick a store",
    onComment?: () => void | Promise<void>,
    decisionOptions?: WorkboardDecisionOption[],
  ) {
    const card = createWorkboardCard({
      status: "blocked",
      labels: ["decision"],
      notes,
      ...(decisionOptions ? { metadata: { automation: { decisionOptions } } } : {}),
    });
    const client = createWorkboardTestClient(async (method, params) => {
      const record = params as { body?: string; status?: string; labelsRemove?: string[] };
      if (method === "workboard.cards.comment") {
        await onComment?.();
        return {
          card: {
            ...card,
            updatedAt: 2,
            metadata: {
              ...card.metadata,
              comments: [{ id: "c1", body: record.body, createdAt: 2 }],
            },
          },
        };
      }
      const labels = card.labels.filter((label) => !record.labelsRemove?.includes(label));
      return { card: { ...card, status: record.status, labels, updatedAt: 3 } };
    });
    const view = createWorkboardView({ client, onRequestUpdate: () => view.renderView() });
    view.state.cards = [card];
    view.state.detailCardId = card.id;
    view.renderView();
    const content = expectDefined(
      view.container.querySelector<HTMLElement>(".workboard-detail__content"),
      "detail content",
    );
    return { ...view, card, client, content };
  }

  it("shows why the card waits above the notes, and nothing for a finished card", () => {
    const { content, state, renderView } = decisionView();
    const line = content.querySelector(".workboard-waiting");
    expect(line?.textContent).toBe("Waiting on you: this card needs your decision.");
    expect(content.firstElementChild).toBe(line);
    expect(line?.nextElementSibling?.tagName.toLowerCase()).toBe("workboard-inline-text");
    state.cards = [createWorkboardCard({ status: "done" })];
    renderView();
    expect(content.querySelector(".workboard-waiting")).toBeNull();
  });

  function typeDecision(content: HTMLElement, value: string) {
    const input = expectDefined(
      content.querySelector<HTMLTextAreaElement>(".workboard-decision__input"),
      "decision input",
    );
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    return input;
  }

  it("records a typed decision, moves the card to Ready, and drops its decision label", async () => {
    const { container, content, client, card, state } = decisionView(
      "Which store?\n- [ ] SQLite\n- [ ] Postgres",
    );
    typeDecision(content, "Use SQLite behind a flag");
    textButton(content, "Decision made").click();
    await waitForFast(() => expect(state.cards[0]?.status).toBe("ready"));
    expect(vi.mocked(client.request).mock.calls).toEqual([
      ["workboard.cards.comment", { id: card.id, body: "Decision: Use SQLite behind a flag" }],
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
    expect(state.error).toBeNull();
    expect(container.querySelector(".workboard-decision")).toBeNull();
  });

  it("reports a decision whose move a dispatch refused, and lets the operator decide again", async () => {
    let dispatchStarted = false;
    const view = decisionView("Pick a store", () => {
      // A dispatch run starts while the first comment is in flight.
      view.state.dispatching = !dispatchStarted;
      dispatchStarted = true;
    });
    const { container, content, client, card, state } = view;
    const input = typeDecision(content, "Use SQLite");
    textButton(content, "Decision made").click();
    await waitForFast(() =>
      expect(state.error).toBe(
        "Your decision comment was saved, but the card could not move to Ready. Deciding again records a second comment.",
      ),
    );
    expect(vi.mocked(client.request).mock.calls.map(([method]) => method)).toEqual([
      "workboard.cards.comment",
    ]);
    expect(state.cards[0]).toMatchObject({ status: "blocked", labels: ["decision"] });
    await waitForFast(() =>
      expect(
        container.querySelector("openclaw-workboard-toast:not([hidden]) [role='alert']")
          ?.textContent,
      ).toBe(state.error),
    );
    expect(container.querySelector(".workboard-decision")).not.toBeNull();
    expect(input.value).toBe("Use SQLite");

    state.dispatching = false;
    view.renderView();
    textButton(content, "Decision made").click();
    await waitForFast(() => expect(state.cards[0]?.status).toBe("ready"));
    expect(client.request).toHaveBeenLastCalledWith("workboard.cards.move", {
      id: card.id,
      status: "ready",
      position: expect.any(Number),
      labelsRemove: ["decision"],
      expectedUpdatedAt: expect.any(Number),
    });
    expect(state.cards[0]?.labels).toEqual([]);
    expect(container.querySelector(".workboard-decision")).toBeNull();
  });

  it("keeps the card a blocked decision when the operator only adds a note", async () => {
    const { container, content, client, card, state } = decisionView();
    typeDecision(content, "Asking Alex first");
    textButton(content, "Add note").click();
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.comment", {
        id: card.id,
        body: "Decision: Asking Alex first",
      }),
    );
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(state.cards[0]).toMatchObject({ status: "blocked", labels: ["decision"] });
    expect(state.error).toBeNull();
    expect(container.querySelector(".workboard-decision")).not.toBeNull();
  });

  it("offers the notes' unchecked task items as one-click choices", async () => {
    const { container, content, client, card, state } = decisionView(
      "Which store?\n- [ ] SQLite\n- [ ] Postgres",
    );
    const options = content.querySelectorAll(".workboard-decision__option");
    expect(
      [...options].map((option) => [
        option.querySelector(".workboard-decision__option-number")?.textContent,
        option.querySelector(".workboard-decision__option-label")?.textContent,
      ]),
    ).toEqual([
      ["1.", "SQLite"],
      ["2.", "Postgres"],
    ]);
    requireButton(content, "Decide: Postgres").click();
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.move", {
        id: card.id,
        status: "ready",
        position: expect.any(Number),
        labelsRemove: ["decision"],
        expectedUpdatedAt: expect.any(Number),
      }),
    );
    expect(client.request).toHaveBeenCalledWith("workboard.cards.comment", {
      id: card.id,
      body: "Decision: Postgres",
    });
    await waitForFast(() => expect(state.cards[0]).toMatchObject({ status: "ready", labels: [] }));
    expect(container.querySelector(".workboard-decision")).toBeNull();
  });

  it("shows no decision block on cards that are not blocked decisions", () => {
    const { container, state, renderView } = createWorkboardView();
    state.cards = [createWorkboardCard({ status: "blocked", labels: ["waiting"] })];
    state.detailCardId = "card-1";
    renderView();
    expect(container.querySelector(".workboard-decision")).toBeNull();
    expect(container.querySelector(".workboard-waiting")?.textContent).toBe(
      "Blocked. No reason was recorded.",
    );
  });
  const storeOptions: WorkboardDecisionOption[] = [
    { label: "SQLite", description: "One file, no server to run." },
    { label: "Postgres", description: "Scales past one writer; needs a host.", recommended: true },
    { label: "Keep JSON files" },
  ];

  function radios(content: HTMLElement) {
    return [...content.querySelectorAll<HTMLButtonElement>("[role='radiogroup'] [role='radio']")];
  }

  function key(target: Element, value: string) {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    flush();
    return event;
  }

  async function expectDecided(view: ReturnType<typeof decisionView>, label: string) {
    await waitForFast(() => expect(view.state.cards[0]?.status).toBe("ready"));
    expect(vi.mocked(view.client.request).mock.calls).toEqual([
      ["workboard.cards.comment", { id: view.card.id, body: `Decision: ${label}` }],
      [
        "workboard.cards.move",
        {
          id: view.card.id,
          status: "ready",
          position: expect.any(Number),
          labelsRemove: ["decision"],
          expectedUpdatedAt: expect.any(Number),
        },
      ],
    ]);
    expect(view.state.cards[0]?.labels).toEqual([]);
    expect(view.container.querySelector(".workboard-decision")).toBeNull();
  }

  it("numbers structured options in the agent's order with one recommended badge", () => {
    const { content } = decisionView("Which store?\n- [ ] Notes option", undefined, storeOptions);
    const group = expectDefined(content.querySelector("[role='radiogroup']"), "radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Choices from the agent");
    const options = radios(content);
    expect(
      options.map((option) => [
        option.querySelector(".workboard-decision__option-number")?.textContent,
        option.querySelector(".workboard-decision__option-label")?.textContent,
        option.querySelector(".workboard-decision__option-description")?.textContent,
      ]),
    ).toEqual([
      ["1.", "SQLite", "One file, no server to run."],
      ["2.", "Postgres", "Scales past one writer; needs a host."],
      ["3.", "Keep JSON files", undefined],
    ]);
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(options.map((option) => option.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    const badges = content.querySelectorAll(".workboard-decision__recommended");
    expect([...badges].map((badge) => badge.textContent)).toEqual(["Recommended"]);
    expect(options[1]?.contains(badges[0] ?? null)).toBe(true);
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
      "Decide: SQLite",
      "Decide: Postgres (recommended)",
      "Decide: Keep JSON files",
    ]);
    const description = expectDefined(
      options[0]?.getAttribute("aria-describedby"),
      "description id",
    );
    expect(content.querySelector(`[id="${description}"]`)?.textContent).toBe(
      "One file, no server to run.",
    );
    expect(group.textContent).not.toContain("Notes option");
    expect(
      expectDefined(
        content.querySelector<HTMLTextAreaElement>(".workboard-decision__input"),
        "answer field",
      ).value,
    ).toBe("");
  });

  it("decides an option on click with the same comment and move as Decision made", async () => {
    const view = decisionView("Pick a store", undefined, storeOptions);
    expectDefined(radios(view.content)[1], "option 2").click();
    await expectDecided(view, "Postgres");
  });

  it("renders option labels and descriptions as Markdown inside the radio row", () => {
    const { content } = decisionView("Pick a store", undefined, [
      { label: "Ship **now**", description: "covers `logs` and _traces_" },
      { label: "Wait" },
    ]);
    const option = expectDefined(radios(content)[0], "option 1");
    // Markdown reaches the host mount, not the literal label.
    const mounts = [...option.querySelectorAll<HTMLElement>("[data-test-markdown]")];
    expect(mounts.map((element) => element.getAttribute("data-markdown"))).toEqual([
      "Ship **now**",
      "covers `logs` and _traces_",
    ]);
    // Both mounts are inline: a label inside a radio button must stay phrasing content.
    for (const element of mounts) {
      expect((element as { props?: { inline?: boolean } }).props?.inline).toBe(true);
    }
    // The accessible name stays the plain label; the radio is a valid control.
    expect(option.getAttribute("aria-label")).toBe("Decide: Ship **now**");
    expect(option.tagName.toLowerCase()).toBe("button");
  });

  it("digit keys decide outside text fields", async () => {
    const view = decisionView("Pick a store", undefined, storeOptions);
    const first = expectDefined(radios(view.content)[0], "option 1");
    first.focus();
    expect(key(first, "2").defaultPrevented).toBe(true);
    await expectDecided(view, "Postgres");
  });

  it("a digit typed into the answer field decides nothing and stays text", async () => {
    const view = decisionView("Pick a store", undefined, storeOptions);
    const input = expectDefined(
      view.content.querySelector<HTMLTextAreaElement>(".workboard-decision__input"),
      "answer field",
    );
    input.focus();
    // The browser inserts the character only when keydown is not prevented.
    expect(key(input, "2").defaultPrevented).toBe(false);
    typeDecision(view.content, "2");
    await Promise.resolve();
    expect(view.client.request).not.toHaveBeenCalled();
    expect(input.value).toBe("2");
    expect(radios(view.content).map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "false",
    ]);
    expect(view.state.cards[0]).toMatchObject({ status: "blocked", labels: ["decision"] });
  });

  it("arrow keys only move focus; Enter decides the focused option", async () => {
    const view = decisionView("Pick a store", undefined, storeOptions);
    const options = radios(view.content);
    expectDefined(options[0], "option 1").focus();
    key(expectDefined(options[0], "option 1"), "ArrowDown");
    expect(document.activeElement).toBe(options[1]);
    key(expectDefined(options[1], "option 2"), "End");
    expect(document.activeElement).toBe(options[2]);
    key(expectDefined(options[2], "option 3"), "ArrowDown");
    expect(document.activeElement).toBe(options[0]);
    key(expectDefined(options[0], "option 1"), "ArrowUp");
    expect(document.activeElement).toBe(options[2]);
    key(expectDefined(options[2], "option 3"), "Home");
    key(expectDefined(options[0], "option 1"), "ArrowRight");
    expect(document.activeElement).toBe(options[1]);
    expect(options.map((option) => option.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    expect(view.client.request).not.toHaveBeenCalled();

    expect(key(expectDefined(options[1], "option 2"), "Enter").defaultPrevented).toBe(true);
    await expectDecided(view, "Postgres");
  });

  it("marks only the first of two recommended options", () => {
    const { content } = decisionView("Pick a store", undefined, [
      { label: "A" },
      { label: "B", recommended: true },
      { label: "C", recommended: true },
    ]);
    const badges = content.querySelectorAll(".workboard-decision__recommended");
    expect(badges).toHaveLength(1);
    expect(radios(content)[1]?.contains(badges[0] ?? null)).toBe(true);
    expect(radios(content)[2]?.getAttribute("aria-label")).toBe("Decide: C");
  });

  it("numbers the notes' task items without badge or description", () => {
    const { content } = decisionView("Which store?\n- [ ] SQLite\n- [ ] Postgres");
    expect(content.querySelector("[role='radiogroup']")?.getAttribute("aria-label")).toBe(
      "Options from the card notes",
    );
    expect(radios(content).map((option) => option.getAttribute("aria-label"))).toEqual([
      "Decide: SQLite",
      "Decide: Postgres",
    ]);
    expect(content.querySelector(".workboard-decision__recommended")).toBeNull();
    expect(content.querySelector(".workboard-decision__option-description")).toBeNull();
  });

  it("shows only the answer field when the card has no options", () => {
    const { content } = decisionView("Pick a store, nothing to tick");
    const panel = expectDefined(content.querySelector(".workboard-decision"), "panel");
    expect(panel.querySelector("[role='radiogroup']")).toBeNull();
    expect(panel.querySelector("[role='status']")?.textContent).toBe("");
    expect(panel.querySelector(".workboard-decision__options")).toBeNull();
    expect(panel.querySelector(".workboard-decision__custom-label")).toBeNull();
    expect(panel.textContent).not.toContain("press its number");
    expect(panel.querySelector(".workboard-decision__input")).not.toBeNull();
    expect(key(panel, "1").defaultPrevented).toBe(false);
  });

  it("disables every option while the decision is saved", async () => {
    let release = () => {};
    const view = decisionView(
      "Pick a store",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      storeOptions,
    );
    expectDefined(radios(view.content)[0], "option 1").click();
    await waitForFast(() =>
      expect(radios(view.content).every((option) => option.disabled)).toBe(true),
    );
    expect(radios(view.content)[0]?.getAttribute("aria-checked")).toBe("true");
    expect(view.content.querySelector(".workboard-decision [role='status']")?.textContent).toBe(
      "Saving your decision...",
    );
    expectDefined(radios(view.content)[2], "option 3").click();
    key(expectDefined(view.content.querySelector("h3"), "heading"), "3");
    release();
    await expectDecided(view, "SQLite");
  });

  it("keeps the chosen option and the typed text when a dispatch refuses the move", async () => {
    let dispatchStarted = false;
    const view = decisionView(
      "Pick a store",
      () => {
        view.state.dispatching = !dispatchStarted;
        dispatchStarted = true;
      },
      storeOptions,
    );
    const input = typeDecision(view.content, "Draft answer");
    expectDefined(radios(view.content)[1], "option 2").click();
    await waitForFast(() =>
      expect(view.state.error).toBe(
        "Your decision comment was saved, but the card could not move to Ready. Deciding again records a second comment.",
      ),
    );
    expect(view.state.cards[0]).toMatchObject({ status: "blocked", labels: ["decision"] });
    expect(input.value).toBe("Draft answer");
    expect(radios(view.content).map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);

    view.state.dispatching = false;
    view.renderView();
    expectDefined(radios(view.content)[1], "option 2").click();
    await waitForFast(() => expect(view.state.cards[0]?.status).toBe("ready"));
    expect(view.client.request).toHaveBeenLastCalledWith("workboard.cards.move", {
      id: view.card.id,
      status: "ready",
      position: expect.any(Number),
      labelsRemove: ["decision"],
      expectedUpdatedAt: expect.any(Number),
    });
    expect(view.container.querySelector(".workboard-decision")).toBeNull();
  });

  it("hides the decision panel on a read-only board", () => {
    const { container, state, renderView } = createWorkboardView({ canWrite: false });
    state.cards = [
      createWorkboardCard({
        status: "blocked",
        labels: ["decision"],
        metadata: { automation: { decisionOptions: storeOptions } },
      }),
    ];
    state.detailCardId = "card-1";
    renderView();
    expect(container.querySelector(".workboard-waiting")?.textContent).toBe(
      "Waiting on you: this card needs your decision.",
    );
    expect(container.querySelector(".workboard-decision")).toBeNull();
  });
});
