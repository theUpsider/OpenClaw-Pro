import type { WorkboardBoardSummary, WorkboardCard } from "@openclaw/workboard-contract";
import type { ControlUiHost, ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import { t } from "../../i18n/index.ts";

/**
 * The board, and the card from a card detail view, on screen when dictation
 * started; reference data, never authority.
 */
export type VoiceBoardBinding = {
  boardId: string;
  boardKind: "cards" | "sessions";
  cardId?: string;
};

export type VoiceBoardConversation = { sessionKey: string; agentId: string; label: string };

/** The card a card-detail turn is about; `agentId` is the agent that owns the card. */
export type VoiceBoardCard = Pick<WorkboardCard, "id" | "title"> & { agentId?: string };

/** The all-boards view has no single visible board, so it captures no binding. */
export function captureVoiceBoard(
  board: Pick<WorkboardBoardSummary, "id" | "kind"> | null | undefined,
  card?: Pick<WorkboardCard, "id">,
): VoiceBoardBinding | undefined {
  return board
    ? {
        boardId: board.id,
        boardKind: board.kind === "sessions" ? "sessions" : "cards",
        ...(card ? { cardId: card.id } : {}),
      }
    : undefined;
}

// Card boards have no saved Board agent conversation. Reuse one dock conversation
// per agent, board, and card for this plugin lifetime instead of one per utterance.
const conversations = new WeakMap<ControlUiHost, Map<string, VoiceBoardConversation>>();

/**
 * The agent a card-board voice conversation runs as; read without creating one.
 * A card turn runs as the card's agent, a board turn as the selected or default agent.
 */
export function voiceConversationAgentId(
  host: ControlUiHost,
  card?: VoiceBoardCard,
): string | undefined {
  return (
    card?.agentId ||
    (host.agents.scopeId ??
      host.agents.selectedId ??
      host.agents.defaultId ??
      host.connection.assistantAgentId ??
      undefined)
  );
}

// A card turn never lands in the board's conversation, nor in another card's.
function conversationCacheKey(
  agentId: string,
  board: Pick<WorkboardBoardSummary, "id"> | null | undefined,
  card: Pick<WorkboardCard, "id"> | undefined,
) {
  return JSON.stringify([agentId, board?.id ?? "", card?.id ?? ""]);
}

/**
 * The dock conversation the next card-board turn reuses, read without creating
 * or checking it; undefined until a first turn creates one.
 */
export function peekVoiceConversation(
  host: ControlUiHost,
  board: Pick<WorkboardBoardSummary, "id"> | null | undefined,
  card?: VoiceBoardCard,
): VoiceBoardConversation | undefined {
  const agentId = voiceConversationAgentId(host, card);
  return agentId
    ? conversations.get(host)?.get(conversationCacheKey(agentId, board, card))
    : undefined;
}

export async function resolveVoiceConversation(
  host: ControlUiHost,
  board: Pick<WorkboardBoardSummary, "id" | "name"> | null | undefined,
  card?: VoiceBoardCard,
): Promise<VoiceBoardConversation> {
  const agentId = voiceConversationAgentId(host, card);
  if (!agentId) {
    throw new Error(t("workboard.voice.agentUnavailable"));
  }
  const key = conversationCacheKey(agentId, board, card);
  const cache = conversations.get(host) ?? new Map<string, VoiceBoardConversation>();
  conversations.set(host, cache);
  const cached = cache.get(key);
  if (cached) {
    // The operator may delete the dock conversation; the next turn then starts a fresh one.
    const { session } = await host.request<{ session: ControlUiSession | null }>(
      "sessions.describe",
      { key: cached.sessionKey },
    );
    if (session?.isDock) {
      return cached;
    }
    cache.delete(key);
  }
  const boardName = board ? board.name || board.id : t("workboard.voice.allBoards");
  const label = t("workboard.voice.conversationLabel", {
    name: card
      ? t("workboard.voice.cardTarget", { board: boardName, title: card.title })
      : boardName,
  });
  const sessionKey = await host.sessions.create({
    agentId,
    displayName: label,
    surface: "plugin-dock",
  });
  if (!sessionKey) {
    throw new Error(t("workboard.voice.createFailed"));
  }
  const conversation = { sessionKey, agentId, label };
  cache.set(key, conversation);
  return conversation;
}

/**
 * Send one spoken turn and show its conversation in the dock. The Gateway admits
 * `toolBindings` only from a paired browser copilot, so the visible board travels
 * as Working context; the agent still mutates only through existing tools.
 */
export async function sendVoiceBoardTurn(
  host: ControlUiHost,
  params: {
    text: string;
    binding: VoiceBoardBinding | undefined;
    conversation: () => Promise<VoiceBoardConversation | undefined>;
    /** The host composer's delivery for a running conversation; omitted when nothing runs. */
    queueMode?: "steer" | "followup" | "collect" | "interrupt";
  },
): Promise<void> {
  const dock = host.dock;
  if (!dock) {
    throw new Error(t("workboard.voice.dockUnavailable"));
  }
  // Reading the board is not a mutation, but every turn is a chat.send write.
  if (!host.connection.canWrite) {
    throw new Error(t("workboard.voice.readOnly"));
  }
  const conversation = await params.conversation();
  if (!conversation || host.signal.aborted) {
    return;
  }
  const context = {
    page: "workboard",
    ...(params.binding ? { detail: { ...params.binding } } : {}),
  };
  await host.request("chat.send", {
    sessionKey: conversation.sessionKey,
    message: params.text,
    idempotencyKey: crypto.randomUUID(),
    workContext: context,
    ...(params.queueMode ? { queueMode: params.queueMode } : {}),
  });
  if (!host.signal.aborted) {
    dock.openSession({ ...conversation, context });
  }
}
