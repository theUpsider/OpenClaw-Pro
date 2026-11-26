import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createGatewaySession,
  createWorkboardCard,
} from "../../lib/workboard/test/index-helpers.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { openCardDetails } from "./view-card-details.tsx";
import { mountPage, openSessionButton, visibleToast } from "./workboard-page.test-support.ts";

const dockKey = "agent:main:dock-d";
const dockCard = () =>
  createWorkboardCard({
    id: "dictated",
    title: "Dictated card",
    metadata: {
      interaction: { sessionKey: dockKey, agentId: "main", startedAt: 1, updatedAt: 2 },
    },
  });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** The board roster excludes dock conversations; only the interaction window carries them. */
function windows(page: ReturnType<typeof mountPage>) {
  return {
    board: (sessions: ReturnType<typeof createGatewaySession>[]) =>
      page.sessionSnapshot((query) => ({
        result: {
          sessions: query.excludeDock === false ? sessions : [],
          hasMore: false,
          totalCount: query.excludeDock === false ? sessions.length : 0,
        },
        loading: false,
        error: null,
      })),
  };
}

it("opens the editing conversation from a card without an execution session", async () => {
  const page = mountPage({ connected: true });
  page.cards([dockCard()]);
  windows(page).board([
    createGatewaySession({ key: dockKey, displayName: "Board agent", status: "done" }),
  ]);
  await afterWorkboardUpdate(() => expect(page.container.textContent).toContain("Dictated card"));

  // One dock-inclusive read per board view, and it is not the execution resolver's query.
  const dockCalls = vi
    .mocked(page.fixture.host.sessions.observe)
    .mock.calls.filter(([query]) => query.excludeDock === false && query.search === undefined);
  expect(dockCalls).toHaveLength(1);
  expect(dockCalls[0]?.[0]).toEqual(
    expect.objectContaining({ excludeDock: false, limit: 25, archived: "all" }),
  );

  expect(page.container.querySelector(".workboard-card__session-name")?.textContent).toBe(
    "Board agent",
  );
  const card = expectDefined(
    page.container.querySelector<HTMLElement>(".workboard-card--openable"),
    "board card",
  );
  card.click();
  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-detail__session-name")?.textContent).toBe(
      "Board agent",
    ),
  );
  const open = expectDefined(openSessionButton(page.container), "Open session");
  open.click();
  expect(page.fixture.host.sessions.open).toHaveBeenCalledWith({
    sessionKey: dockKey,
    agentId: "main",
  });
  // The Stop control never appears: the abort target stays undefined for this card.
  expect(page.container.querySelector('button[aria-label="Stop session"]')).toBeNull();
});

it("does not raise a page error when the dock conversation lookup fails", async () => {
  const page = mountPage({ connected: true });
  page.cards([dockCard()]);
  const boardRoster = { result: { sessions: [], hasMore: false }, loading: false, error: null };
  page.sessionSnapshot((query) =>
    query.excludeDock === false
      ? {
          result: null,
          loading: false,
          error: "Dock sessions temporarily unavailable",
        }
      : boardRoster,
  );
  await afterWorkboardUpdate(() => expect(page.container.textContent).toContain("Dictated card"));

  // A failed fallback read is informational: no page error and no fallback UI.
  expect(visibleToast(page.container)?.textContent ?? "").toBe("");
  expect(page.container.textContent).not.toContain("Dock sessions temporarily unavailable");
  expect(openSessionButton(page.container)).toBeUndefined();
  expect(page.container.querySelector(".session-run-spinner")).toBeNull();
});

it("does not raise a page error when the recorded dock session was deleted", async () => {
  const page = mountPage({ connected: true });
  page.cards([dockCard()]);
  page.sessionSnapshot((query) => ({
    result:
      query.excludeDock === false
        ? { sessions: [], hasMore: false, totalCount: 0 }
        : { sessions: [], hasMore: false },
    loading: false,
    error: null,
  }));
  await afterWorkboardUpdate(() => expect(page.container.textContent).toContain("Dictated card"));

  // A reference that resolved to nothing leaves no toast, no link, no marker, no line.
  expect(visibleToast(page.container)?.textContent ?? "").toBe("");
  expect(openSessionButton(page.container)).toBeUndefined();
  const card = expectDefined(
    page.container.querySelector<HTMLElement>(".workboard-card--openable"),
    "board card",
  );
  card.click();
  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-detail__session-name")?.textContent).toBe(
      "No session yet",
    ),
  );
  expect(page.container.querySelector(".workboard-detail .workboard-session-badge")).toBeNull();
  expect(page.container.querySelector(".session-run-spinner")).toBeNull();
});

it("shows the running spinner on the card while the editing conversation runs", async () => {
  const page = mountPage({ connected: true });
  page.cards([dockCard()]);
  windows(page).board([
    createGatewaySession({
      key: dockKey,
      displayName: "Board agent",
      status: "running",
      hasActiveRun: true,
    }),
  ]);
  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-card .session-run-spinner")).not.toBeNull(),
  );
  expect(
    page.container.querySelector(".workboard-card .workboard-card__session-name")?.textContent,
  ).toBe("Board agent");
  // The fallback never borrows the execution warning tone or badge.
  expect(page.container.querySelector(".workboard-card__session--warning")).toBeNull();
  expect(page.container.querySelector(".workboard-card .workboard-session-badge")).toBeNull();
});

it("keeps the execution session as the only source for a card that has one", async () => {
  const page = mountPage({ connected: true });
  const executionKey = "agent:writer:execution";
  const card = createWorkboardCard({
    id: "executing",
    title: "Executing card",
    sessionKey: executionKey,
    metadata: {
      interaction: { sessionKey: dockKey, agentId: "main", startedAt: 1, updatedAt: 2 },
    },
  });
  page.cards([card]);
  // Focus the card so the execution resolver's own query runs too.
  page.workboard.state.detailCardId = card.id;
  page.sessionSnapshot((query) => ({
    result:
      query.excludeDock === false
        ? {
            sessions: [
              createGatewaySession({
                key: dockKey,
                displayName: "Board agent",
                status: "running",
                hasActiveRun: true,
              }),
            ],
            hasMore: false,
          }
        : query.search === executionKey
          ? {
              sessions: [
                createGatewaySession({
                  key: executionKey,
                  displayName: "Execution session",
                  status: "done",
                  hasActiveRun: false,
                }),
              ],
              hasMore: false,
            }
          : { sessions: [], hasMore: false },
    loading: false,
    error: null,
  }));
  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-card__session-name")?.textContent).toBe(
      "Execution session",
    ),
  );
  expect(page.container.textContent).not.toContain("Board agent");
});

it("shows the interaction name on the session tab of a card without an execution session", async () => {
  const page = mountPage({ connected: true });
  page.cards([dockCard()]);
  windows(page).board([
    createGatewaySession({ key: dockKey, displayName: "Board agent", status: "done" }),
  ]);
  await afterWorkboardUpdate(() => expect(page.container.textContent).toContain("Dictated card"));

  openCardDetails(page.workboard.state, page.workboard.state.cards[0]!);
  page.fixture.notify();
  await afterWorkboardUpdate(() => {
    const tabs = [...page.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map(
      (tab) => tab.textContent?.trim(),
    );
    expect(tabs).toContain("Session");
  });
  expectDefined(
    [...page.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === "Session",
    ),
    "session tab",
  ).click();
  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-detail__session-name")?.textContent).toBe(
      "Board agent",
    ),
  );
});
