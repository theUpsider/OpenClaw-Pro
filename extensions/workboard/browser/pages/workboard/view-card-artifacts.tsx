/** @jsxImportSource @solidjs/web */
import type { WorkboardArtifact, WorkboardAttachment } from "@openclaw/workboard-contract";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { workboardCardSessionKey } from "../../lib/workboard/card-state.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import { canShareArtifactRow } from "../../lib/workboard/share-channel.ts";
import {
  artifactPathAccess,
  loadArtifactFileAccess,
  type WorkboardArtifactFileAccess,
} from "./artifact-file-access.ts";
import { isMarkdownArtifact } from "./artifact-preview-source.ts";
import {
  attachmentReadFailure,
  attachmentViewKind,
  downloadAttachment,
  isPdfBytes,
  loadAttachmentBytes,
  openPdfInNewTab,
} from "./attachment-bytes.ts";
import { ArtifactPreviewDialog } from "./view-card-artifact-preview.tsx";
import { AttachmentViewerDialog } from "./view-card-attachment-preview.tsx";
import { ArtifactShareDialog, type ArtifactShareAccess } from "./view-card-share.tsx";
import type { WorkboardProps } from "./view-helpers.tsx";

type ArtifactRow = {
  id: string;
  label: string;
  type: string;
  /** Only http(s) URLs become links; other schemes stay copyable text. */
  href?: string;
  /** Host path or non-web URL shown as selectable text with a copy action. */
  reference?: string;
  /** Set only for markdown path artifacts, which open in the in-app preview. */
  previewPath?: string;
  /** The stored host path of a path artifact; server-approved access decides its actions. */
  path?: string;
  note?: string;
  /** Set only on attachment rows: the record the download and the in-app viewer act on. */
  attachment?: WorkboardAttachment;
};

function lastSegment(value: string): string {
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || value
  );
}

function webUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function artifactRow(artifact: WorkboardArtifact): ArtifactRow {
  const url = artifact.url?.trim();
  const path = artifact.path?.trim();
  const href = webUrl(url);
  const fallback = path
    ? lastSegment(path)
    : href
      ? lastSegment(new URL(href).pathname) || href
      : url;
  return {
    id: artifact.id,
    label: artifact.label?.trim() || fallback || artifact.id,
    type: artifact.mimeType?.trim() || t("workboard.artifactTypeFile"),
    ...(href ? { href } : {}),
    ...(path && isMarkdownArtifact(path, artifact.mimeType) ? { previewPath: path } : {}),
    ...(path ? { path } : {}),
    ...(path ? { reference: path } : url && !href ? { reference: url } : {}),
  };
}

function attachmentRow(attachment: WorkboardAttachment): ArtifactRow {
  const size = t("workboard.artifactAttachmentSize", {
    size: String(Math.max(1, Math.round(attachment.byteSize / 1024))),
  });
  return {
    id: attachment.id,
    label: attachment.fileName,
    type: [attachment.mimeType || t("workboard.artifactAttachment"), size].join(" · "),
    ...(attachment.note?.trim() ? { note: attachment.note.trim() } : {}),
    attachment,
  };
}

function CopyReference(props: { value: string }) {
  const [feedback, setFeedback] = createSignal<string>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setFeedback(t("workboard.artifactCopied"));
    } catch {
      setFeedback(t("workboard.artifactCopyFailed"));
    }
  };
  return (
    <>
      <button type="button" class="btn workboard-artifacts__action" onClick={() => void copy()}>
        {t("workboard.artifactCopyPath")}
      </button>
      <Show when={feedback()}>
        {(message) => (
          <span class="workboard-artifacts__feedback" role="status">
            {message()}
          </span>
        )}
      </Show>
    </>
  );
}

/**
 * The attachment row's own actions: Download always, Open for a type this app renders itself
 * or opens as a verified blob in a new tab. One click is one RPC: the button is disabled
 * until the read settles, and a failed read stays at the row instead of falling back to
 * navigating to the bytes.
 */
