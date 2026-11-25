/** @jsxImportSource @solidjs/web */
import { Show, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { Dialog, Markdown } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadArtifactPreview } from "./artifact-preview-source.ts";

type PreviewState =
  | { state: "loading" }
  | { state: "ready"; markdown: string }
  | { state: "unsupported" }
  | { state: "failed"; error: string };

/** Renders one markdown artifact through the host Markdown mount; the read is dropped once closed. */
export function ArtifactPreviewDialog(props: {
  label: string;
  path: string;
  client: Pick<GatewayBrowserClient, "request">;
  sessionKey?: string | null;
  agentId?: string | null;
  returnFocusTarget?: HTMLElement;
  onClose: () => void;
}) {
  const [view, setView] = createSignal<PreviewState>({ state: "loading" });
  const readyMarkdown = createMemo(() => {
    const current = view();
    return current.state === "ready" ? current.markdown : undefined;
  });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  // The target is fixed for the dialog's lifetime; a different row mounts a new dialog.
  void loadArtifactPreview({
    ...untrack(() => ({
      client: props.client,
      path: props.path,
      sessionKey: props.sessionKey,
      agentId: props.agentId,
    })),
    isCurrent: () => !disposed,
  }).then((result) => {
    if (disposed) {
      return;
    }
    setView(
      result.state === "failed" ? { state: "failed", error: formatUiError(result.error) } : result,
    );
  });
  return (
    <Dialog
      label={props.label}
      description={props.path}
      returnFocusTarget={props.returnFocusTarget}
      style="--openclaw-modal-width: 820px; --openclaw-modal-backdrop-filter: none;"
      onCancel={() => {
        props.onClose();
        return true;
      }}
    >
      <div class="workboard-artifact-preview">
        <h2>{props.label}</h2>
        <Show when={view().state === "loading"}>
          <p role="status">{t("workboard.artifactPreviewLoading")}</p>
        </Show>
        <Show when={view().state === "unsupported"}>
          <p role="alert">{t("workboard.artifactPreviewUnsupported")}</p>
        </Show>
        <Show when={view().state === "failed"}>
          <p role="alert">{t("workboard.artifactPreviewFailed")}</p>
        </Show>
        <Show when={readyMarkdown()}>
          {(markdown) => (
            <Markdown
              markdown={markdown()}
              mode="document"
              codeBlockChrome="none"
              class="workboard-artifact-preview__body"
            />
          )}
        </Show>
        <div class="workboard-artifacts__actions">
          <button type="button" class="btn" onClick={() => props.onClose()}>
            {t("workboard.artifactPreviewClose")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
