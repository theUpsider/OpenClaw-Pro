import "../../test/dom.setup.ts";
import { render } from "@solidjs/web";
import { createComponent, flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getWorkboardLifecycle } from "../../lib/workboard/lifecycle.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardExecution,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { getCardActionState } from "./view-card-actions.tsx";
import { CardSession } from "./view-card-content.tsx";
import { CardSessionHeading } from "./view-card-session-heading.tsx";
import type { WorkboardProps } from "./view-helpers.tsx";
import { getSessionStatus } from "./view-session-status.tsx";

const dockKey = "agent:main:dock-d";

function props(overrides: Partial<WorkboardProps> = {}): WorkboardProps {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  return {
    host,
    client: null,
    connected: true,
    canWrite: true,
    agentsList: null,
    sessions: [],
    onOpenSession: vi.fn(),
    ...overrides,
  };
}

function interactionCard(overrides: Partial<WorkboardCard> = {}) {
  return createWorkboardCard({
    ...overrides,
    metadata: {
      interaction: { sessionKey: dockKey, agentId: "main", startedAt: 1, updatedAt: 2 },
    },
  });
}

function renderSession(card: WorkboardCard, workboard: WorkboardProps) {
  const container = document.createElement("div");
  document.body.append(container);
  const lifecycle = getWorkboardLifecycle(card, workboard.sessions, workboard.sessionResolution);
  const dispose = render(
    () =>
      createComponent(CardSession, {
        workboard,
        card,
        lifecycle,
        status: getSessionStatus(card, lifecycle),
      }),
    container,
  );
  flush();
  onTestFinished(() => {
    dispose();
    container.remove();
  });
  return container;
}

describe("CardSession interaction fallback", () => {
  it("shows the spinner and the session name while the editing conversation runs", () => {
    const workboard = props({
      interactionSessions: [
        createGatewaySession({
          key: dockKey,
          displayName: "Board agent",
          status: "running",
          hasActiveRun: true,
        }),
      ],
    });
    const container = renderSession(interactionCard(), workboard);
    expect(container.querySelector(".workboard-card__session-name")?.textContent).toBe(
      "Board agent",
    );
    const marker = container.querySelector(".workboard-card__session-marker");
    expect(marker?.getAttribute("aria-label")).toBe("The session editing this card is running");
    expect(marker?.querySelector(".session-run-spinner")).not.toBeNull();
    // No warning tone and no status badge: the fallback never borrows the execution tone.
    expect(container.querySelector(".workboard-card__session--warning")).toBeNull();
    expect(container.querySelector(".workboard-session-badge")).toBeNull();
  });

  it("keeps the name and drops the spinner once the conversation is done", () => {
    const workboard = props({
      interactionSessions: [
        createGatewaySession({
          key: dockKey,
          displayName: "Board agent",
          status: "done",
          hasActiveRun: false,
        }),
      ],
    });
    const container = renderSession(interactionCard(), workboard);
    expect(container.querySelector(".workboard-card__session-name")?.textContent).toBe(
      "Board agent",
    );
    expect(container.querySelector(".session-run-spinner")).toBeNull();
    expect(container.querySelector(".workboard-session-badge")).toBeNull();
  });

  it("renders exactly like a card without a session when the conversation is gone", () => {
    const gone = renderSession(interactionCard(), props({ interactionSessions: [] }));
    const plain = renderSession(createWorkboardCard(), props({ interactionSessions: [] }));
    expect(gone.innerHTML).toBe(plain.innerHTML);
    expect(gone.querySelector(".session-run-spinner")).toBeNull();
    expect(gone.querySelector(".workboard-session-marker")).toBeNull();
    expect(gone.querySelector(".workboard-session-badge")).toBeNull();
    expect(gone.querySelector(".workboard-card__session--warning")).toBeNull();
  });

  it.each([
    ["done", { status: "done" as const, hasActiveRun: false }],
    ["running", { status: "running" as const, hasActiveRun: true }],
  ])(
    "lets the execution session win over the interaction (%s execution)",
    (_label, executionState) => {
      const executionSession = createGatewaySession({
        key: "agent:writer:work",
        displayName: "Execution session",
        ...executionState,
      });
      const card = interactionCard({
        sessionKey: executionSession.key,
        execution: createWorkboardExecution({ sessionKey: executionSession.key }),
      });
      const withInteraction = renderSession(
        card,
        props({
          sessions: [executionSession],
          interactionSessions: [
            createGatewaySession({
              key: dockKey,
              displayName: "Board agent",
              status: "running",
              hasActiveRun: true,
            }),
          ],
        }),
      );
      const withoutInteraction = renderSession(
        card,
        props({ sessions: [executionSession], interactionSessions: [] }),
      );
      expect(withInteraction.innerHTML).toBe(withoutInteraction.innerHTML);
      expect(withInteraction.textContent).not.toContain("Board agent");
    },
  );
});

