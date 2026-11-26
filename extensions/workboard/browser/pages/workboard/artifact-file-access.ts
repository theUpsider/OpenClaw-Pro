import type { WorkboardArtifact } from "@openclaw/workboard-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

/**
 * Card artifacts may name a host path the Gateway can serve itself. The browser never
 * builds a path-derived URL and never receives a raw path: it asks the Gateway once per
 * card for server-approved access (`workboard.artifacts.fileAccess`) and uses only the
 * opaque ticket URLs from that answer.
 *
 * `open` exists only when the operator configured a base URL for the artifact's root and
 * the type is not a document; `download` is the Gateway's own attachment URL, minted for
 * one already-resolved file, and works for every approved path including documents.
 */
export type WorkboardArtifactFileAccess = {
  open?: { url: string };
  download?: { url: string; expiresAt?: string };
};

function readEntry(value: unknown): WorkboardArtifactFileAccess | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { open?: { url?: unknown }; download?: { url?: unknown } };
  const openUrl = typeof record.open?.url === "string" ? record.open.url : undefined;
  const downloadUrl = typeof record.download?.url === "string" ? record.download.url : undefined;
  if (!openUrl && !downloadUrl) {
    return undefined;
  }
  return {
    ...(openUrl ? { open: { url: openUrl } } : {}),
    ...(downloadUrl ? { download: { url: downloadUrl } } : {}),
  };
}

/** Reads the server-approved access for every path artifact of one card, in one request. */
export async function loadArtifactFileAccess(
  client: Pick<GatewayBrowserClient, "request">,
  cardId: string,
): Promise<Record<string, WorkboardArtifactFileAccess>> {
  const payload = await client.request<{ files?: unknown }>("workboard.artifacts.fileAccess", {
    cardId,
  });
  const files = payload?.files;
  if (!files || typeof files !== "object") {
    return {};
  }
  const entries: Record<string, WorkboardArtifactFileAccess> = {};
  for (const [artifactId, value] of Object.entries(files as Record<string, unknown>)) {
    const entry = readEntry(value);
    if (entry) {
      entries[artifactId] = entry;
    }
  }
  return entries;
}

export function artifactPathAccess(
  access: Record<string, WorkboardArtifactFileAccess>,
  artifactId: string,
): WorkboardArtifactFileAccess | undefined {
  return access[artifactId];
}

export function artifactHasPath(artifact: WorkboardArtifact): boolean {
  return Boolean(artifact.path?.trim());
}
