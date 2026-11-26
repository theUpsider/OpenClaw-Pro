/** @jsxImportSource @solidjs/web */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  untrack,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { Dialog, SelectPicker } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  buildShareMessage,
  loadShareChannels,
  loadShareSuggestions,
  sendArtifactShare,
  type ShareableArtifact,
  type ShareChannel,
  type ShareSuggestion,
} from "../../lib/workboard/share-channel.ts";

/** Gateway access the share dialog runs with; the Gateway still enforces every scope. */
export type ArtifactShareAccess = {
  client: GatewayBrowserClient;
  canWrite: boolean;
  canAdmin: boolean;
  /** Agent whose conversation directory supplies recipient suggestions. */
  agentId?: string | null;
};

type ChannelsState =
  | { state: "loading" }
  | { state: "failed"; error: string }
  | { state: "ready"; channels: ShareChannel[] };

/**
 * Sends one artifact reference as plain text through the Gateway `send` method. Nothing is sent
 * until Send: picking a channel, account, or suggestion only edits the form. Cancel and Escape
 * close without a request; a failed send keeps the dialog and every field for a retry.
 * `onClose` receives the receipt to show at the row after a successful send.
 */
export function ArtifactShareDialog(props: {
  artifact: ShareableArtifact;
  access: ArtifactShareAccess;
  returnFocusTarget?: HTMLElement;
  onClose: (receipt?: string) => void;
}) {
  const message = createMemo(() => buildShareMessage(props.artifact));
  // The operator's client is fixed for the dialog's lifetime; access flags stay live below.
  const client = untrack(() => props.access.client);
  const [channels, setChannels] = createSignal<ChannelsState>({ state: "loading" });
  const [channelId, setChannelId] = createSignal("");
  const [accountId, setAccountId] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [suggestions, setSuggestions] = createSignal<ShareSuggestion[]>([]);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const reasonId = createUniqueId();
  const suggestionsId = createUniqueId();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const available = () => {
    const current = channels();
    return current.state === "ready" ? current.channels : [];
  };
  const channel = () => available().find((entry) => entry.id === channelId());

  void loadShareChannels(client).then(
    (loaded) => {
      if (disposed) {
        return;
      }
      setChannels({ state: "ready", channels: loaded });
      const first = loaded[0];
      if (first) {
        setChannelId(first.id);
        setAccountId(first.defaultAccountId);
      }
    },
    (cause: unknown) => {
      if (!disposed) {
        setChannels({ state: "failed", error: formatUiError(cause) });
      }
    },
  );

  // Suggestions follow the chosen route; stale answers for an earlier route are dropped.
  let suggestionRequest = 0;
  createEffect(
    () => ({
      channel: channelId(),
      accountId: accountId(),
      canAdmin: props.access.canAdmin,
      agentId: props.access.agentId,
    }),
    (route) => {
      const request = ++suggestionRequest;
      setSuggestions([]);
      if (!route.channel) {
        return;
      }
      void loadShareSuggestions({ client, ...route }).then((loaded) => {
        if (!disposed && request === suggestionRequest) {
          setSuggestions(loaded);
        }
      });
    },
  );

  // Why Send is unavailable, shown next to the field; errors take precedence.
  const reason = () => {
    const current = channels();
    if (current.state === "loading") {
      return t("workboard.shareChannelsLoading");
    }
    if (current.state === "failed") {
      return undefined;
    }
    if (!current.channels.length) {
      return t("workboard.shareNoChannels");
    }
    if (!props.access.canWrite) {
      return t("workboard.shareReadOnly");
    }
    return target().trim() ? undefined : t("workboard.shareTargetRequired");
  };
  const failure = () => {
    const current = channels();
    return current.state === "failed"
      ? t("workboard.shareChannelsFailed", { error: current.error })
      : error();
  };
  const canSend = () =>
    !sending() && !reason() && channels().state === "ready" && Boolean(channel());

  const send = async () => {
    const route = channel();
    const to = target().trim();
    // Write access is rechecked at the click; the Gateway enforces it again.
    if (!route || !to || sending() || !untrack(() => props.access.canWrite)) {
      return;
    }
    setError(undefined);
    setSending(true);
    const result = await sendArtifactShare({
      client,
      channel: route.id,
      accountId: accountId() || route.defaultAccountId,
      to,
      message: message(),
    });
    if (disposed) {
      return;
    }
    setSending(false);
    if (result.ok) {
      props.onClose(t("workboard.shareSent", { target: to, channel: route.label }));
    } else {
      setError(t("workboard.shareFailed", { error: result.error }));
    }
  };

  return (
    <Dialog
      label={t("workboard.shareTitle")}
      description={t("workboard.shareIntro")}
      returnFocusTarget={props.returnFocusTarget}
      style="--openclaw-modal-width: 620px; --openclaw-modal-backdrop-filter: none;"
      onCancel={() => {
        // Escape closes without sending, except while a send is in flight.
        if (sending()) {
          return false;
        }
        props.onClose();
        return true;
      }}
    >
      <form
        class="workboard-share"
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          void send();
        }}
      >
        <h2>{t("workboard.shareTitle")}</h2>
        <p class="workboard-share__intro">{t("workboard.shareIntro")}</p>
        <div class="workboard-share__preview">
          <span>{t("workboard.shareMessageLabel")}</span>
          <code class="workboard-share__message">{message()}</code>
        </div>
        <Show when={channels().state === "ready" && available().length > 0}>
          <div class="workboard-share__route">
            <div class="workboard-share__field">
              <span>{t("workboard.shareChannelLabel")}</span>
              <SelectPicker
                {...{
                  value: channelId(),
                  options: available().map((entry) => ({ value: entry.id, label: entry.label })),
                  accessibleLabel: t("workboard.shareChannelLabel"),
                  disabled: sending(),
                  onSelect: (value) => {
                    const next = available().find((entry) => entry.id === value);
                    if (next) {
                      setChannelId(next.id);
                      setAccountId(next.defaultAccountId);
                    }
                  },
                }}
                class="workboard-share__picker"
              />
            </div>
            <Show when={channel()?.needsAccountChoice ? channel() : undefined}>
              {(chosen) => (
                <div class="workboard-share__field">
                  <span>{t("workboard.shareAccountLabel")}</span>
                  <SelectPicker
                    {...{
                      value: accountId(),
                      options: chosen().accounts.map((account) => ({
                        value: account.id,
                        label: account.label,
                      })),
                      accessibleLabel: t("workboard.shareAccountLabel"),
                      disabled: sending(),
                      onSelect: setAccountId,
                    }}
                    class="workboard-share__picker"
                  />
                </div>
              )}
            </Show>
          </div>
        </Show>
        <label class="workboard-share__field">
          <span>{t("workboard.shareTargetLabel")}</span>
          <input
            class="settings-input"
            type="text"
            autocomplete="off"
            autofocus
            value={target()}
            placeholder={t("workboard.shareTargetPlaceholder")}
            list={suggestions().length ? suggestionsId : undefined}
            disabled={sending()}
            aria-describedby={`${reasonId}-help ${reasonId}`}
            onInput={(event) => setTarget(event.currentTarget.value)}
          />
        </label>
        <Show when={suggestions().length}>
          <datalist id={suggestionsId}>
            <For each={suggestions()} keyed={(entry) => entry.value}>
              {(entry) => <option value={entry().value} label={entry().label} />}
            </For>
          </datalist>
        </Show>
        <p class="workboard-share__help" id={`${reasonId}-help`}>
          {t("workboard.shareTargetHelp")}
        </p>
        <div id={reasonId}>
          <Show when={failure()}>
            {(text) => (
              <p class="workboard-share__error" role="alert">
                {text()}
              </p>
            )}
          </Show>
          <p class="workboard-share__reason" role="status">
            {sending() ? t("workboard.shareSending") : (reason() ?? "")}
          </p>
        </div>
        <div class="workboard-modal__actions">
          <button class="btn" type="button" disabled={sending()} onClick={() => props.onClose()}>
            {t("workboard.shareCancel")}
          </button>
          <button
            class="btn primary"
            type="submit"
            disabled={!canSend()}
            aria-describedby={reasonId}
          >
            {sending() ? t("workboard.shareSending") : t("workboard.shareSend")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
