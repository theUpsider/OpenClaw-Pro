/** @jsxImportSource @solidjs/web */
import type { WorkboardBoardSummary } from "@openclaw/workboard-contract";
import type {
  ControlUiComposerSendActionProps,
  ControlUiHost,
} from "openclaw/plugin-sdk/control-ui";
import { createSignal, createUniqueId, Show, untrack } from "solid-js";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  captureVoiceBoard,
  peekVoiceConversation,
  resolveVoiceConversation,
  sendVoiceBoardTurn,
  voiceConversationAgentId,
  type VoiceBoardCard,
  type VoiceBoardConversation,
} from "../lib/workboard/voice-board.ts";
import { agentDisplayName } from "../pages/workboard/agent-filter.ts";
import {
  ComposerSendAction,
  ComposerSessionControls,
  Dialog,
  DictationControl,
} from "./host-components.tsx";

/** The board, card, and Board agent resolver captured when dictation started. */
export type VoiceTurn = {
  board: Pick<WorkboardBoardSummary, "id" | "kind" | "name"> | null | undefined;
  card?: VoiceBoardCard;
  boardAgent?: (boardId: string) => Promise<VoiceBoardConversation>;
  /** The saved Board agent conversation, read without creating it. */
  boardAgentTarget?: (boardId: string) => { sessionKey: string; agentId?: string } | undefined;
};

/** Known: the dock agent is fixed before sending. Pending: a Board agent conversation is created on send. */
export type VoiceAgent =
  | { state: "known"; id: string }
  | { state: "pending" }
  | { state: "unknown" };

function agentName(host: ControlUiHost, id: string): string {
  return agentDisplayName(
    host.agents.rows.find((agent) => agent.id === id),
    id,
  );
}

/** Sessions boards run the turn in their saved Board agent conversation. */
function boardAgentFor(turn: VoiceTurn) {
  const { board, boardAgent } = turn;
  return board?.kind === "sessions" && boardAgent ? () => boardAgent(board.id) : undefined;
}

function voiceTurnAgent(host: ControlUiHost, turn: VoiceTurn): VoiceAgent {
  if (boardAgentFor(turn)) {
    return { state: "pending" };
  }
  const id = voiceConversationAgentId(host, turn.card);
  return id ? { state: "known", id } : { state: "unknown" };
}

/**
 * The conversation the turn will be sent to, as far as it exists before the
 * send. Nothing is created here: an absent conversation keeps the controls
 * disabled with the reason, and the send creates it as before.
 */
function voiceTurnConversation(
  host: ControlUiHost,
  turn: VoiceTurn,
): { sessionKey: string | null; agentId?: string; reason?: string } {
  const { board, card } = turn;
  if (boardAgentFor(turn) && board) {
    const saved = turn.boardAgentTarget?.(board.id);
    return saved ?? { sessionKey: null, reason: t("workboard.voice.settingsPending") };
  }
  // Mirrors resolveVoiceConversation: a card turn binds to the card's own conversation and agent.
  const agentId = voiceConversationAgentId(host, card);
  if (!agentId) {
    return { sessionKey: null, reason: t("workboard.voice.agentUnavailable") };
  }
  const dock = peekVoiceConversation(host, board, card);
  return dock
    ? { sessionKey: dock.sessionKey, agentId: dock.agentId }
    : { sessionKey: null, agentId, reason: t("workboard.voice.settingsPending") };
}

function voiceTurnTarget(turn: VoiceTurn): string {
  const board = turn.board ? turn.board.name || turn.board.id : t("workboard.voice.allBoards");
  return turn.card ? t("workboard.voice.cardTarget", { board, title: turn.card.title }) : board;
}

/** "Run by: <agent> · <target>": who runs the turn and what it is about. */
export function VoiceAttributionLine(props: { host: ControlUiHost; turn: VoiceTurn }) {
  const agent = () => {
    const resolved = voiceTurnAgent(props.host, props.turn);
    return resolved.state === "known"
      ? agentName(props.host, resolved.id)
      : t(
          resolved.state === "pending"
            ? "workboard.voice.agentPending"
            : "workboard.voice.agentUnknown",
        );
  };
  return (
    <p class="workboard-voice-gate__attribution">
      {t("workboard.voice.runBy", { agent: agent(), target: voiceTurnTarget(props.turn) })}
    </p>
  );
}

