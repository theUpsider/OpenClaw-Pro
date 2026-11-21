import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ControlUiComponents,
  ControlUiSessionListQuery,
  ControlUiSessionListResult,
  ControlUiSessionListSnapshot,
  ControlUiSessionListSubscription,
} from "openclaw/plugin-sdk/control-ui";
import { afterEach, expect, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import type { WorkboardBoardSummary } from "../../lib/workboard/index.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { createWorkboardPage } from "./workboard-page.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  document.body.replaceChildren();
});

export function mountPage(
  params: { boardId?: string; connected?: boolean; presented?: boolean } = {},
) {
  const fixture = workboardTestHost();
  const hostListeners = fixture.listeners.size;
  const workboard = createWorkboardCapability();
  fixture.connection.connected = params.connected ?? false;
  Object.assign(fixture.host.agents, { rows: [], defaultId: null });
  let agents: AgentsListResult["agents"] = [{ id: "main" }, { id: "writer" }];
  let cards = [createWorkboardCard({ title: "Initial card" })];
  let boards: WorkboardBoardSummary[] | undefined;
  const request = vi.fn(async (method: string, requestParams?: unknown): Promise<unknown> => {
    if (method === "agents.list") {
      return {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [...agents],
      };
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
  fixture.host.request = request as typeof fixture.host.request;
  fixture.host.agents.refresh = vi.fn(async () => {
    const result = await fixture.host.request<AgentsListResult>("agents.list", {});
    Object.assign(fixture.host.agents, { rows: result.agents, defaultId: result.defaultId });
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
    fixture.host,
    params.boardId ? { boardId: params.boardId } : {},
    params.presented ?? true,
  );
  const registerBoardNavigation = vi.fn();
  const mounted = createWorkboardPage(workboard, registerBoardNavigation)(container, context);
  cleanup.push(() => {
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
    navigate(boardId: string) {
      context = { ...context, props: { boardId } };
      mounted?.update?.(context);
    },
    present(presented: boolean) {
      context = { ...context, presented };
      mounted?.update?.(context);
    },
    dispose() {
      mounted?.dispose?.();
    },
  };
}

export async function openBoardEditor(page: ReturnType<typeof mountPage>) {
  await afterWorkboardUpdate(() => expect(page.workboard.state.loaded).toBe(true));
  expectDefined(
    page.container.querySelector<HTMLButtonElement>('button[aria-label="Edit board"]'),
    "edit board",
  ).click();
  return afterWorkboardUpdate(() =>
    expectDefined(
      page.container.querySelector<HTMLFormElement>(".workboard-board-draft"),
      "board editor",
    ),
  );
}

export async function openSessionTab(page: ReturnType<typeof mountPage>) {
  await afterWorkboardUpdate(() =>
    expect(
      [...page.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].some(
        (tab) => tab.textContent?.trim() === "Session",
      ),
    ).toBe(true),
  );
  expectDefined(
    [...page.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === "Session",
    ),
    "session tab",
  ).click();
}

export function observeSessions(
  page: ReturnType<typeof mountPage>,
  result: ControlUiSessionListResult,
) {
  return vi.mocked(page.fixture.host.sessions.observe).mockImplementation((_query, listener) => {
    listener({ result, loading: false, error: null });
    return { refresh: vi.fn(async () => undefined), dispose: vi.fn() };
  });
}

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
    (button) =>
      (button.getAttribute("aria-label") ?? button.textContent?.trim()) === "Open session",
  );
}

export function visibleToast(container: Element) {
  return container.querySelector<HTMLElement>("openclaw-workboard-toast:not([hidden])");
}

export function sessionPicker(container: Element) {
  type SelectProps = Parameters<ControlUiComponents["mountSelectPicker"]>[1];
  return [
    ...container.querySelectorAll<HTMLElement & SelectProps>(
      ".workboard-draft [data-test-select-picker]",
    ),
  ].find((picker) => picker.accessibleLabel === "Session");
}