function AttachmentActions(props: {
  attachment: WorkboardAttachment;
  client: GatewayBrowserClient;
}) {
  const kind = createMemo(() => attachmentViewKind(props.attachment));
  // A PDF opens in its own tab; every other viewable kind goes to the in-app dialog.
  const pdf = createMemo(() => kind()?.kind === "pdf");
  const dialogKind = createMemo(() => {
    const current = kind();
    return current?.kind === "pdf" ? undefined : current;
  });
  const [busy, setBusy] = createSignal(false);
  const [feedback, setFeedback] = createSignal<string>();
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  const download = async () => {
    setFeedback(undefined);
    setBusy(true);
    try {
      await downloadAttachment(props.client, props.attachment);
    } catch (error) {
      setFeedback(attachmentReadFailure(error).message);
    } finally {
      setBusy(false);
    }
  };
  // A PDF needs its own read, magic check and object URL before the tab opens.
  const openPdf = async () => {
    setFeedback(undefined);
    setBusy(true);
    try {
      const bytes = await loadAttachmentBytes(props.client, props.attachment.id);
      // The declared type is not evidence: only bytes that really start with %PDF- open.
      if (!isPdfBytes(bytes)) {
        setFeedback(t("workboard.attachmentPdfNotPdf"));
        return;
      }
      openPdfInNewTab(bytes);
    } catch (error) {
      setFeedback(attachmentReadFailure(error).message);
    } finally {
      setBusy(false);
    }
  };
  // Two buttons because a PDF opens a tab while the other kinds open the in-app dialog.
  const pdfOpenButton = () => (
    <button
      type="button"
      class="btn workboard-artifacts__action"
      disabled={busy()}
      aria-label={t("workboard.artifactOpenLabel", { label: props.attachment.fileName })}
      onClick={() => void openPdf()}
    >
      {t("workboard.artifactOpen")}
    </button>
  );
  const dialogOpenButton = () => (
    <button
      type="button"
      class="btn workboard-artifacts__action"
      aria-haspopup="dialog"
      aria-label={t("workboard.artifactOpenLabel", { label: props.attachment.fileName })}
      ref={(element) => {
        trigger = element;
      }}
      onClick={() => setOpen(true)}
    >
      {t("workboard.artifactOpen")}
    </button>
  );
  return (
    <>
      <button
        type="button"
        class="btn workboard-artifacts__action"
        disabled={busy()}
        onClick={() => void download()}
      >
        {t("workboard.artifactDownload")}
      </button>
      <Show when={pdf()}>{pdfOpenButton()}</Show>
      <Show when={dialogKind()}>{dialogOpenButton()}</Show>
      <Show when={feedback()}>
        {(message) => (
          <span class="workboard-artifacts__feedback" role="status">
            {message()}
          </span>
        )}
      </Show>
      <Show when={open() && dialogKind()}>
        {(view) => (
          <AttachmentViewerDialog
            attachment={props.attachment}
            kind={view()}
            client={props.client}
            returnFocusTarget={trigger}
            onClose={() => setOpen(false)}
          />
        )}
      </Show>
    </>
  );
}

function PreviewArtifact(props: {
  row: ArtifactRow;
  path: string;
  client: GatewayBrowserClient;
  sessionKey?: string;
  agentId?: string;
}) {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  return (
    <>
      <button
        type="button"
        class="btn workboard-artifacts__action"
        aria-haspopup="dialog"
        aria-label={t("workboard.artifactPreviewLabel", { label: props.row.label })}
        ref={(element) => {
          trigger = element;
        }}
        onClick={() => setOpen(true)}
      >
        {t("workboard.artifactPreview")}
      </button>
      <Show when={open()}>
        <ArtifactPreviewDialog
          label={props.row.label}
          path={props.path}
          client={props.client}
          sessionKey={props.sessionKey}
          agentId={props.agentId}
          returnFocusTarget={trigger}
          onClose={() => setOpen(false)}
        />
      </Show>
    </>
  );
}

/** Opens the share dialog for one row; the receipt stays next to the action after it closes. */
function ShareArtifact(props: { row: ArtifactRow; access: ArtifactShareAccess }) {
  const [open, setOpen] = createSignal(false);
  const [receipt, setReceipt] = createSignal<string>();
  let trigger: HTMLButtonElement | undefined;
  return (
    <>
      <button
        type="button"
        class="btn workboard-artifacts__action"
        aria-haspopup="dialog"
        aria-label={t("workboard.shareActionLabel", { label: props.row.label })}
        ref={(element) => {
          trigger = element;
        }}
        onClick={() => {
          setReceipt(undefined);
          setOpen(true);
        }}
      >
        {t("workboard.shareAction")}
      </button>
      <Show when={receipt()}>
        {(message) => (
          <span class="workboard-artifacts__feedback" role="status">
            {message()}
          </span>
        )}
      </Show>
      <Show when={open()}>
        <ArtifactShareDialog
          artifact={props.row}
          access={props.access}
          returnFocusTarget={trigger}
          onClose={(message) => {
            setOpen(false);
            setReceipt(message);
          }}
        />
      </Show>
    </>
  );
}

/**
 * Path-artifact actions, drawn only from the server's own answer. A row the server did not
 * approve renders nothing: no dead button, and the row keeps Copy path (and Preview).
 */
function PathFileActions(props: { access: WorkboardArtifactFileAccess | undefined }) {
  return (
    <>
      <Show when={props.access?.open}>
        {(open) => (
          <a
            class="btn workboard-artifacts__action"
            href={open().url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("workboard.artifactOpen")}
          </a>
        )}
      </Show>
      <Show when={props.access?.download}>
        {(download) => (
          <a class="btn workboard-artifacts__action" href={download().url} download>
            {t("workboard.artifactDownload")}
          </a>
        )}
      </Show>
    </>
  );
}

