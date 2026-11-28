import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ControlUiComposerSessionControlsProps } from "../../../src/plugin-sdk/control-ui-components.js";
import type { ApplicationContext } from "../app/context.ts";
import { hasUnrestrictedModelCatalogSnapshot } from "../lib/model-catalog-cache.ts";
import { ModelCatalogReader } from "../lib/model-catalog-reader.ts";
import { resolveModelCatalogState } from "../lib/model-catalog-store.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { readChatPaneMutationAccess } from "../pages/chat/chat-pane-session-controls.ts";
import { switchChatModel, switchChatSetting } from "../pages/chat/chat-session.ts";
import { ChatModelControls } from "../pages/chat/components/chat-model-controls.tsx";
import { navigateToModelProvider } from "../pages/model-providers/navigation.ts";
import {
  observePluginSessionRow,
  pluginSessionAgentId,
  pluginSessionScope,
} from "./control-ui-session-row.ts";
import "../styles/chat/composer.css";
import "../styles/chat/composer-surface.css";

export type PluginComposerSessionControlsProps = Omit<
  ControlUiComposerSessionControlsProps,
  "onError"
> & {
  context: ApplicationContext | null;
  /** Changes whenever the Gateway, session roster or agents publish. */
  revision: object;
  onError: (message: string) => void;
};

