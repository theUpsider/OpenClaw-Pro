import "../test/dom.setup.ts";
import { render } from "@solidjs/web";
import type {
  ControlUiComposerSendActionProps,
  ControlUiComposerSessionControlsProps,
  ControlUiDictationControlProps,
} from "openclaw/plugin-sdk/control-ui";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveVoiceConversation } from "../lib/workboard/voice-board.ts";
import { workboardTestHost } from "../test/host.setup.ts";
import { afterWorkboardUpdate } from "../test/settle.ts";
import { VoiceBoardControl } from "./voice-board-control.tsx";

// Test names map to docs/ui/screen-state-matrix.md; the matrix cites the German titles.

const planning = { id: "planning", kind: "cards" as const, name: "Planning" };
let disposeRoot: (() => void) | undefined;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposeRoot?.();
  disposeRoot = undefined;
  vi.useRealTimers();
});

function mountVoice(props: Partial<Parameters<typeof VoiceBoardControl>[0]> = {}) {
  const fixture = workboardTestHost();
  const { host } = fixture;
  const openSession = vi.fn();
  Object.assign(host, { dock: { openSession, close: vi.fn(), openSessionKey: null } });
  Object.assign(host.agents, { rows: [{ id: "main", name: "D" }] });
  vi.mocked(host.sessions.create).mockResolvedValue("agent:main:voice");
  const request = vi.mocked(host.request);
  request.mockImplementation(async (method, params) =>
    method === "sessions.describe"
      ? ({ session: { key: (params as { key: string }).key, isDock: true } } as never)
      : ({} as never),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const this_gate = () => container.querySelector<HTMLElement>("[data-test-dialog]");
  disposeRoot = render(
    () => createComponent(VoiceBoardControl, { host, board: planning, ...props }),
    container,
  );
  const microphone = () =>
    container.querySelector<HTMLButtonElement & { props: ControlUiDictationControlProps }>(
      "[data-test-dictation]",
    )!;
  return {
    host,
    openSession,
    request,
    container,
    sends: () => request.mock.calls.filter(([method]) => method === "chat.send"),
    gate: () => container.querySelector<HTMLElement>("[data-test-dialog]"),
    field: () => container.querySelector<HTMLTextAreaElement>(".workboard-voice-gate textarea")!,
    button: (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".workboard-voice-gate button")].find(
        (button) => button.textContent === label,
      )!,
    line: () => container.querySelector(".workboard-voice-gate__attribution")?.textContent,
    message: () => container.querySelector(".workboard-voice-gate [role=alert]")?.textContent,
    notice: () => container.querySelector(".workboard-voice__sent")?.textContent,
    async speak(text: string) {
      await afterWorkboardUpdate(() => undefined);
      microphone().props.onStart?.();
      microphone().props.onTranscript(text);
      return afterWorkboardUpdate(() => this.gate());
    },
    async type(text: string) {
      const field = this.field();
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await afterWorkboardUpdate(() => undefined);
    },
    async press(label: string) {
      this.button(label).click();
      await afterWorkboardUpdate(() => undefined);
    },
    microphone,
    gateMicrophone: () =>
      this_gate()?.querySelector<HTMLButtonElement & { props: ControlUiDictationControlProps }>(
        "[data-test-dictation]",
      ),
    sessionControls: () =>
      this_gate()?.querySelector<HTMLElement & { props: ControlUiComposerSessionControlsProps }>(
        "[data-test-session-controls]",
      )?.props,
    sendAction: () =>
      this_gate()?.querySelector<
        HTMLButtonElement & {
          props: ControlUiComposerSendActionProps;
          followUpMode: Parameters<ControlUiComposerSendActionProps["onSend"]>[0];
        }
      >("[data-test-send-action]"),
  };
}

