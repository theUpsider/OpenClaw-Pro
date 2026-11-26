import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkboardArtifact } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Card artifacts may name a host path (for example a report a worker wrote outside every
 * agent workspace). This module decides what a browser may do with such a path and serves
 * the bytes; the card's stored path never becomes a request parameter.
 *
 * The rules, in order:
 *  - Only operator-configured roots are eligible (`plugins.entries.workboard.config.fileRoots`).
 *    Roots are absolute, canonical host paths; duplicates and overlaps are dropped.
 *  - Containment is decided by path components, never by string prefix: `/exports-other/x`
 *    is not inside `/exports`, and a root is never a file.
 *  - A path is read as a host path and nothing else: URL schemes, network-path forms,
 *    backslashes, control characters and `..` segments are refused, and a refused path is
 *    never reinterpreted as a URL.
 *  - `text/html`, `application/xhtml+xml` and `image/svg+xml` never get an Open link; they
 *    may only be downloaded, and the download is forced to `application/octet-stream` with
 *    `Content-Disposition: attachment` so no document ever runs on the Gateway origin.
 *  - Downloads are served by this plugin's own HTTP route. The browser presents an opaque
 *    ticket minted for one already-resolved resource; the ticket is bound to the bytes
 *    read at mint time, so the serve step performs no filesystem access at all.
 */

/** Plugin HTTP route prefix; plugin routes match the raw absolute pathname of the request. */
export const WORKBOARD_FILE_ACCESS_ROUTE_PATH = "/plugins/workboard/files";

const TICKET_TTL_MS = 5 * 60_000;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_GRANTS_PER_CONNECTION = 64;
/** Pinned bytes per connection; the oldest grants are evicted first. */
const MAX_PINNED_BYTES_PER_CONNECTION = 128 * 1024 * 1024;
/** Pinned bytes per file; larger files are refused rather than read into memory. */
const MAX_PINNED_BYTES_PER_FILE = 32 * 1024 * 1024;

const CONTROL_CHARACTER_MAX = 0x1f;
const CONTROL_CHARACTER_DELETE = 0x7f;
const URL_SCHEME = /^[a-zA-Z][A-Za-z0-9+.-]*:/;
/** Document types that must never be granted an Open link, as attachments or as path artifacts. */
const ACTIVE_DOCUMENT_MIME_ESSENCES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
]);
const ACTIVE_DOCUMENT_EXTENSION = /\.(?:html?|xhtml|svg)$/i;

export type WorkboardFileBaseUrl = {
  /** Scheme + host + port exactly as configured, without userinfo/query/fragment. */
  origin: string;
  /** Path prefix without a trailing slash; empty when the base URL has no path. */
  pathPrefix: string;
};

export type WorkboardFileRoot = {
  /** Canonical absolute host path as the operator wrote it, without a trailing slash. */
  root: string;
  segments: string[];
  /** Present ⇒ rows under this root may offer Open through the operator's file server. */
  baseUrl?: WorkboardFileBaseUrl;
};

/** The declared MIME *essence* (type/subtype, lowercased) without parameters. */
function mimeEssence(mimeType: string | undefined): string {
  return (mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/** Control characters make a path ambiguous in a URL and in a header; refuse them up front. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= CONTROL_CHARACTER_MAX || code === CONTROL_CHARACTER_DELETE) {
      return true;
    }
  }
  return false;
}

/** Absolute host-path segments, or undefined when the string may not be treated as one. */
function hostPathSegments(value: string): string[] | undefined {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return undefined;
  }
  const segments = value.replace(/\/+$/, "").split("/").slice(1);
  return segments.length > 0 &&
    segments.every((segment) => segment && segment !== "." && segment !== "..")
    ? segments
    : undefined;
}

function isStrictDescendant(segments: readonly string[], rootSegments: readonly string[]): boolean {
  // Component containment: `/exports-other/x` must not match `/exports`, and the root
  // itself is not a file.
  return (
    segments.length > rootSegments.length &&
    rootSegments.every((segment, index) => segments[index] === segment)
  );
}

function parseBaseUrl(value: unknown): WorkboardFileBaseUrl | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  // Exact scheme+host+port+path-prefix validation; credentials, query and fragment are
  // refused rather than normalized away.
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  return { origin: url.origin, pathPrefix: url.pathname.replace(/\/+$/, "") };
}