function PluginComposerSessionControlsContent(props: PluginComposerSessionControlsProps) {
  const row = observePluginSessionRow(props);
  const [revision, setRevision] = createSignal<object>({});
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const notify = () => setRevision({});
  const catalog = new ModelCatalogReader(notify, { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS });
  onCleanup(() => catalog.clear());
  const agentId = () => (props.context ? pluginSessionAgentId(props.context, props) : "");
  createEffect(
    () => [props.context, props.revision, props.sessionKey, agentId()] as const,
    ([context, , sessionKey, agent]) => {
      if (!context) {
        catalog.clear();
        return;
      }
      // The composer's catalog scope: the conversation's agent, and the
      // conversation once it exists, so its account choice applies.
      if (
        catalog.bind(context.gateway, { agentId: agent, ...(sessionKey ? { sessionKey } : {}) })
      ) {
        void catalog.read();
      }
    },
  );
  const sessionsResult = () => {
    const result = props.context?.sessions.state.result;
    const session = row();
    return result ? { ...result, sessions: session ? [session] : [] } : null;
  };
  // The chat session-settings owners read their target through this host, so a
  // model or thinking choice takes the same sessions.patch path as the composer.
  const settingsHost = createMemo(() => {
    const context = props.context;
    if (!context) {
      return undefined;
    }
    return {
      ...pluginSessionScope(context),
      get sessionKey() {
        return props.sessionKey ?? "";
      },
      get client() {
        return context.gateway.snapshot.client;
      },
      get connected() {
        return context.gateway.snapshot.phase === "connected";
      },
      get chatModelCatalog() {
        return catalog.snapshot.models;
      },
      get sessionsResult() {
        return sessionsResult();
      },
      get sessionsResultAgentId() {
        return agentId();
      },
      chatModelSwitchPromises: {} as Record<string, Promise<boolean>>,
      chatThinkingLevel: null as string | null,
      lastError: null as string | null,
      get chatError() {
        return null;
      },
      set chatError(message: string | null) {
        if (message) {
          props.onError(message);
        }
      },
      requestUpdate: notify,
    };
  });
  const controls = createMemo(() => {
    void revision();
    void props.revision;
    const context = props.context;
    const host = settingsHost();
    const snapshot = context?.gateway.snapshot;
    const connected = snapshot?.phase === "connected";
    const session = row() ?? undefined;
    const key = props.sessionKey;
    const access = key && snapshot ? readChatPaneMutationAccess(snapshot, key, session) : undefined;
    const refusal = (allowed: { allowed: true } | { allowed: false; reason: string } | undefined) =>
      props.disabledReason ?? (!allowed ? undefined : allowed.allowed ? undefined : allowed.reason);
    const models = catalog.snapshot;
    const agent = agentId();
    return {
      host,
      context,
      agent,
      key,
      session,
      connected,
      gatewayAvailable: Boolean(snapshot?.client),
      catalog: models,
      catalogState: resolveModelCatalogState(models, {
        connected,
        loading: catalog.pending,
        error: catalog.failed ? "failed" : null,
        retired: models.retired,
        initialized: models.hasSnapshot || hasUnrestrictedModelCatalogSnapshot(snapshot?.client),
      }),
      agentDefaultModel: context?.agents.state.agentsList?.agents.find(
        (candidate) => candidate.id === agent,
      )?.model?.primary,
      // A conversation that does not exist yet shows its agent's defaults, unchangeable.
      modelRefusal: key ? refusal(access?.model) : props.disabledReason,
      effortRefusal: key ? refusal(access?.effort) : props.disabledReason,
      contextWindowRefusal: key ? refusal(access?.contextWindow) : props.disabledReason,
    };
  });
  const apply = (
    target: string,
    change: (host: NonNullable<ReturnType<typeof settingsHost>>) => Promise<boolean>,
  ) => {
    const host = settingsHost();
    return host && props.sessionKey && target === props.sessionKey
      ? change(host)
      : Promise.resolve(false);
  };
  return (
    <ChatModelControls
      activeRunId={null}
      agentDefaultModel={controls().agentDefaultModel}
      connected={controls().connected}
      gatewayAvailable={controls().gatewayAvailable}
      loading={false}
      modelCatalog={controls().catalog.models}
      modelCatalogState={controls().catalogState}
      modelOverrides={props.context?.sessions.state.modelOverrides}
      modelSelectionLocked={controls().session?.modelSelectionLocked === true}
      modelSelectionTarget={props.context?.sessions.state.result?.defaults.modelSelectionTarget}
      modelPickerOpen={pickerOpen()}
      modelSwitching={Boolean(
        controls().key && controls().host?.chatModelSwitchPromises[controls().key ?? ""],
      )}
      modelMutationDisabledReason={controls().modelRefusal}
      effortMutationDisabledReason={controls().effortRefusal}
      contextWindowMutationDisabledReason={controls().contextWindowRefusal}
      sending={false}
      sessionKey={controls().key ?? `new-session:${controls().agent}`}
      selectedSession={controls().session}
      thinkingSession={controls().session}
      fastModeTarget={controls().session}
      sessionsResult={sessionsResult()}
      stream={null}
      onModelSetup={() => controls().context?.navigate("model-setup")}
      onProviderSettings={(provider) =>
        navigateToModelProvider(controls().context ?? undefined, controls().agent, provider)
      }
      onModelPickerOpen={() => {
        if (!catalog.pending) {
          void catalog.read();
        }
      }}
      onModelPickerOpenChange={setPickerOpen}
      onModelSelect={(next, target, agentRuntime) =>
        apply(target, (host) => switchChatModel(host, next, target, agentRuntime))
      }
      onThinkingSelect={(next, target) =>
        apply(target, (host) =>
          switchChatSetting(host, { kind: "thinkingLevel", value: next }, target),
        )
      }
      onFastModeSelect={(next, target) =>
        apply(target, (host) => switchChatSetting(host, { kind: "fastMode", value: next }, target))
      }
      onContextWindowSelect={(next, target) =>
        apply(target, (host) =>
          switchChatSetting(host, { kind: "contextWindow", value: next }, target),
        )
      }
    />
  );
}

export const PluginComposerSessionControls = defineSolidBridge<PluginComposerSessionControlsProps>(
  "openclaw-plugin-composer-session-controls",
  PluginComposerSessionControlsContent,
  {
    properties: {
      context: { default: null, attribute: false },
      revision: { default: {}, attribute: false },
      sessionKey: { default: null, attribute: false },
      agentId: { default: undefined, attribute: false },
      disabledReason: { default: undefined, attribute: false },
      onError: { default: () => undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-composer-session-controls": SolidBridgeElement<PluginComposerSessionControlsProps>;
  }
}