// »leerer Transkript ruft kein Gate«
it("opens no gate when dictation ends without a transcript", async () => {
  const voice = mountVoice();
  await afterWorkboardUpdate(() => undefined);

  // A transcript without a captured start has no binding to confirm.
  voice.microphone().props.onTranscript("stray");
  await afterWorkboardUpdate(() => undefined);
  expect(voice.gate()).toBeNull();

  // The host never calls onTranscript for empty dictation.
  voice.microphone().props.onStart?.();
  await afterWorkboardUpdate(() => undefined);
  expect(voice.gate()).toBeNull();
  expect(voice.request).not.toHaveBeenCalled();
});

// »leerer Text sperrt Absenden«
it("disables Send with a visible reason while the text is empty", async () => {
  const voice = mountVoice();
  await voice.speak("move the login card to review");
  expect(voice.button("Send").disabled).toBe(false);
  expect(voice.message()).toBeUndefined();

  await voice.type("   \n ");
  expect(voice.button("Send").disabled).toBe(true);
  expect(voice.message()).toBe("Nothing to send. Type the text or discard it.");
  expect(voice.field().getAttribute("aria-describedby")).toBeTruthy();

  await voice.type("move it");
  expect(voice.button("Send").disabled).toBe(false);
});

// »zeigt die Zielzeile während der Agent lädt«
it("shows a provisional attribution line until the Board agent conversation exists", async () => {
  const boardAgent = vi.fn(async () => ({
    sessionKey: "agent:ops:board",
    agentId: "ops",
    label: "Ops board",
  }));
  const voice = mountVoice({ board: { id: "ops", kind: "sessions", name: "Ops" }, boardAgent });
  await voice.speak("pin the failing session");

  expect(voice.line()).toBe("Run by: Board agent, resolved on send · Ops");
  // Opening the gate must not create the conversation.
  expect(boardAgent).not.toHaveBeenCalled();

  await voice.press("Send");
  expect(boardAgent).toHaveBeenCalledExactlyOnceWith("ops");
  expect(voice.gate()).toBeNull();
  expect(voice.notice()).toBe("Sent to ops. The answer follows in the dock.");
});

it("names the dock agent, or says when none is available", async () => {
  const voice = mountVoice();
  await voice.speak("what is blocked?");
  expect(voice.line()).toBe("Run by: D · Planning");
  await voice.press("Discard");

  Object.assign(voice.host.agents, { scopeId: null, selectedId: null, defaultId: null });
  Object.assign(voice.host.connection, { assistantAgentId: null });
  await voice.speak("what is blocked?");
  expect(voice.line()).toBe("Run by: No agent available · Planning");
});

// »Zielzeile nennt die Karte«
it("names the card in the attribution line of a card turn", async () => {
  const voice = mountVoice({ card: { id: "login", title: "Login bug" } });
  await voice.speak("make it urgent");

  expect(voice.line()).toBe("Run by: D · Planning · “Login bug”");
});

it("names the card's agent, not the selected agent, in the attribution line of a card turn", async () => {
  const voice = mountVoice({ card: { id: "login", title: "Login bug" }, cardAgentId: "writer" });
  Object.assign(voice.host.agents, {
    rows: [
      { id: "main", name: "D" },
      { id: "writer", name: "Scribe" },
    ],
  });
  expect(voice.host.agents.selectedId).toBe("main");
  await voice.speak("make it urgent");

  expect(voice.line()).toBe("Run by: Scribe · Planning · “Login bug”");
});

// »Fehler lässt den Text stehen«
it("keeps the edited text and allows another send after a failed send", async () => {
  const voice = mountVoice();
  const request = voice.request.getMockImplementation()!;
  voice.request.mockImplementationOnce(async (method, params) =>
    method === "chat.send" ? Promise.reject(new Error("Session is busy")) : request(method, params),
  );
  await voice.speak("dispatch the next card");
  await voice.type("dispatch the next ready card");

  await voice.press("Send");
  expect(voice.gate()).not.toBeNull();
  expect(voice.field().value).toBe("dispatch the next ready card");
  expect(voice.message()).toBe("Session is busy");
  expect(voice.button("Send").disabled).toBe(false);
  expect(voice.openSession).not.toHaveBeenCalled();
});

