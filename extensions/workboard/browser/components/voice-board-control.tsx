/** @jsxImportSource @solidjs/web */
import type { WorkboardBoardSummary, WorkboardCard } from "@openclaw/workboard-contract";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";
import { t } from "../i18n/index.ts";
import type { VoiceBoardConversation } from "../lib/workboard/voice-board.ts";
import { DictationControl } from "./host-components.tsx";
import { VoiceTranscriptGate, type VoiceTurn } from "./voice-gate.tsx";

type VisibleBoard = Pick<WorkboardBoardSummary, "id" | "kind" | "name"> | null | undefined;
type VisibleCard = Pick<WorkboardCard, "id" | "title">;

/**
 * Microphone for one spoken turn about the visible board, or about one card of
 * it when `card` is set. The transcript opens a confirmation gate; nothing is
 * sent until the operator sends it there. Recording is allowed on read-only
 * connections; the gate then explains why sending is unavailable.
 */
export function VoiceBoardControl(props: {
  host: ControlUiHost;
  board: VisibleBoard;
  /**
   * Sessions boards route to the saved Board agent conversation of the board
   * dictation started on; it refuses when that board is no longer shown.
   */
  boardAgent?: (boardId: string) => Promise<VoiceBoardConversation>;
  /** The saved Board agent conversation, read without creating it. */
  boardAgentTarget?: VoiceTurn["boardAgentTarget"];
  /** Card whose detail view hosts this microphone; the turn is bound to it. */
  card?: VisibleCard;
  /** The agent that owns `card`; a card turn runs as it in the card's own dock conversation. */
  cardAgentId?: string;
  class?: string;
}) {
  const [error, setError] = createSignal<string>();
  const [notice, setNotice] = createSignal<string>();
  const [gate, setGate] = createSignal<{ turn: VoiceTurn; text: string }>();
  // Captured when capture starts: navigation during speech must not retarget the turn.
  let captured: VoiceTurn | undefined;
  return (
    <div class={`workboard-voice ${props.class ?? ""}`}>
      <DictationControl
        enabled={!gate()}
        accessibleLabel={props.card ? t("workboard.voice.cardLabel") : t("workboard.voice.label")}
        onStart={() => {
          setError(undefined);
          setNotice(undefined);
          captured = {
            board: props.board,
            card: props.card && {
              id: props.card.id,
              title: props.card.title,
              agentId: props.cardAgentId,
            },
            boardAgent: props.boardAgent,
            boardAgentTarget: props.boardAgentTarget,
          };
        }}
        onTranscript={(text) => {
          const turn = captured;
          captured = undefined;
          if (turn) {
            setGate({ turn, text });
          }
        }}
        onError={(message) => setError(message)}
      />
      <Show when={notice()}>
        {(message) => (
          <span class="workboard-voice__sent" role="status">
            {message()}
          </span>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <span class="workboard-voice__error" role="alert">
            {message()}
          </span>
        )}
      </Show>
      <Show when={gate()}>
        {(pending) => (
          <VoiceTranscriptGate
            host={props.host}
            turn={pending().turn}
            text={pending().text}
            onClose={(message) => {
              setGate(undefined);
              setNotice(message);
            }}
          />
        )}
      </Show>
    </div>
  );
}