describe("interaction target stays away from the Stop control", () => {
  it("leaves sessionTarget undefined and live false for an interaction-only card", () => {
    const card = interactionCard();
    const workboard = props({
      interactionSessions: [
        createGatewaySession({ key: dockKey, status: "running", hasActiveRun: true }),
      ],
    });
    const action = getCardActionState(workboard, card);
    // The Stop click aborts `sessionTarget`; a dock conversation must never land there.
    expect(action.sessionTarget).toBeUndefined();
    expect(action.live).toBe(false);
    expect(action.interactionTarget).toEqual({ sessionKey: dockKey, agentId: "main" });
  });

  it("ignores the interaction for the abort target even when a session resolves", () => {
    const card = interactionCard();
    const action = getCardActionState(
      props({
        sessions: [],
        sessionResolution: {
          key: dockKey,
          status: "resolved",
          session: createGatewaySession({ key: dockKey }),
        },
        interactionSessions: [createGatewaySession({ key: dockKey })],
      }),
      card,
    );
    expect(action.sessionTarget).toBeUndefined();
  });
});

describe("CardSessionHeading interaction fallback", () => {
  function renderHeading(card: WorkboardCard, workboard: WorkboardProps) {
    const container = document.createElement("div");
    document.body.append(container);
    const lifecycle = getWorkboardLifecycle(card, workboard.sessions, workboard.sessionResolution);
    const dispose = render(
      () =>
        createComponent(CardSessionHeading, {
          workboard,
          card,
          lifecycle,
          action: getCardActionState(workboard, card),
          tab: "overview",
        }),
      container,
    );
    flush();
    onTestFinished(() => {
      dispose();
      container.remove();
    });
    return container;
  }

  it("offers Open session for a resolvable interaction and shows the name", () => {
    const workboard = props({
      interactionSessions: [
        createGatewaySession({
          key: dockKey,
          displayName: "Board agent",
          status: "done",
          hasActiveRun: false,
        }),
      ],
    });
    const card = interactionCard();
    const container = renderHeading(card, workboard);
    expect(container.querySelector(".workboard-detail__session-name")?.textContent).toBe(
      "Board agent",
    );
    const open = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Open session",
    );
    open?.click();
    expect(workboard.onOpenSession).toHaveBeenCalledWith({ sessionKey: dockKey, agentId: "main" });
    // The Stop control is not offered: no execution session and `live` stays false.
    expect(container.querySelector('button[aria-label="Stop session"]')).toBeNull();
  });

  it("shows no interaction line and no Open session when the conversation is gone", () => {
    const workboard = props({ interactionSessions: [] });
    const card = interactionCard();
    const container = renderHeading(card, workboard);
    expect(container.querySelector(".workboard-detail__session-name")?.textContent).toBe(
      "No session yet",
    );
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent?.trim() === "Open session",
      ),
    ).toBe(false);
  });
});
