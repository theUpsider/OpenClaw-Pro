import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { ControlUiDictationControlProps } from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { voiceGateButton } from "../../test/voice-gate.ts";
import { openCardDetails } from "./view-card-details.tsx";
import { mountPage } from "./workboard-page.test-support.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const boards = [
  { id: "planning", name: "Planning", total: 0, active: 0, archived: 0, byStatus: {} },
  { id: "release", name: "Release", total: 0, active: 0, archived: 0, byStatus: {} },
];

const cardOn = (id: string, title: string, boardId: string) =>
  createWorkboardCard({ id, title, metadata: { automation: { boardId } } });

function voicePage(boardId?: string, cards: ReturnType<typeof createWorkboardCard>[] = []) {
  const page = mountPage({ boardId });
  const deleted = new Set<string>();
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") {
      return { cards, boards };
    }
    if (method === "sessions.describe") {
      const key = (params as { key: string }).key;
      return { session: deleted.has(key) ? null : { key, agentId: "main", isDock: true } };
    }
    return request(method, params);
  });
  const openSession = vi.fn();
  Object.assign(page.fixture.host, { dock: { openSession, close: vi.fn(), openSessionKey: null } });
  vi.mocked(page.fixture.host.sessions.create).mockResolvedValue("agent:main:voice");
  page.fixture.connection.connected = true;
  page.fixture.notify();
  return {
    ...page,
    openSession,
    async microphone() {
      return afterWorkboardUpdate(() => {
        const element = page.container.querySelector<
          HTMLButtonElement & { props: ControlUiDictationControlProps }
        >(".workboard-page-title [data-test-dictation]");
        expect(element?.props.accessibleLabel).toBe("Talk to the board");
        return element!;
      });
    },
    async openCard(id: string) {
      const card = expectDefined(
        page.workboard.state.cards.find((entry) => entry.id === id),
        `card ${id}`,
      );
      openCardDetails(page.workboard.state, card);
      page.fixture.notify();
      await afterWorkboardUpdate(() =>
        expect(document.querySelector("[data-test-dialog]")?.getAttribute("aria-label")).toBe(
          card.title,
        ),
      );
    },
    async cardMicrophone() {
      return afterWorkboardUpdate(() => {
        const element = document.querySelector<
          HTMLButtonElement & { props: ControlUiDictationControlProps }
        >(".workboard-detail__properties [data-test-dictation]");
        expect(element?.props.accessibleLabel).toBe("Talk about this card");
        return element!;
      });
    },
    /** Confirm the transcript gate the last utterance opened, optionally after editing it. */
    async confirm(edited?: string) {
      const gate = await afterWorkboardUpdate(() =>
        expectDefined(document.querySelector<HTMLFormElement>(".workboard-voice-gate"), "gate"),
      );
      if (edited !== undefined) {
        const field = expectDefined(gate.querySelector("textarea"), "transcript field");
        field.value = edited;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await afterWorkboardUpdate(() => undefined);
      }
      voiceGateButton("Send").click();
      await afterWorkboardUpdate(() => undefined);
    },
    sends() {
      return page.request.mock.calls.filter(([method]) => method === "chat.send");
    },
    deleteSession(key: string) {
      deleted.add(key);
    },
  };
}

it("sends the board visible when dictation started, not the board shown when it ends", async () => {
  const page = voicePage("planning");
  await afterWorkboardUpdate(() => expect(page.workboard.state.loaded).toBe(true));
  const microphone = await page.microphone();

  microphone.props.onStart?.();
  page.navigate("release");
  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-page-title")?.textContent).toContain("Release"),
  );
  microphone.props.onTranscript("move the login card to review");
  await page.confirm();

  await vi.waitFor(() => expect(page.openSession).toHaveBeenCalledOnce());
  const context = { page: "workboard", detail: { boardId: "planning", boardKind: "cards" } };
  expect(page.fixture.host.sessions.create).toHaveBeenCalledExactlyOnceWith({
    agentId: "main",
    displayName: "Workboard · Planning",
    surface: "plugin-dock",
  });
  const params = expectDefined(page.sends()[0], "voice send")[1];
  expect(params).toEqual({
    sessionKey: "agent:main:voice",
    message: "move the login card to review",
    idempotencyKey: expect.any(String),
    workContext: context,
  });
  expect(page.openSession).toHaveBeenCalledWith({
    sessionKey: "agent:main:voice",
    agentId: "main",
    label: "Workboard · Planning",
    context,
  });

  // A second utterance about the same board reuses its conversation.
  page.navigate("planning");
  await afterWorkboardUpdate(() => undefined);
  microphone.props.onStart?.();
  microphone.props.onTranscript("comment that QA passed");
  await page.confirm();
  await vi.waitFor(() => expect(page.sends()).toHaveLength(2));
  expect(page.fixture.host.sessions.create).toHaveBeenCalledOnce();
});