// »schreibgeschützt«
it("records on a read-only connection but locks Send with the composer's reason", async () => {
  const voice = mountVoice();
  voice.host.connection.canWrite = false;
  await afterWorkboardUpdate(() => expect(voice.microphone().disabled).toBe(false));
  await voice.speak("move the login card to done");

  expect(voice.field().value).toBe("move the login card to done");
  expect(voice.button("Send").disabled).toBe(true);
  expect(voice.message()).toBe("Sending messages is unavailable with your current access.");
  expect(voice.button("Send").getAttribute("aria-describedby")).toBeTruthy();
  expect(voice.request).not.toHaveBeenCalled();
});

// »Verwerfen ändert nichts«
it("discards by button or Escape without sending or creating a conversation", async () => {
  const voice = mountVoice();
  await voice.speak("archive everything");
  await voice.press("Discard");
  expect(voice.gate()).toBeNull();
  expect(voice.notice()).toBe("Discarded.");

  await voice.speak("archive everything");
  voice.gate()!.dispatchEvent(new Event("cancel", { cancelable: true }));
  await afterWorkboardUpdate(() => undefined);
  expect(voice.gate()).toBeNull();

  // The captured binding went with the discarded gate.
  voice.microphone().props.onTranscript("archive everything");
  await afterWorkboardUpdate(() => undefined);
  expect(voice.gate()).toBeNull();
  expect(voice.request).not.toHaveBeenCalled();
  expect(voice.host.sessions.create).not.toHaveBeenCalled();
  expect(voice.openSession).not.toHaveBeenCalled();
});

// »Absenden sendet den editierten Text«
it("sends the edited text through the existing voice turn", async () => {
  const voice = mountVoice();
  await voice.speak("move the log in card to review");
  await voice.type("  move the login card to review ");

  await voice.press("Send");
  expect(voice.sends()).toHaveLength(1);
  expect(voice.sends()[0]?.[1]).toEqual({
    sessionKey: "agent:main:voice",
    message: "move the login card to review",
    idempotencyKey: expect.any(String),
    workContext: { page: "workboard", detail: { boardId: "planning", boardKind: "cards" } },
  });
  expect(voice.gate()).toBeNull();
  expect(voice.openSession).toHaveBeenCalledOnce();
  expect(voice.notice()).toBe("Sent to D. The answer follows in the dock.");
  expect(voice.microphone().disabled).toBe(false);
});

// »Neu aufnehmen ersetzt den Text«
it("re-records into the gate, replacing the draft but never clearing it", async () => {
  const voice = mountVoice();
  await voice.speak("move the log in card");
  await voice.type("move the login card");
  const microphone = voice.gateMicrophone()!;
  expect(microphone.getAttribute("aria-label")).toBe("Record again");
  expect(microphone.disabled).toBe(false);

  microphone.props.onStart?.();
  microphone.props.onTranscript("move the login card to review");
  await afterWorkboardUpdate(() => undefined);
  expect(voice.field().value).toBe("move the login card to review");

  // The host never delivers empty dictation; a blank result still keeps the draft.
  microphone.props.onTranscript("   ");
  await afterWorkboardUpdate(() => undefined);
  expect(voice.field().value).toBe("move the login card to review");

  microphone.props.onError("Microphone access was denied.");
  await afterWorkboardUpdate(() => undefined);
  expect(voice.message()).toBe("Microphone access was denied.");
  expect(voice.request).not.toHaveBeenCalled();
});

// »Modell und Denken gelten dem Zielgespräch«
it("binds the composer controls to the conversation the turn is sent to", async () => {
  const voice = mountVoice();
  await voice.speak("what is blocked?");
  // The first card-board turn creates the dock conversation; nothing is created to show controls.
  expect(voice.sessionControls()).toMatchObject({
    sessionKey: null,
    agentId: "main",
    disabledReason:
      "Model and thinking can be changed once the first turn creates this conversation.",
  });
  expect(voice.sendAction()!.props).toMatchObject({ sessionKey: null, agentId: "main" });
  expect(voice.host.sessions.create).not.toHaveBeenCalled();
  await voice.press("Send");

  await voice.speak("and now?");
  expect(voice.sessionControls()).toMatchObject({
    sessionKey: "agent:main:voice",
    agentId: "main",
    disabledReason: undefined,
  });
  expect(voice.sendAction()!.props).toMatchObject({ sessionKey: "agent:main:voice" });

  // A model or thinking change the Gateway rejects is explained in the gate.
  voice.sessionControls()!.onError?.("Failed to set model: not permitted");
  await afterWorkboardUpdate(() => undefined);
  expect(voice.message()).toBe("Failed to set model: not permitted");
});

