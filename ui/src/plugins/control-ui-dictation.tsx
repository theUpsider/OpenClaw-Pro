import { createMemo, createSignal, onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import {
  renderComposerVoiceButtonSolid as ComposerVoiceButton,
  renderMicrophonePickerSolid as MicrophonePicker,
} from "../pages/chat/components/chat-composer-controls.tsx";
import { NewSessionDictationControl } from "../pages/new-session/composer-dictation-control.ts";
import { NewSessionDictationStatus } from "../pages/new-session/composer-dictation-view.tsx";
import "../styles/chat/composer.css";
import "../styles/chat/composer-surface.css";

export type PluginDictationControlProps = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  inputDeviceId: string | undefined;
  enabled: boolean;
  disabledReason: string | undefined;
  accessibleLabel: string;
  onStart: () => void;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onStateChange: (state: { active: boolean }) => void;
};

const OWNER_KEY = "plugin-dictation";

function PluginDictationControlContent(props: PluginDictationControlProps) {
  const [revision, setRevision] = createSignal<object>({});
  let active = false;
  let alive = true;
  // The New Session wiring is the composer's direct-tap dictation without Talk.
  // A transcript-only target turns its commit into one plugin callback.
  const control: NewSessionDictationControl = new NewSessionDictationControl({
    textarea: {
      captureSelection: () => props.onStart(),
      previewTranscript: () => undefined,
      insertTranscript: (transcript) => {
        const text = transcript.trim();
        if (text) {
          props.onTranscript(text);
        }
        return null;
      },
    },
    getClient: () => props.client,
    isConnected: () => props.connected,
    canCommit: () => props.enabled,
    onMessage: () => undefined,
    onError: (message) => {
      if (alive) {
        props.onError(message);
      }
    },
    onSubmit: () => undefined,
    requestUpdate: () => {
      // Disposal settles the capture and must not call back into a retired mount.
      if (!alive) {
        return;
      }
      setRevision({});
      if (control.active !== active) {
        active = control.active;
        props.onStateChange({ active });
      }
    },
    idleLabel: () => props.accessibleLabel,
  });
  onCleanup(() => {
    alive = false;
    control.dispose();
  });
  const presentation = createMemo(() => {
    void revision();
    return control.prepare(OWNER_KEY, props.inputDeviceId);
  });
  const microphonePicker = <MicrophonePicker {...presentation().voice.microphonePicker} />;
  return (
    <span class="plugin-dictation-control">
      <ComposerVoiceButton
        {...presentation().voice}
        submitDisabledReason={props.enabled ? null : (props.disabledReason ?? null)}
        microphonePicker={microphonePicker}
      />
      <NewSessionDictationStatus control={control} renderRevision={revision()} />
    </span>
  );
}

export const PluginDictationControl = defineSolidBridge<PluginDictationControlProps>(
  "openclaw-plugin-dictation-control",
  PluginDictationControlContent,
  {
    properties: {
      client: { default: null, attribute: false },
      connected: { default: false, attribute: false },
      inputDeviceId: { default: undefined, attribute: false },
      enabled: { default: false, attribute: false },
      disabledReason: { default: undefined, attribute: false },
      accessibleLabel: { default: "", attribute: false },
      onStart: { default: () => undefined, attribute: false },
      onTranscript: { default: () => undefined, attribute: false },
      onError: { default: () => undefined, attribute: false },
      onStateChange: { default: () => undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-dictation-control": SolidBridgeElement<PluginDictationControlProps>;
  }
}