function openUrlFor(baseUrl: WorkboardFileBaseUrl, relativeSegments: readonly string[]): string {
  return `${baseUrl.origin}${baseUrl.pathPrefix}/${relativeSegments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/**
 * Reads the operator's root map. Invalid entries are dropped individually: an unusable
 * base URL means "download only" for that root, and a duplicate or overlapping root is
 * refused so one configured directory cannot shadow another decision.
 */
export function parseWorkboardFileRoots(pluginConfig: unknown): WorkboardFileRoot[] {
  if (!isRecord(pluginConfig) || !Array.isArray(pluginConfig.fileRoots)) {
    return [];
  }
  const roots: WorkboardFileRoot[] = [];
  for (const entry of pluginConfig.fileRoots) {
    if (!isRecord(entry) || typeof entry.root !== "string") {
      continue;
    }
    const root = entry.root.trim().replace(/\/+$/, "");
    const segments = hostPathSegments(root);
    if (!segments || URL_SCHEME.test(entry.root.trim())) {
      continue;
    }
    if (
      roots.some(
        (accepted) =>
          isStrictDescendant(segments, accepted.segments) ||
          isStrictDescendant(accepted.segments, segments) ||
          accepted.root === root,
      )
    ) {
      continue;
    }
    const baseUrl = parseBaseUrl(entry.baseUrl);
    roots.push({ root, segments, ...(baseUrl ? { baseUrl } : {}) });
  }
  return roots;
}

export type WorkboardArtifactPathResolution = {
  root: WorkboardFileRoot;
  /** Canonical host path rebuilt from its validated segments. */
  hostPath: string;
  fileName: string;
  /** Present only when this row may open the file outside the app. */
  openUrl?: string;
};

/**
 * Resolves one artifact path against the configured roots. Pure: no filesystem access —
 * the read happens at mint time, after this decision.
 */
export function resolveWorkboardArtifactPath(input: {
  path: string;
  mimeType?: string;
  roots: readonly WorkboardFileRoot[];
}): WorkboardArtifactPathResolution | undefined {
  const raw = input.path.trim();
  if (!raw || URL_SCHEME.test(raw)) {
    return undefined;
  }
  const segments = hostPathSegments(raw);
  if (!segments) {
    return undefined;
  }
  const root = input.roots.find((candidate) => isStrictDescendant(segments, candidate.segments));
  if (!root) {
    return undefined;
  }
  const fileName = segments[segments.length - 1]!;
  const refusesOpen =
    ACTIVE_DOCUMENT_MIME_ESSENCES.has(mimeEssence(input.mimeType)) ||
    ACTIVE_DOCUMENT_EXTENSION.test(fileName);
  return {
    root,
    hostPath: `/${segments.join("/")}`,
    fileName,
    ...(root.baseUrl && !refusesOpen
      ? { openUrl: openUrlFor(root.baseUrl, segments.slice(root.segments.length)) }
      : {}),
  };
}

/**
 * Reads one resolved path for pinning. The path is contained again against the root's
 * canonical form, so a symlink inside the root cannot escape it; the bytes returned are
 * the bytes a ticket will serve.
 */
export async function readWorkboardFileWithinRoot(input: {
  root: WorkboardFileRoot;
  hostPath: string;
}): Promise<Uint8Array | undefined> {
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(input.root.root).catch(() => undefined),
    fs.realpath(input.hostPath).catch(() => undefined),
  ]);
  if (!realRoot || !realTarget) {
    return undefined;
  }
  const rootSegments = hostPathSegments(realRoot);
  const targetSegments = hostPathSegments(realTarget);
  if (!rootSegments || !targetSegments || !isStrictDescendant(targetSegments, rootSegments)) {
    return undefined;
  }
  const stats = await fs.stat(realTarget).catch(() => undefined);
  if (!stats?.isFile() || stats.size > MAX_PINNED_BYTES_PER_FILE) {
    return undefined;
  }
  const bytes = await fs.readFile(realTarget).catch(() => undefined);
  return bytes && bytes.byteLength <= MAX_PINNED_BYTES_PER_FILE ? bytes : undefined;
}

export type WorkboardFileGrant = {
  hostPath: string;
  fileName: string;
  /** Digest of the pinned bytes; the grant identity for this one resolved resource. */
  digest: string;
  bytes: Uint8Array;
  expiresAt: number;
};

export type WorkboardFileMint = { url: string; expiresAt: string };

export type WorkboardFileAccessStore = {
  /** Pins one resolved resource and returns its opaque, short-TTL URL. */
  mint(input: {
    connId: string;
    connectionSignal?: AbortSignal;
    hostPath: string;
    fileName: string;
    bytes: Uint8Array;
  }): WorkboardFileMint | undefined;
  /** Bounded reuse inside the TTL: HEAD and the browser's own retries must not consume it. */
  read(connId: string, ticket: string): WorkboardFileGrant | undefined;
  /** Drops every grant, for example when the owning plugin instance stops. */
  clear(): void;
  /** Outstanding grant count for one connection; test seam for caps and connection close. */
  size(connId: string): number;
};

type ConnectionGrants = {
  grants: Map<string, WorkboardFileGrant>;
  bytes: number;
  watching: boolean;
};

export function createWorkboardFileAccessStore(
  options: { now?: () => number } = {},
): WorkboardFileAccessStore {
  const now = options.now ?? Date.now;
  const connections = new Map<string, ConnectionGrants>();

  const pruneExpired = (entry: ConnectionGrants) => {
    const current = now();
    for (const [ticket, grant] of entry.grants) {
      if (grant.expiresAt <= current) {
        entry.grants.delete(ticket);
        entry.bytes -= grant.bytes.byteLength;
      }
    }
  };

  return {
    mint(input) {
      if (input.connectionSignal?.aborted) {
        return undefined;
      }
      let entry = connections.get(input.connId);
      if (!entry) {
        entry = { grants: new Map(), bytes: 0, watching: false };
        connections.set(input.connId, entry);
        const owned = entry;
        // A ticket neither survives its connection nor needs an authority recheck: the
        // capability is scoped by construction and expires on its own.
        if (input.connectionSignal) {
          owned.watching = true;
          input.connectionSignal.addEventListener("abort", () => connections.delete(input.connId), {
            once: true,
          });
        }
      } else if (input.connectionSignal && !entry.watching) {
        entry.watching = true;
        input.connectionSignal.addEventListener("abort", () => connections.delete(input.connId), {
          once: true,
        });
      }
      pruneExpired(entry);
      const ticket = randomBytes(32).toString("base64url");
      const expiresAt = now() + TICKET_TTL_MS;
      const grant: WorkboardFileGrant = {
        hostPath: input.hostPath,
        fileName: input.fileName,
        digest: createHash("sha256").update(input.bytes).digest("hex"),
        bytes: input.bytes,
        expiresAt,
      };
      entry.grants.set(ticket, grant);
      entry.bytes += grant.bytes.byteLength;
      while (
        entry.grants.size > MAX_GRANTS_PER_CONNECTION ||
        entry.bytes > MAX_PINNED_BYTES_PER_CONNECTION
      ) {
        const oldest = entry.grants.keys().next();
        if (oldest.done) {
          break;
        }
        const victim = entry.grants.get(oldest.value)!;
        entry.grants.delete(oldest.value);
        entry.bytes -= victim.bytes.byteLength;
      }
      return {
        url: `${WORKBOARD_FILE_ACCESS_ROUTE_PATH}/${encodeURIComponent(input.connId)}/${ticket}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
    read(connId, ticket) {
      const entry = connections.get(connId);
      if (!entry) {
        return undefined;
      }
      pruneExpired(entry);
      return entry.grants.get(ticket);
    },
    clear() {
      connections.clear();
    },
    size(connId) {
      const entry = connections.get(connId);
      if (entry) {
        pruneExpired(entry);
      }
      return entry?.grants.size ?? 0;
    },
  };
}

