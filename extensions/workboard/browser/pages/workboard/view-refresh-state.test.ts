import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { createWorkboardView } from "./view.test-support.ts";
import { mountPage } from "./workboard-page.test-support.ts";

/**
 * the operator, 2026-11-13: "die karten refreshen immer wieder. dadurch collapsed die zeile bspw
 * und man sieht den refresh visuell."
 *
 * A live refresh replaces the card objects. Whatever the operator expanded by hand must stay
 * expanded across it. Both disclosures from the operator's screenshot are covered: the notes "What"
 * disclosure (`Was:` longer than WORKBOARD_NOTES_COLLAPSE_LINES) and the execution options.
 */
const longWhat = [
  "Braucht von the operator: Rueckruf",
  "Was: Zeile eins",
  "Zeile zwei",
  "Zeile drei",
  "Zeile vier",
  "Stand: offen",
  "Naechster Schritt: anrufen",
  "Beleg: keiner",
].join("\n");

function cardFixture(overrides: Parameters<typeof createWorkboardCard>[0] = {}) {
  return createWorkboardCard({
    id: "card-1",
    title: "Anrufen und Termin vereinbaren",
    status: "triage",
    labels: ["decision"],
    notes: longWhat,
    ...overrides,
  });
}

function disclosures(root: ParentNode) {
  return {
    what: expectDefined(
      root.querySelector<HTMLDetailsElement>(".workboard-notes__disclosure"),
      "notes What disclosure",
    ),
    options: expectDefined(
      root.querySelector<HTMLDetailsElement>(".workboard-detail__engine-options"),
      "execution options disclosure",
    ),
  };
}

describe("workboard refresh keeps the operator's own expansions (view harness)", () => {
  it("keeps both drawer disclosures, as the same DOM nodes, when the card object is replaced", () => {
    const { container, state, renderView } = createWorkboardView({
      client: createWorkboardTestClient({}),
    });
    state.cards = [cardFixture()];
    state.detailCardId = "card-1";
    renderView();
    const before = disclosures(container);
    before.what.open = true;
    before.options.open = true;

    state.cards = [cardFixture({ updatedAt: Date.now() + 60_000 })];
    renderView();
    const after = disclosures(container);
    expect(after.what).toBe(before.what);
    expect(after.options).toBe(before.options);
    expect(after.what.open).toBe(true);
    expect(after.options.open).toBe(true);
  });
});

describe("workboard refresh keeps the operator's own expansions (live page path)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps both drawer disclosures open through a plugin.workboard.changed refresh", async () => {
    const page = mountPage({ connected: true });
    page.cards([cardFixture()]);
    page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
    await afterWorkboardUpdate(() =>
      expect(page.container.textContent).toContain("Anrufen und Termin vereinbaren"),
    );
    page.workboard.state.detailCardId = "card-1";
    page.fixture.notify();
    const before = await afterWorkboardUpdate(() => disclosures(page.container));
    before.what.open = true;
    before.options.open = true;

    // Hold the refresh response open, the way the 7 s gateway latency does.
    const response = createDeferred<unknown>();
    const fallback = page.request.getMockImplementation()!;
    page.request.mockImplementation(async (method: string, params?: unknown) =>
      method === "workboard.cards.list" ? response.promise : fallback(method, params),
    );
    page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 2 });
    await afterWorkboardUpdate(() => expect(page.workboard.state.loading).toBe(true));
    expect(disclosures(page.container).what.open).toBe(true);

    response.resolve({ cards: [cardFixture({ updatedAt: Date.now() + 60_000 })] });
    const after = await afterWorkboardUpdate(() => disclosures(page.container));
    expect(page.workboard.state.loading).toBe(false);
    expect(after.what).toBe(before.what);
    expect(after.options).toBe(before.options);
    expect(after.what.open).toBe(true);
    expect(after.options.open).toBe(true);
  });
});
