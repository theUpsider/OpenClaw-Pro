import { createMemo, createSignal } from "solid-js";
import type { ControlUiComposerSendActionProps } from "../../../src/plugin-sdk/control-ui-components.js";
import type { ApplicationContext } from "../app/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { resolveChatPaneFollowUpMode } from "../pages/chat/chat-pane-state.ts";
import { getPendingChatPickerPatch } from "../pages/chat/chat-settings-patches.ts";
import { ChatSendAction } from "../pages/chat/components/chat-send-action.tsx";
import { hasDirectSessionRun } from "../pages/chat/run-lifecycle.ts";
import { observePluginSessionRow, pluginSessionScope } from "./control-ui-session-row.ts";
import "../styles/chat/composer.css";
import "../styles/chat/composer-surface.css";

export type PluginComposerSendActionProps = Omit<ControlUiComposerSendActionProps, "onSend"> & {
  context: ApplicationContext | null;
  /** Changes whenever the Gateway, session roster, settings or runtime config publish. */
  revision: object;
  onSend: ControlUiComposerSendActionProps["onSend"];
};

function PluginComposerSendActionContent(props: PluginComposerSendActionProps) {
  const row = observePluginSessionRow(props);
  const [settling, setSettling] = createSignal(false);
  const delivery = createMemo(() => {
    void props.revision;
    const context = props.context;
    const key = props.sessionKey;
    const session = row();
    if (!context || !key) {
      return { running: false, followUpMode: undefined };
    }
    const result = context.sessions.state.result;
    // The same owners as the composer: the Gateway's session queue facts and
    // the operator's follow-up preference, applied only while a run is live.
    return {
      running: hasDirectSessionRun({
        sessionKey: key,
        sessionsResult: result && { ...result, sessions: session ? [session] : [] },
      }),
      followUpMode: resolveChatPaneFollowUpMode(
        {
          settings: context.theme.settings,
          chatEffectiveQueueMode: session?.effectiveQueueMode,
          chatQueueModeOverride: session?.queueMode,
        },
        session ?? undefined,
        context.runtimeConfig.state,
      ),
    };
  });
  const send = async () => {
    const context = props.context;
    const key = props.sessionKey;
    const { running, followUpMode } = delivery();
    if (key && context) {
      // A send waits for model and thinking changes, as the composer's does.
      const pending = getPendingChatPickerPatch(
        pluginSessionScope(context),
        key,
        props.agentId || undefined,
      );
      if (pending) {
        setSettling(true);
        await pending;
        setSettling(false);
      }
    }
    // The composer queues locally; a plugin has no outbox, so queue maps to the
    // Gateway's follow-up queue, which also runs the turn after the current one.
    props.onSend(running ? (followUpMode === "queue" ? "followup" : followUpMode) : undefined);
  };
  return (
    <ChatSendAction
      canAbort={delivery().running}
      canSend={!props.disabledReason}
      sending={Boolean(props.sending) || settling()}
      draft={props.draft}
      followUpMode={delivery().followUpMode}
      submitDisabledReason={props.disabledReason}
      describedBy={props.describedBy}
      onSend={() => void send()}
    />
  );
}

export const PluginComposerSendAction = defineSolidBridge<PluginComposerSendActionProps>(
  "openclaw-plugin-composer-send-action",
  PluginComposerSendActionContent,
  {
    properties: {
      context: { default: null, attribute: false },
      revision: { default: {}, attribute: false },
      sessionKey: { default: null, attribute: false },
      agentId: { default: undefined, attribute: false },
      draft: { default: "", attribute: false },
      sending: { default: false, attribute: false },
      disabledReason: { default: undefined, attribute: false },
      describedBy: { default: undefined, attribute: false },
      onSend: { default: () => undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-composer-send-action": SolidBridgeElement<PluginComposerSendActionProps>;
  }
}
