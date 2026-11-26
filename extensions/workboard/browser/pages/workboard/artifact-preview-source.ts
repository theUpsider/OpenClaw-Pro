import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ArtifactPreviewAttempt =
  | { method: "agents.workspace.get"; params: { agentId: string; path: string } }
  | {
      method: "sessions.files.get";
      params: { sessionKey: string; path: string; agentId?: string };
    };

export type ArtifactPreviewPlan =
  | { kind: "attempts"; attempts: ArtifactPreviewAttempt[] }
  | { kind: "unsupported" };

export type ArtifactPreviewResult =
  | { state: "ready"; markdown: string }
  | { state: "unsupported" }
  | { state: "failed"; error: unknown };

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

export function isMarkdownArtifact(path: string, mimeType?: string): boolean {
  return (
    MARKDOWN_EXTENSION.test(path) ||
    (mimeType?.trim().toLowerCase().startsWith("text/markdown") ?? false)
  );
}

function hasParentSegment(path: string): boolean {
  return path.split("/").includes("..");
}

/**
 * Decides which concrete reads may serve an artifact path. `confirmedRoot` must come from the
 * Gateway for `agentId` (agents.files.list); a directory name is never evidence of ownership.
 */
export function resolveArtifactPreviewPlan(input: {
  path: string;
  sessionKey?: string | null;
  agentId?: string | null;
  confirmedRoot?: string | null;
}): ArtifactPreviewPlan {
  const path = input.path.trim();
  const sessionKey = input.sessionKey?.trim() || undefined;
  const agentId = input.agentId?.trim() || undefined;
  const unsupported: ArtifactPreviewPlan = { kind: "unsupported" };
  if (!path || path.includes("\\") || hasParentSegment(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return unsupported;
  }
  if (path.startsWith("/")) {
    const root = input.confirmedRoot?.replace(/\/+$/, "");
    if (!agentId || !root || !path.startsWith(`${root}/`)) {
      return unsupported;
    }
    const relative = path.slice(root.length + 1);
    return relative
      ? {
          kind: "attempts",
          attempts: [{ method: "agents.workspace.get", params: { agentId, path: relative } }],
        }
      : unsupported;
  }
  if (path.startsWith("~")) {
    return unsupported;
  }
  const relative = path.replace(/^(\.\/)+/, "");
  const attempts: ArtifactPreviewAttempt[] = [];
  if (agentId) {
    attempts.push({ method: "agents.workspace.get", params: { agentId, path: relative } });
  }
  if (sessionKey) {
    attempts.push({
      method: "sessions.files.get",
      params: { sessionKey, path: relative, ...(agentId ? { agentId } : {}) },
    });
  }
  return attempts.length ? { kind: "attempts", attempts } : unsupported;
}

const REFUSAL_CODES = new Set([
  "session_file_not_found",
  "session_file_too_large",
  "session_file_unsupported",
  "workspace_file_not_found",
  "workspace_file_too_large",
  "workspace_file_unsupported",
  "outside_session_boundary",
]);

function errorCodes(error: unknown): string[] {
  if (!error || typeof error !== "object") {
    return [];
  }
  const record = error as { code?: unknown; details?: unknown };
  const details =
    record.details && typeof record.details === "object"
      ? (record.details as { code?: unknown; reason?: unknown })
      : {};
  return [record.code, details.code, details.reason].filter(
    (value): value is string => typeof value === "string",
  );
}

/** A refusal says the Gateway understood the request and declined it; it is not a transport fault. */
export function isPreviewRefusal(error: unknown): boolean {
  return errorCodes(error).some((code) => REFUSAL_CODES.has(code));
}

type FilePayload = {
  file?: {
    content?: unknown;
    previewKind?: unknown;
    contentEncoding?: unknown;
    encoding?: unknown;
    missing?: unknown;
  };
};

function readMarkdown(payload: FilePayload | undefined): string | undefined {
  const file = payload?.file;
  if (!file || file.missing === true || typeof file.content !== "string") {
    return undefined;
  }
  if (file.previewKind !== undefined && file.previewKind !== "text") {
    return undefined;
  }
  const encoding = file.contentEncoding ?? file.encoding;
  if (encoding !== undefined && encoding !== "utf8") {
    return undefined;
  }
  return file.content;
}

/**
 * Reads one markdown artifact. Roots are fetched once per call, only for absolute paths.
 * A later attempt runs only after a transport fault; a refusal ends the chain.
 */
export async function loadArtifactPreview(input: {
  client: Pick<GatewayBrowserClient, "request">;
  path: string;
  sessionKey?: string | null;
  agentId?: string | null;
  isCurrent?: () => boolean;
}): Promise<ArtifactPreviewResult> {
  const { client, path } = input;
  const agentId = input.agentId?.trim() || undefined;
  let confirmedRoot: string | undefined;
  if (path.trim().startsWith("/") && agentId) {
    try {
      const listing = await client.request<{ workspace?: unknown }>("agents.files.list", {
        agentId,
      });
      confirmedRoot = typeof listing?.workspace === "string" ? listing.workspace : undefined;
    } catch (error) {
      return isPreviewRefusal(error) ? { state: "unsupported" } : { state: "failed", error };
    }
  }
  const plan = resolveArtifactPreviewPlan({ ...input, confirmedRoot });
  if (plan.kind === "unsupported") {
    return { state: "unsupported" };
  }
  let failure: unknown;
  for (const attempt of plan.attempts) {
    if (input.isCurrent && !input.isCurrent()) {
      return { state: "failed", error: new Error("cancelled") };
    }
    try {
      const markdown = readMarkdown(
        await client.request<FilePayload>(attempt.method, attempt.params),
      );
      return markdown === undefined ? { state: "unsupported" } : { state: "ready", markdown };
    } catch (error) {
      if (isPreviewRefusal(error)) {
        return { state: "unsupported" };
      }
      failure = error;
    }
  }
  return { state: "failed", error: failure };
}