it("captures no board binding from the all-boards view", async () => {
  const page = voicePage();
  const microphone = await page.microphone();

  microphone.props.onStart?.();
  microphone.props.onTranscript("what is blocked?");
  await page.confirm();

  await vi.waitFor(() => expect(page.sends()).toHaveLength(1));
  expect(page.sends()[0]?.[1]).toMatchObject({ workContext: { page: "workboard" } });
  expect(page.sends()[0]?.[1]).not.toHaveProperty("workContext.detail");
  expect(page.fixture.host.sessions.create).toHaveBeenCalledWith(
    expect.objectContaining({ displayName: "Workboard · All boards" }),
  );
});

it("records on a read-only connection but sends nothing and shows the composer's read-only reason", async () => {
  const page = voicePage("planning");
  page.fixture.connection.canWrite = false;
  page.fixture.notify();
  const microphone = await page.microphone();

  expect(microphone.disabled).toBe(false);
  microphone.props.onStart?.();
  microphone.props.onTranscript("move the login card to done");

  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-voice__error")?.textContent).toBe(
      "Sending messages is unavailable with your current access.",
    ),
  );
  expect(voiceGateButton("Send").disabled).toBe(true);
  expect(page.sends()).toHaveLength(0);
  expect(page.fixture.host.sessions.create).not.toHaveBeenCalled();
  expect(page.openSession).not.toHaveBeenCalled();
});

it("shows a failed send next to the microphone without opening the dock", async () => {
  const page = voicePage("planning");
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    if (method === "chat.send") {
      throw new Error("Session is busy");
    }
    return request(method, params);
  });
  const microphone = await page.microphone();

  microphone.props.onStart?.();
  microphone.props.onTranscript("dispatch the next card");
  await page.confirm();

  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-voice__error")?.textContent).toBe(
      "Session is busy",
    ),
  );
  expect(page.openSession).not.toHaveBeenCalled();
  // The failed send keeps the gate open; discarding it ends the turn.
  voiceGateButton("Discard").click();
  microphone.props.onStart?.();
  await afterWorkboardUpdate(() =>
    expect(page.container.querySelector(".workboard-voice__error")).toBeNull(),
  );
});

it("starts a fresh card-board conversation after a deleted one or an agent switch", async () => {
  const page = voicePage("planning");
  const microphone = await page.microphone();
  const create = vi.mocked(page.fixture.host.sessions.create);
  const speak = async (count: number) => {
    microphone.props.onStart?.();
    microphone.props.onTranscript("what is blocked?");
    await page.confirm();
    await vi.waitFor(() => expect(page.sends()).toHaveLength(count));
    return page.sends()[count - 1]?.[1];
  };

  expect(await speak(1)).toMatchObject({ sessionKey: "agent:main:voice" });
  page.deleteSession("agent:main:voice");
  create.mockResolvedValueOnce("agent:main:voice-2");
  expect(await speak(2)).toMatchObject({ sessionKey: "agent:main:voice-2" });

  Object.assign(page.fixture.host.agents, { selectedId: "writer" });
  create.mockResolvedValueOnce("agent:writer:voice");
  expect(await speak(3)).toMatchObject({ sessionKey: "agent:writer:voice" });
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "writer" }));
  expect(create).toHaveBeenCalledTimes(3);
});

// »Karten-Turn sendet und bestätigt« (docs/ui/screen-state-matrix.md)
it("binds the card-detail microphone to the card it was opened for, even after navigating", async () => {
  const page = voicePage(undefined, [
    cardOn("login", "Login bug", "planning"),
    cardOn("deploy", "Deploy", "release"),
  ]);
  await afterWorkboardUpdate(() => expect(page.workboard.state.cards).toHaveLength(2));
  // All-boards view: the binding uses the card's own board, not the filter.
  await page.openCard("login");
  const microphone = await page.cardMicrophone();

  microphone.props.onStart?.();
  await page.openCard("deploy");
  page.navigate("release");
  microphone.props.onTranscript("make it urgent and label it needs-qa");
  await page.confirm();

  await vi.waitFor(() => expect(page.openSession).toHaveBeenCalledOnce());
  const context = {
    page: "workboard",
    detail: { boardId: "planning", boardKind: "cards", cardId: "login" },
  };
  expect(expectDefined(page.sends()[0], "card voice send")[1]).toMatchObject({
    message: "make it urgent and label it needs-qa",
    workContext: context,
  });
  // Card turns get the card's own dock conversation on the card's agent; this
  // card has no explicit agent, so it runs as the default agent.
  expect(page.fixture.host.sessions.create).toHaveBeenCalledExactlyOnceWith({
    agentId: "main",
    displayName: "Workboard · Planning · “Login bug”",
    surface: "plugin-dock",
  });
  expect(page.openSession).toHaveBeenCalledWith(expect.objectContaining({ context }));
  await afterWorkboardUpdate(() =>
    expect(document.querySelector(".workboard-voice__sent")?.textContent).toBe(
      "Sent about “Login bug”. The answer follows in the dock.",
    ),
  );
});

