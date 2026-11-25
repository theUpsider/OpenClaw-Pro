import type { WorkboardAttachment } from "@openclaw/workboard-contract";
import { isGatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isMarkdownArtifact } from "./artifact-preview-source.ts";

/**
 * Attachment bytes and their declared MIME type are attacker-influenced: any agent or
 * operator can add one. In-app viewing is therefore limited to types this app renders
 * itself — markdown through the host's sanitizing mount, raster images through an image
 * element (which does not execute script). `text/html` and `image/svg+xml` stay
 * download-only; the accepted edge case is that those files are opened outside the Gateway
 * origin.
 *
 * application/pdf opens in a separate browser tab, never in an in-app frame. Measured with
 * the UI gate (Chrome 157, headless): the built-in viewer never renders inside a sandboxed
 * iframe — every sandbox value shows the broken-plugin placeholder — and an unsandboxed
 * frame would hand the bytes this origin. The tab instead gets a blob URL built from bytes
 * this app fetched over the RPC, and only after the `%PDF-` magic check below: the declared
 * type alone is not evidence.
 *
 * The name is not evidence either: a markdown *name* only counts when the declared type
 * does not contradict it, so a file called payload.md that declares text/html or
 * image/svg+xml is download-only rather than decoded as text.
 */
export type AttachmentViewKind =
  | { kind: "markdown" }
  | { kind: "image"; mimeType: string }
  | { kind: "pdf" };

/** The kinds the in-app dialog renders; a PDF opens in its own tab instead. */
export type AttachmentInlineViewKind = Exclude<AttachmentViewKind, { kind: "pdf" }>;

const MARKDOWN_MIME_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const TEXT_PLAIN_MIME_TYPES = new Set(["text/plain"]);
const RASTER_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The declared MIME *essence* (type/subtype, lowercased) without parameters. Parameters are
 * common and harmless — `image/png; charset=binary` is still a PNG — while exact matching keeps
 * lookalikes such as `text/markdown-extra` out of the render allowlists.
 */
function mimeEssence(mimeType: string | undefined): string {
  return (mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

export function attachmentViewKind(
  attachment: WorkboardAttachment,
): AttachmentViewKind | undefined {
  const mimeType = mimeEssence(attachment.mimeType);
  // Only the declared PDF type qualifies; a `.pdf` name alone is not evidence.
  if (mimeType === "application/pdf") {
    return { kind: "pdf" };
  }
  const declaredMarkdown = MARKDOWN_MIME_TYPES.has(mimeType);
  // An absent or plain-text declaration may still be a markdown file whose name says so;
  // anything else (.html, .svg, application/pdf) is a contradiction, and the declaration wins.
  const declarationAllowsTextMarkdown =
    mimeType === "" || TEXT_PLAIN_MIME_TYPES.has(mimeType) || declaredMarkdown;
  if (
    declaredMarkdown ||
    (declarationAllowsTextMarkdown && isMarkdownArtifact(attachment.fileName, undefined))
  ) {
    return { kind: "markdown" };
  }
  return RASTER_IMAGE_MIME_TYPES.has(mimeType) ? { kind: "image", mimeType } : undefined;
}

export type AttachmentReadFailure = { state: "denied" | "failed"; message: string };

/** One place decides what a failed attachment read says, for the row and the viewer. */
export function attachmentReadFailure(error: unknown): AttachmentReadFailure {
  // A scope refusal is a stable fact the operator can act on; transport faults are not.
  return isGatewayRequestError(error) && error.gatewayCode === "FORBIDDEN"
    ? { state: "denied", message: t("workboard.attachmentViewerDenied") }
    : { state: "failed", message: formatUiError(error, t("workboard.attachmentViewerFailed")) };
}

function base64ToBytes(contentBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Reads one persisted attachment through the RPC that takes the attachment id. */
export async function loadAttachmentBytes(
  client: Pick<GatewayBrowserClient, "request">,
  attachmentId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const payload = await client.request<{ contentBase64?: unknown }>(
    "workboard.cards.attachments.get",
    { id: attachmentId },
  );
  const contentBase64 = payload?.contentBase64;
  if (typeof contentBase64 !== "string" || !contentBase64) {
    throw new Error("attachment response does not include content");
  }
  return base64ToBytes(contentBase64);
}

/** Markdown must be real UTF-8 text; a misdeclared binary file is refused, not rendered. */
export function decodeAttachmentText(bytes: Uint8Array<ArrayBuffer>): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * One download per click. The Blob is forced to application/octet-stream — never the
 * declared MIME type — and handed to an anchor with `download`, so arbitrary bytes
 * (HTML, SVG, scripts) stay inert: the browser never grants them a document. The object
 * URL is revoked on a follow-up task rather than synchronously: the browser reads the Blob
 * asynchronously after click(), so an immediate revoke can abort the download.
 */
export async function downloadAttachment(
  client: Pick<GatewayBrowserClient, "request">,
  attachment: WorkboardAttachment,
): Promise<void> {
  const bytes = await loadAttachmentBytes(client, attachment.id);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `%PDF-`: the file signature every PDF starts with; a declared type is not evidence. */
export function isPdfBytes(bytes: Uint8Array<ArrayBuffer>): boolean {
  return (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

/**
 * Opens one verified PDF in a new tab. The tab gets a blob URL over bytes this app fetched
 * itself — never a document of the Gateway origin, and never the attachment request as a
 * navigation — and the URL is revoked on a follow-up task so it cannot outlive the click.
 * A popup blocker returning null leaves the row silent: Download always works, and the
 * browser's own affordance says what happened. Accepted edge case.
 */
export function openPdfInNewTab(bytes: Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