/**
 * Confirms one transcript before it becomes a turn. Sending reuses the
 * microphone's captured binding; discarding or a failed send executes nothing.
 * `onClose` receives the notice to show next to the microphone.
 */
export function VoiceTranscriptGate(props: {
  host: ControlUiHost;
  turn: VoiceTurn;
  text: string;
  onClose: (notice: string) => void;
}) {
  // The transcript seeds the field once; later edits belong to the operator.
  const [draft, setDraft] = createSignal(untrack(() => props.text));
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const messageId = createUniqueId();
  // sendVoiceBoardTurn rechecks write access at the send; this only explains the disabled button.
  const readOnly = () => !props.host.connection.canWrite;
  const message = () =>
    error() ??
    (readOnly()
      ? t("workboard.voice.readOnly")
      : draft().trim()
        ? undefined
        : t("workboard.voice.emptyTranscript"));
  const target = () => voiceTurnConversation(props.host, props.turn);
  const discard = () => props.onClose(t("workboard.voice.discarded"));
  const send = async (queueMode: Parameters<ControlUiComposerSendActionProps["onSend"]>[0]) => {
    const text = draft().trim();
    if (!text || readOnly() || sending()) {
      return;
    }
    const { host, turn } = props;
    const boardAgent = boardAgentFor(turn);
    let conversation: VoiceBoardConversation | undefined;
    setError(undefined);
    setSending(true);
    try {
      await sendVoiceBoardTurn(host, {
        text,
        binding: captureVoiceBoard(turn.board, turn.card),
        queueMode,
        conversation: async () =>
          (conversation = boardAgent
            ? await boardAgent()
            : await resolveVoiceConversation(host, turn.board, turn.card)),
      });
      // The agent's answer and any card change arrive later: the answer in the
      // dock, the change through the Workboard live refresh.
      if (conversation && !host.signal.aborted) {
        props.onClose(
          turn.card
            ? t("workboard.voice.cardSent", { title: turn.card.title })
            : t("workboard.voice.boardSent", { agent: agentName(host, conversation.agentId) }),
        );
      }
    } catch (cause) {
      setError(formatUiError(cause));
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog
      label={t("workboard.voice.gateTitle")}
      description={t("workboard.voice.gateDescription")}
      style="--openclaw-modal-width: 620px; --openclaw-modal-backdrop-filter: none;"
      onCancel={() => {
        // Escape discards, except while a send is in flight.
        if (sending()) {
          return false;
        }
        discard();
        return true;
      }}
    >
      {/* The host's send action sends; the form only keeps a submit from reloading. */}
      <form class="workboard-voice-gate" onSubmit={(event: SubmitEvent) => event.preventDefault()}>
        <h2>{t("workboard.voice.gateTitle")}</h2>
        <VoiceAttributionLine host={props.host} turn={props.turn} />
        <label class="workboard-voice-gate__field">
          <span>{t("workboard.voice.transcriptLabel")}</span>
          <textarea
            class="settings-input"
            rows="4"
            autofocus
            value={draft()}
            disabled={sending()}
            aria-describedby={message() ? messageId : undefined}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
        <Show when={message()}>
          {(text) => (
            <p class="workboard-voice__error" id={messageId} role="alert">
              {text()}
            </p>
          )}
        </Show>
        <div class="workboard-modal__actions">
          <ComposerSessionControls
            class="workboard-voice-gate__session"
            sessionKey={target().sessionKey}
            agentId={target().agentId}
            disabledReason={target().reason}
            onError={setError}
          />
          <DictationControl
            class="workboard-voice-gate__mic"
            enabled={!sending()}
            accessibleLabel={t("workboard.voice.recordAgain")}
            onStart={() => setError(undefined)}
            onTranscript={(text) => {
              // A new recording replaces the draft; an empty one never reaches here.
              if (text.trim()) {
                setDraft(text);
              }
            }}
            onError={setError}
          />
          <button class="btn" type="button" disabled={sending()} onClick={discard}>
            {t("workboard.voice.discard")}
          </button>
          <ComposerSendAction
            sessionKey={target().sessionKey}
            agentId={target().agentId}
            draft={draft()}
            sending={sending()}
            disabledReason={readOnly() ? t("workboard.voice.readOnly") : undefined}
            describedBy={message() ? messageId : undefined}
            onSend={(queueMode) => void send(queueMode)}
          />
        </div>
      </form>
    </Dialog>
  );
}