it("routes card dictation to the card's agent in the card's own conversation", async () => {
  const page = voicePage("planning", [
    createWorkboardCard({
      id: "login",
      title: "Login bug",
      agentId: "writer",
      metadata: { automation: { boardId: "planning" } },
    }),
  ]);
  const create = vi.mocked(page.fixture.host.sessions.create);
  create.mockImplementation(async ({ agentId }) => `agent:${agentId}:voice`);
  await afterWorkboardUpdate(() => expect(page.workboard.state.cards).toHaveLength(1));
  // The operator last chatted with main, so main is the application-selected agent.
  expect(page.fixture.host.agents.selectedId).toBe("main");

  const boardMicrophone = await page.microphone();
  boardMicrophone.props.onStart?.();
  boardMicrophone.props.onTranscript("what is blocked?");
  await page.confirm();
  await vi.waitFor(() => expect(page.sends()).toHaveLength(1));
  expect(page.sends()[0]?.[1]).toMatchObject({ sessionKey: "agent:main:voice" });

  await page.openCard("login");
  const cardMicrophone = await page.cardMicrophone();
  cardMicrophone.props.onStart?.();
  cardMicrophone.props.onTranscript("make it urgent");
  await afterWorkboardUpdate(() =>
    expect(document.querySelector(".workboard-voice-gate__attribution")?.textContent).toBe(
      "Run by: writer · Planning · “Login bug”",
    ),
  );
  await page.confirm();
  await vi.waitFor(() => expect(page.sends()).toHaveLength(2));

  expect(create).toHaveBeenLastCalledWith({
    agentId: "writer",
    displayName: "Workboard · Planning · “Login bug”",
    surface: "plugin-dock",
  });
  const cardSend = expectDefined(page.sends()[1], "card voice send")[1];
  expect(cardSend).toMatchObject({ sessionKey: "agent:writer:voice", message: "make it urgent" });
  expect(page.openSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionKey: "agent:writer:voice", agentId: "writer" }),
  );

  // Board dictation still runs as the selected agent, in the board's conversation.
  boardMicrophone.props.onStart?.();
  boardMicrophone.props.onTranscript("comment that QA passed");
  await page.confirm();
  await vi.waitFor(() => expect(page.sends()).toHaveLength(3));
  // Only the board turns used main's voice conversation; the card turn never did.
  expect(page.sends().map(([, params]) => (params as { sessionKey: string }).sessionKey)).toEqual([
    "agent:main:voice",
    "agent:writer:voice",
    "agent:main:voice",
  ]);
  expect(create.mock.calls.map(([params]) => params.agentId)).toEqual(["main", "writer"]);
});

it("records from the card detail on a read-only connection but sends nothing", async () => {
  const page = voicePage("planning", [cardOn("login", "Login bug", "planning")]);
  page.fixture.connection.canWrite = false;
  page.fixture.notify();
  await afterWorkboardUpdate(() => expect(page.workboard.state.cards).toHaveLength(1));
  await page.openCard("login");
  const microphone = await page.cardMicrophone();

  expect(microphone.disabled).toBe(false);
  microphone.props.onStart?.();
  microphone.props.onTranscript("move it to done");

  await afterWorkboardUpdate(() =>
    expect(document.querySelector(".workboard-detail .workboard-voice__error")?.textContent).toBe(
      "Sending messages is unavailable with your current access.",
    ),
  );
  expect(voiceGateButton("Send").disabled).toBe(true);
  expect(page.sends()).toHaveLength(0);
  expect(document.querySelector(".workboard-voice__sent")).toBeNull();
});

// »Karten-Turn: Fehler« (docs/ui/screen-state-matrix.md)
it("keeps a failed card turn in its gate with the edited text, then sends it on retry", async () => {
  const page = voicePage("planning", [cardOn("login", "Login bug", "planning")]);
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  let busy = true;
  page.request.mockImplementation(async (method, params) => {
    if (method === "chat.send" && busy) {
      busy = false;
      throw new Error("Session is busy");
    }
    return request(method, params);
  });
  await afterWorkboardUpdate(() => expect(page.workboard.state.cards).toHaveLength(1));
  await page.openCard("login");
  const microphone = await page.cardMicrophone();

  microphone.props.onStart?.();
  microphone.props.onTranscript("label it needs qa");
  await page.confirm("label it needs-qa");

  await afterWorkboardUpdate(() =>
    expect(
      document.querySelector(".workboard-detail .workboard-voice-gate [role=alert]")?.textContent,
    ).toBe("Session is busy"),
  );
  expect(document.querySelector<HTMLTextAreaElement>(".workboard-voice-gate textarea")?.value).toBe(
    "label it needs-qa",
  );
  expect(page.openSession).not.toHaveBeenCalled();
  expect(document.querySelector(".workboard-voice__sent")).toBeNull();

  await page.confirm();
  await vi.waitFor(() => expect(page.openSession).toHaveBeenCalledOnce());
  expect(page.sends().map(([, params]) => (params as { message: string }).message)).toEqual([
    "label it needs-qa",
    "label it needs-qa",
  ]);
  await afterWorkboardUpdate(() =>
    expect(document.querySelector(".workboard-voice__sent")?.textContent).toBe(
      "Sent about “Login bug”. The answer follows in the dock.",
    ),
  );
  expect(document.querySelector(".workboard-voice-gate")).toBeNull();
});