/** Basename only, control characters first, RFC 6266 `filename*` plus an ASCII fallback. */
export function buildAttachmentDisposition(fileName: string): string {
  const name = Array.from(fileName)
    .slice(0, 200)
    .map((char) => (hasControlCharacter(char) ? "_" : char))
    .join("");
  const fallback = name.replace(/[^\x20-\x7e]|[%"\\]/g, "_").trim() || "download";
  const extended = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

export type WorkboardArtifactFileAccessEntry = {
  open?: { url: string };
  download?: WorkboardFileMint;
};

/**
 * Server-approved access for one card's path artifacts, keyed by artifact id. The browser
 * never sees a path-derived URL it built itself: `open` exists only for a root with a base
 * URL and a non-document type, and `download` only once the bytes are pinned.
 */
export async function authorizeWorkboardFileAccess(params: {
  store: WorkboardFileAccessStore;
  artifacts: readonly WorkboardArtifact[];
  roots: readonly WorkboardFileRoot[];
  connection?: { connId?: string; connectionSignal?: AbortSignal } | null;
}): Promise<Record<string, WorkboardArtifactFileAccessEntry>> {
  const files: Record<string, WorkboardArtifactFileAccessEntry> = {};
  for (const artifact of params.artifacts) {
    const artifactPath = artifact.path?.trim();
    if (!artifactPath) {
      continue;
    }
    const resolved = resolveWorkboardArtifactPath({
      path: artifactPath,
      mimeType: artifact.mimeType,
      roots: params.roots,
    });
    if (!resolved) {
      continue;
    }
    const entry: WorkboardArtifactFileAccessEntry = {};
    if (resolved.openUrl) {
      entry.open = { url: resolved.openUrl };
    }
    const connId = params.connection?.connId;
    if (connId) {
      const bytes = await readWorkboardFileWithinRoot({
        root: resolved.root,
        hostPath: resolved.hostPath,
      });
      if (bytes) {
        const mint = params.store.mint({
          connId,
          connectionSignal: params.connection?.connectionSignal,
          hostPath: resolved.hostPath,
          fileName: resolved.fileName,
          bytes,
        });
        if (mint) {
          entry.download = mint;
        }
      }
    }
    if (entry.open || entry.download) {
      files[artifact.id] = entry;
    }
  }
  return files;
}

function respondNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

/**
 * The plugin's own route handler for `WORKBOARD_FILE_ACCESS_ROUTE_PATH`. Authentication is
 * the ticket itself; the handler never reads the filesystem, never logs the ticket, and
 * always answers with the fixed no-document header set. `auth: "plugin"` owns this route
 * entirely, so the only accepted credentials are the opaque ticket path segments.
 */
export function createWorkboardFileAccessHandler(store: WorkboardFileAccessStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith(`${WORKBOARD_FILE_ACCESS_ROUTE_PATH}/`)) {
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }
    let connId: string;
    let ticket: string;
    try {
      const segments = pathname
        .slice(WORKBOARD_FILE_ACCESS_ROUTE_PATH.length + 1)
        .split("/")
        .map((segment) => decodeURIComponent(segment));
      if (segments.length !== 2) {
        respondNotFound(res);
        return true;
      }
      [connId, ticket] = segments as [string, string];
    } catch {
      respondNotFound(res);
      return true;
    }
    const grant = connId && TICKET_PATTERN.test(ticket) ? store.read(connId, ticket) : undefined;
    if (!grant) {
      respondNotFound(res);
      return true;
    }
    // Never a document on the Gateway origin: octet-stream, attachment, no sniffing,
    // no referrer, no store, nothing runnable.
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", buildAttachmentDisposition(grant.fileName));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Length", String(grant.bytes.byteLength));
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(grant.bytes);
    return true;
  };
}