// »Karten-Turn bindet an das Kartengespräch«
it("binds a card turn's composer controls to the card's own conversation and agent", async () => {
  const voice = mountVoice({ card: { id: "login", title: "Login bug" }, cardAgentId: "writer" });
  vi.mocked(voice.host.sessions.create)
    .mockResolvedValueOnce("agent:writer:board")
    .mockResolvedValueOnce("agent:main:board")
    .mockResolvedValueOnce("agent:writer:card");
  // Board conversations of both the card's agent and the selected agent exist already.
  Object.assign(voice.host.agents, { selectedId: "writer" });
  await resolveVoiceConversation(voice.host, planning);
  Object.assign(voice.host.agents, { selectedId: "main" });
  await resolveVoiceConversation(voice.host, planning);

  await voice.speak("make it urgent");
  expect(voice.sessionControls()).toMatchObject({
    sessionKey: null,
    agentId: "writer",
    disabledReason:
      "Model and thinking can be changed once the first turn creates this conversation.",
  });
  expect(voice.sendAction()!.props).toMatchObject({ sessionKey: null, agentId: "writer" });
  await voice.press("Send");
  expect(voice.sends()[0]?.[1]).toMatchObject({ sessionKey: "agent:writer:card" });

  await voice.speak("and assign it to me");
  expect(voice.sessionControls()).toMatchObject({
    sessionKey: "agent:writer:card",
    agentId: "writer",
    disabledReason: undefined,
  });
  expect(voice.sendAction()!.props).toMatchObject({ sessionKey: "agent:writer:card" });
});

it("targets the saved Board agent conversation of a Sessions board", async () => {
  const boardAgent = vi.fn(async () => ({
    sessionKey: "agent:ops:board",
    agentId: "ops",
    label: "Ops board",
  }));
  const board: { saved?: { sessionKey: string; agentId: string } } = {};
  const boardAgentTarget = vi.fn((_boardId: string) => board.saved);
  const voice = mountVoice({
    board: { id: "ops", kind: "sessions", name: "Ops" },
    boardAgent,
    boardAgentTarget,
  });
  await voice.speak("pin the failing session");
  expect(voice.sessionControls()).toMatchObject({
    sessionKey: null,
    disabledReason:
      "Model and thinking can be changed once the first turn creates this conversation.",
  });
  await voice.press("Discard");

  board.saved = { sessionKey: "agent:ops:board", agentId: "ops" };
  await voice.speak("pin the failing session");
  expect(boardAgentTarget).toHaveBeenLastCalledWith("ops");
  expect(voice.sessionControls()).toMatchObject({
    sessionKey: "agent:ops:board",
    agentId: "ops",
    disabledReason: undefined,
  });
  expect(boardAgent).not.toHaveBeenCalled();
});

// »Senden folgt Steuern/Einreihen des Composers«
it("sends with the queue or steer delivery the host composer resolved", async () => {
  const voice = mountVoice();
  await voice.speak("stop and look at the failing test");
  const send = voice.sendAction()!;
  send.followUpMode = "steer";
  send.click();
  await afterWorkboardUpdate(() => undefined);

  expect(voice.sends()).toHaveLength(1);
  expect(voice.sends()[0]?.[1]).toMatchObject({
    sessionKey: "agent:main:voice",
    message: "stop and look at the failing test",
    queueMode: "steer",
  });

  await voice.speak("then fix it");
  voice.sendAction()!.click();
  await afterWorkboardUpdate(() => undefined);
  expect(voice.sends()[1]?.[1]).not.toHaveProperty("queueMode");
});