/**
 * Everything the card produced, in one place. Rows only reference content: media is
 * never fetched or inlined, so large files such as demo videos stay at their path or URL.
 */
export function CardArtifacts(props: {
  card: WorkboardCard;
  onNavigate: (event: MouseEvent) => void;
  workboard: Pick<
    WorkboardProps,
    "client" | "canWrite" | "controlUi" | "scopeAgentId" | "defaultAgentId"
  >;
}) {
  // Sharing needs the Gateway; while disconnected the rows keep only Open and Copy path.
  const share = createMemo((): ArtifactShareAccess | undefined => {
    const { client, canWrite, controlUi, scopeAgentId, defaultAgentId } = props.workboard;
    return client
      ? {
          client,
          canWrite: canWrite !== false,
          canAdmin: controlUi?.connection.canAdmin === true,
          agentId: scopeAgentId || props.card.agentId || defaultAgentId,
        }
      : undefined;
  });
  const rows = createMemo(() => [
    ...(props.card.metadata?.artifacts ?? []).map(artifactRow),
    ...(props.card.metadata?.attachments ?? []).map(attachmentRow),
  ]);
  // One request per card, not one per row: the card owns the paths, so one answer covers
  // every path row. A card without path artifacts never asks, and rows the server did not
  // approve keep today's Copy path (and markdown Preview) behaviour.
  const [fileAccess, setFileAccess] = createSignal<Record<string, WorkboardArtifactFileAccess>>({});
  const fileAccessTarget = createMemo(() => {
    const client = props.workboard.client;
    const card = props.card;
    // Key on the artifact paths, not the card object: a live refresh that keeps the same
    // paths must not spend a second request.
    const paths = (card.metadata?.artifacts ?? [])
      .filter((artifact) => artifact.path?.trim())
      .map((artifact) => `${artifact.id}\u0000${artifact.path}`)
      .join("\n");
    return client && card.id && paths ? `${card.id}\u0000${paths}` : undefined;
  });
  createEffect(fileAccessTarget, (key) => {
    setFileAccess({});
    if (!key) {
      return;
    }
    const target = untrack(() => ({ client: props.workboard.client, cardId: props.card.id }));
    if (!target.client) {
      return;
    }
    let current = true;
    void loadArtifactFileAccess(target.client, target.cardId).then(
      (files) => {
        if (current) {
          setFileAccess(files);
        }
      },
      () => {
        // A failed lookup is not an error state of its own: the rows keep Copy path.
        if (current) {
          setFileAccess({});
        }
      },
    );
    onCleanup(() => {
      current = false;
    });
  });
  return (
    <Show when={rows().length}>
      <section class="workboard-detail__section workboard-artifacts">
        <h3>{t("workboard.artifactsTitle")}</h3>
        <ul class="workboard-artifacts__list">
          <For each={rows()} keyed={(row) => row.id}>
            {(row) => (
              <li class="workboard-artifacts__row">
                <div class="workboard-artifacts__heading">
                  <strong>{row().label}</strong>
                  <span class="workboard-artifacts__type">{row().type}</span>
                </div>
                <Show when={row().reference}>
                  {(reference) => <code class="workboard-artifacts__reference">{reference()}</code>}
                </Show>
                <Show when={row().note}>{(note) => <p>{note()}</p>}</Show>
                <div class="workboard-artifacts__actions">
                  <Show when={row().href}>
                    {(href) => (
                      <a
                        class="btn workboard-artifacts__action"
                        href={href()}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={props.onNavigate}
                      >
                        {t("workboard.artifactOpen")}
                      </a>
                    )}
                  </Show>
                  <Show when={row().reference}>
                    {(reference) => <CopyReference value={reference()} />}
                  </Show>
                  <Show when={row().previewPath ? props.workboard.client : undefined}>
                    {(client) => (
                      <PreviewArtifact
                        row={row()}
                        path={row().previewPath ?? ""}
                        client={client()}
                        sessionKey={workboardCardSessionKey(props.card)}
                        agentId={props.card.agentId}
                      />
                    )}
                  </Show>
                  <Show when={row().path}>
                    <PathFileActions access={artifactPathAccess(fileAccess(), row().id)} />
                  </Show>
                  <Show when={canShareArtifactRow(row()) ? share() : undefined}>
                    {(access) => <ShareArtifact row={row()} access={access()} />}
                  </Show>
                  <Show when={row().attachment}>
                    {(attachment) => (
                      <Show when={props.workboard.client}>
                        {(client) => (
                          <AttachmentActions attachment={attachment()} client={client()} />
                        )}
                      </Show>
                    )}
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
