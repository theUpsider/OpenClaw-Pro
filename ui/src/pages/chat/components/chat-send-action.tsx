import { createMemo, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Kbd, KeyboardShortcut } from "../../../components/solid/kbd.tsx";
import { canSubmitBeforeChatHistory } from "../../../lib/chat/commands.ts";
import {
  formatKeyboardShortcutParts,
  isApplePlatform,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../../lib/keyboard-shortcut-contract.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { createChatComposerContext } from "./chat-composer-frame.ts";

export function primaryPointerDownRef(read: () => ((event: PointerEvent) => void) | undefined) {
  // Preserve input focus before native tooltip listeners run at the target.
  return (button: HTMLButtonElement) =>
    button.addEventListener("pointerdown", (event) => read()?.(event), true);
}

type ChatRunControlsProps = ReturnType<typeof createChatComposerContext>["runControlsProps"];

type ChatSendActionProps = Pick<
  ChatRunControlsProps,
  "canAbort" | "canSend" | "sending" | "draft" | "onSend"
> &
  Partial<Omit<ChatRunControlsProps, "canAbort" | "canSend" | "sending" | "draft" | "onSend">> & {
    /** Plugin hosts point this at their own description of the action. */
    describedBy?: string;
  };

export function chatSendAvailability(props: ChatSendActionProps) {
  const hasComposedContent = () => Boolean(props.draft.trim() || props.hasAttachments);
  const sendDisabledReason = () =>
    props.canSend && canSubmitBeforeChatHistory(props.draft) ? null : props.submitDisabledReason;
  return {
    hasComposedContent,
    sendDisabledReason,
    hasSendableContent: () =>
      hasComposedContent() && props.canSend && !props.sending && !sendDisabledReason(),
  };
}

/** The send button and its send, queue or steer label; shared with plugin hosts. */
export function ChatSendAction(props: ChatSendActionProps) {
  const { hasComposedContent, sendDisabledReason, hasSendableContent } =
    chatSendAvailability(props);
  const labels = createMemo(() =>
    props.suggestionComposer
      ? (["chat.sessionSuggestions.suggest", "chat.sessionSuggestions.suggestMessage"] as const)
      : !props.canAbort || props.followUpMode === undefined || props.followUpMode === "interrupt"
        ? (["chat.runControls.send", "chat.runControls.sendMessage"] as const)
        : props.followUpMode === "steer"
          ? (["chat.queue.steer", "chat.followUpModeSteer"] as const)
          : (["chat.runControls.queue", "chat.runControls.queueMessage"] as const),
  );
  const label = () => props.submissionLabel ?? t(labels()[0]);
  const description = () => props.submissionLabel ?? t(labels()[1]);
  const alternateLabel = () =>
    t(props.alternateFollowUpMode === "queue" ? "chat.runControls.queue" : "chat.queue.steer");
  const alternateAvailable = () =>
    props.alternateFollowUpMode && props.canSend && hasComposedContent();
  const tooltip = () =>
    alternateAvailable()
      ? `${label()} ⏎ · ${alternateLabel()} ${t("chat.sendShortcutModifierEnter")}`
      : label();
  const tooltipTemplate = () =>
    alternateAvailable() ? (
      <span slot="content">
        {label()}{" "}
        <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.modifiedEnter} inline />
        {" · "}
        {alternateLabel()}{" "}
        <Kbd
          keys={
            isApplePlatform()
              ? t("chat.sendShortcutModifierEnter")
              : formatKeyboardShortcutParts(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter, false)
          }
          inline
        />
      </span>
    ) : undefined;
  const sendBusy = () => props.sending || Boolean(sendDisabledReason() && props.submitPending);
  const sendStatus = () =>
    sendDisabledReason() ??
    (props.sending
      ? t("chat.composer.sendingMessage")
      : hasComposedContent()
        ? null
        : t("chat.composer.emptyHint"));
  return (
    <openclaw-tooltip
      prop:content={
        props.preparingAttachments
          ? t("chat.composer.preparingAttachments")
          : (sendStatus() ?? tooltip())
      }
    >
      <Show when={!props.preparingAttachments && sendStatus() == null}>{tooltipTemplate()}</Show>
      <button
        class={`chat-send-btn chat-send-btn--send${props.sending ? " chat-send-btn--sending" : ""}`}
        ref={primaryPointerDownRef(() => props.onPrimaryActionPointerDown)}
        onClick={(event) => props.onSend(event)}
        disabled={!hasSendableContent()}
        aria-label={sendStatus() ?? description()}
        aria-describedby={props.describedBy}
        aria-busy={sendBusy() || props.preparingAttachments ? "true" : "false"}
      >
        {sendBusy() ? <span class="btn__spinner" aria-hidden="true" /> : <Icon name="arrowUp" />}
        <span class="agent-chat__control-label">{label()}</span>
      </button>
    </openclaw-tooltip>
  );
}
