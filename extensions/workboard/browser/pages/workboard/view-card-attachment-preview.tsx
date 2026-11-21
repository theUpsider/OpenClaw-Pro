/** @jsxImportSource @solidjs/web */
import type { WorkboardAttachment } from "@openclaw/workboard-contract";
import { Show, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { Dialog, Markdown } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import {
  attachmentReadFailure,
  decodeAttachmentText,
  loadAttachmentBytes,
  type AttachmentInlineViewKind,
} from "./attachment-bytes.ts";

type AttachmentViewerState =
  | { state: "loading" }
  | { state: "markdown"; markdown: string }
  | { state: "image"; url: string }
  | { state: "unsupported" }
  | { state: "denied"; message: string }
  | { state: "failed"; message: string };

/**
 * Renders one attachment whose type has an in-app viewer. The bytes stay behind the Gateway
 * RPC and never reach a document: markdown goes through the host's sanitizing mount, raster
 * images through an <img> with a blob URL. A failed read shows the error in place — there is
 * deliberately no fallback to navigating to the bytes.
 */
export function AttachmentViewerDialog(props: {
  attachment: WorkboardAttachment;
  kind: AttachmentInlineViewKind;
  client: Pick<GatewayBrowserClient, "request">;
  returnFocusTarget?: HTMLElement;
  onClose: () => void;
}) {
  // The row fixes attachment and kind for the dialog's lifetime; a different row mounts a new dialog.
  const attachment = untrack(() => props.attachment);
  const kind = untrack(() => props.kind);
  const client = untrack(() => props.client);
  const [view, setView] = createSignal<AttachmentViewerState>({ state: "loading" });
  let createdImageUrl: string | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    if (createdImageUrl) {
      URL.revokeObjectURL(createdImageUrl);
    }
  });
  const markdown = createMemo(() => {
    const current = view();
    return current.state === "markdown" ? current.markdown : undefined;
  });
  const imageUrl = createMemo(() => {
    const current = view();
    return current.state === "image" ? current.url : undefined;
  });
  const errorMessage = createMemo(() => {
    const current = view();
    return current.state === "denied" || current.state === "failed" ? current.message : undefined;
  });
  void loadAttachmentBytes(client, attachment.id).then(
    (bytes) => {
      if (disposed) {
        return;
      }
      if (kind.kind === "markdown") {
        // A misdeclared binary file is refused here rather than rendered as mojibake.
        const source = decodeAttachmentText(bytes);
        setView(
          source === undefined ? { state: "unsupported" } : { state: "markdown", markdown: source },
        );
        return;
      }
      createdImageUrl = URL.createObjectURL(new Blob([bytes], { type: kind.mimeType }));
      setView({ state: "image", url: createdImageUrl });
    },
    (error: unknown) => {
      if (disposed) {
        return;
      }
      const failure = attachmentReadFailure(error);
      setView({ state: failure.state, message: failure.message });
    },
  );
  return (
    <Dialog
      label={attachment.fileName}
      description={attachment.mimeType?.trim() || t("workboard.artifactAttachment")}
      returnFocusTarget={props.returnFocusTarget}
      style="--openclaw-modal-width: 820px; --openclaw-modal-backdrop-filter: none;"
      onCancel={() => {
        props.onClose();
        return true;
      }}
    >
      <div class="workboard-attachment-viewer">
        <h2>{attachment.fileName}</h2>
        <Show when={view().state === "loading"}>
          <p role="status">{t("workboard.attachmentViewerLoading")}</p>
        </Show>
        <Show when={view().state === "unsupported"}>
          <p role="alert">{t("workboard.attachmentViewerUnsupported")}</p>
        </Show>
        <Show when={errorMessage()}>{(message) => <p role="alert">{message()}</p>}</Show>
        <Show when={markdown()}>
          {(source) => (
            <Markdown
              markdown={source()}
              mode="document"
              codeBlockChrome="none"
              class="workboard-attachment-viewer__body"
            />
          )}
        </Show>
        <Show when={imageUrl()}>
          {(url) => (
            <img
              class="workboard-attachment-viewer__image"
              src={url()}
              alt={attachment.fileName}
              // A declared raster type can still carry bytes no decoder accepts. Say so in
              // place, like every other failure here, instead of showing a broken image icon.
              onError={() => setView({ state: "unsupported" })}
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
