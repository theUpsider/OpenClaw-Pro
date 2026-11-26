import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
<<<<<<< /tmp/s2v2/d3/o
import type { ControlUiSessionListResult } from "openclaw/plugin-sdk/control-ui";
import { expect, onTestFinished, vi } from "vitest";
||||||| /tmp/s2v2/d3/b
import type {
  ControlUiComponents,
  ControlUiSessionListResult,
} from "openclaw/plugin-sdk/control-ui";
import { afterEach, expect, vi } from "vitest";
=======
import type {
  ControlUiComponents,
  ControlUiSessionListQuery,
  ControlUiSessionListResult,
  ControlUiSessionListSnapshot,
  ControlUiSessionListSubscription,
} from "openclaw/plugin-sdk/control-ui";
import { afterEach, expect, vi } from "vitest";
>>>>>>> /tmp/s2v2/d3/t
import type { AgentsListResult } from "../../api/types.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import type { WorkboardBoardSummary } from "../../lib/workboard/index.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { afterWorkboardUpdate as settle } from "../../test/settle.ts";
import { requireButton } from "./view.test-support.ts";
import { createWorkboardPage } from "./workboard-page.tsx";
export { sessionPicker } from "./view.test-support.ts";

export function mountPage(
  params: { boardId?: string; connected?: boolean; presented?: boolean } = {},
) {
  const fixture = workboardTestHost();
  const { host } = fixture;
  const hostListeners = fixture.listeners.size;
  const workboard = createWorkboardCapability();
  fixture.connection.connected = params.connected ?? false;
  Object.assign(host.agents, { rows: [], defaultId: null });
  let agents: AgentsListResult["agents"] = [{ id: "main" }, { id: "writer" }];
  let cards = [createWorkboardCard({ title: "Initial card" })];
  let boards: WorkboardBoardSummary[] | undefined;
  const request = vi.fn(async (method: string, requestParams?: unknown): Promise<unknown> => {
    if (method === "agents.list") {
      return { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [...agents] };
    }
    if (method === "workboard.cards.list") {
      return { cards, ...(boards ? { boards } : {}) };
    }
    if (method === "workboard.boards.list" && boards) {
      return { boards };
    }
    if (method === "workboard.boards.upsert") {
      return {
        board: { ...(requestParams as Record<string, unknown>), createdAt: 1, updatedAt: 1 },
      };
    }
    return {};
  });
  host.request = request as typeof host.request;
  host.agents.refresh = vi.fn(async () => {
    const result = await host.request<AgentsListResult>("agents.list", {});
    Object.assign(host.agents, { rows: result.agents, defaultId: result.defaultId });
    fixture.notify();
  });
  // The board opens its session windows at mount, before a test can install a result.
  // This wrapper keeps every window reachable so a test can publish a roster afterwards;
  // `sessionRows` is the one place a page test feeds them.
  let sessionSnapshot = (_query: ControlUiSessionListQuery): ControlUiSessionListSnapshot => ({
    result: { sessions: [], hasMore: false, totalCount: 0 },
    loading: false,
    error: null,
  });
  const windows = new Map<
    (snapshot: ControlUiSessionListSnapshot) => void,
    ControlUiSessionListQuery
  >();
  const publishWindows = () => {
    for (const [listener, query] of windows) {
      listener(sessionSnapshot(query));
    }
  };
  const observation = (
    query: ControlUiSessionListQuery,
    listener: (snapshot: ControlUiSessionListSnapshot) => void,
  ): ControlUiSessionListSubscription => {
    windows.set(listener, query);
    listener(sessionSnapshot(query));
    return {
      refresh: vi.fn(async () => {
        listener(sessionSnapshot(query));
      }),
      dispose: vi.fn(() => windows.delete(listener)),
    };
  };
  fixture.host.sessions.observe = vi.fn(observation);
  const container = document.createElement("div");
  document.body.append(container);
  let context = createViewContext<Readonly<Record<string, string>>>(
    host,
    params.boardId ? { boardId: params.boardId } : {},
    params.presented ?? true,
  );
  const registerBoardNavigation = vi.fn();
  const mounted = createWorkboardPage(workboard, registerBoardNavigation)(container, context);
  onTestFinished(() => {
    mounted?.dispose?.();
    workboard.dispose();
  });
  return {
    fixture,
    hostListeners,
    workboard,
    container,
    request,
    registerBoardNavigation,
<<<<<<< /tmp/s2v2/d3/o
    focus: () => mounted?.focus?.(),
    cards: (next: typeof cards) => void (cards = next),
    agents: (next: typeof agents) => void (agents = next),
||||||| /tmp/s2v2/d3/b
    cards(next: typeof cards) {
      cards = next;
    },
    agents(next: typeof agents) {
      agents = next;
    },
=======
    cards(next: typeof cards) {
      cards = next;
    },
    boards(next: WorkboardBoardSummary[]) {
      boards = next;
    },
    agents(next: typeof agents) {
      agents = next;
    },
    /** Snapshot every open session window returns; delivered immediately. */
    sessionSnapshot(next: (query: ControlUiSessionListQuery) => ControlUiSessionListSnapshot) {
      sessionSnapshot = next;
      publishWindows();
    },
>>>>>>> /tmp/s2v2/d3/t
    navigate(boardId: string) {
      context = { ...context, props: { boardId } };
      mounted?.update?.(context);
    },
    present(presented: boolean) {
      context = { ...context, presented };
      mounted?.update?.(context);
    },
    dispose: () => mounted?.dispose?.(),
  };
}

type Page = ReturnType<typeof mountPage>;

export async function openBoardEditor(page: Page) {
  await settle(() => expect(page.workboard.state.loaded).toBe(true));
  requireButton(page.container, "Edit board").click();
  return settle(() =>
    expectDefined(
      page.container.querySelector<HTMLFormElement>(".workboard-board-draft"),
      "board editor",
    ),
  );
}

export async function openSessionTab(page: Page) {
  const tab = await settle(() =>
    requireButton(
      expectDefined(page.container.querySelector(".workboard-detail__tabs"), "detail tabs"),
      "Session",
    ),
  );
  tab.click();
}

export function observeSessions(page: Page, result: ControlUiSessionListResult) {
  return vi.mocked(page.fixture.host.sessions.observe).mockImplementation((_query, listener) => {
    listener({ result, loading: false, error: null });
    return { refresh: vi.fn(async () => undefined), dispose: vi.fn() };
  });
}

<<<<<<< /tmp/s2v2/d3/o
export const openSessionButton = (container: Element) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
||||||| /tmp/s2v2/d3/b
export function openSessionButton(container: Element) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
=======
/**
 * The board reads two independent session queries: the execution resolver (one open card,
 * `search` set) and the dock-inclusive window behind the interaction fallback (board-wide,
 * no `search`). Tests that own the resolver's behaviour count the first only.
 */
export function cardSessionCalls(page: ReturnType<typeof mountPage>) {
  return vi
    .mocked(page.fixture.host.sessions.observe)
    .mock.calls.filter(([query]) => typeof query.search === "string");
}

export function openSessionButton(container: Element) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
>>>>>>> /tmp/s2v2/d3/t
    (button) =>
      (button.getAttribute("aria-label") ?? button.textContent?.trim()) === "Open session",
  );

export const visibleToast = (container: Element) =>
  container.querySelector<HTMLElement>("openclaw-workboard-toast:not([hidden])");
