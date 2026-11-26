import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeWorkboardFileAccess,
  buildAttachmentDisposition,
  createWorkboardFileAccessHandler,
  createWorkboardFileAccessStore,
  parseWorkboardFileRoots,
  readWorkboardFileWithinRoot,
  resolveWorkboardArtifactPath,
  WORKBOARD_FILE_ACCESS_ROUTE_PATH,
} from "./file-access.js";

const roots = (...entries: Array<{ root: string; baseUrl?: string }>) =>
  parseWorkboardFileRoots({ fileRoots: entries });

describe("workboard file root configuration", () => {
  it("keeps only absolute roots and never treats the root itself as a file", () => {
    const parsed = roots({ root: "/exports/" }, { root: "relative/path" }, { root: "~/" });
    expect(parsed.map((entry) => entry.root)).toEqual(["/exports"]);
  });

  it("refuses duplicates and overlapping roots", () => {
    const parsed = roots(
      { root: "/exports" },
      { root: "/exports" },
      { root: "/exports/nested" },
      { root: "/other" },
    );
    expect(parsed.map((entry) => entry.root)).toEqual(["/exports", "/other"]);
  });

  it("accepts only a strict http(s) base URL and keeps baseUrl optional", () => {
    const parsed = roots(
      { root: "/exports", baseUrl: "https://files.example.test/reports/" },
      { root: "/plain" },
      { root: "/bad-scheme", baseUrl: "file:///etc" },
      { root: "/bad-userinfo", baseUrl: "https://user:pass@files.example.test/" },
      { root: "/bad-query", baseUrl: "https://files.example.test/reports?x=1" },
      { root: "/bad-hash", baseUrl: "https://files.example.test/reports#x" },
      { root: "/bad-url", baseUrl: "not a url" },
    );
    expect(parsed.map((entry) => entry.root)).toEqual([
      "/exports",
      "/plain",
      "/bad-scheme",
      "/bad-userinfo",
      "/bad-query",
      "/bad-hash",
      "/bad-url",
    ]);
    expect(parsed[0]?.baseUrl).toEqual({
      origin: "https://files.example.test",
      pathPrefix: "/reports",
    });
    // An unusable base URL means download-only, never a partially applied URL.
    for (const entry of parsed.slice(1)) {
      expect(entry.baseUrl).toBeUndefined();
    }
  });
});

describe("workboard artifact path resolution", () => {
  const configured = roots({ root: "/exports", baseUrl: "https://files.example.test/reports" });

  it("matches by path components, never by string prefix", () => {
    expect(
      resolveWorkboardArtifactPath({ path: "/exports/report.md", roots: configured }),
    ).toMatchObject({ hostPath: "/exports/report.md", fileName: "report.md" });
    // `/exports-other/x` is a sibling directory, not a child of `/exports`.
    expect(
      resolveWorkboardArtifactPath({ path: "/exports-other/report.md", roots: configured }),
    ).toBeUndefined();
    // The root itself is a directory, not a file.
    expect(resolveWorkboardArtifactPath({ path: "/exports", roots: configured })).toBeUndefined();
    expect(resolveWorkboardArtifactPath({ path: "/exports/", roots: configured })).toBeUndefined();
  });

  it("refuses traversal, backslashes, control characters and URL-shaped input", () => {
    for (const value of [
      "/exports/../etc/passwd",
      "/exports/a/../../etc/passwd",
      "/exports\\windows\\file.txt",
      "/exports/re\u0000port.md",
      "/exports/re\nport.md",
      "file:///exports/report.md",
      "https://example.test/exports/report.md",
      "//exports/report.md",
      "exports/report.md",
      "~/exports/report.md",
    ]) {
      expect(resolveWorkboardArtifactPath({ path: value, roots: configured })).toBeUndefined();
    }
  });

  it("offers Open only through a configured base URL and never for a document type", () => {
    const open = resolveWorkboardArtifactPath({
      path: "/exports/reports/weekly report.md",
      roots: configured,
    });
    expect(open?.openUrl).toBe("https://files.example.test/reports/reports/weekly%20report.md");
    // text/html, application/xhtml+xml and image/svg+xml are download-only, by type…
    for (const mimeType of ["text/html", "application/xhtml+xml", "image/svg+xml"]) {
      expect(
        resolveWorkboardArtifactPath({ path: "/exports/page.md", mimeType, roots: configured })
          ?.openUrl,
      ).toBeUndefined();
    }
    // …and by extension when the declaration says nothing.
    for (const value of ["/exports/page.html", "/exports/page.xhtml", "/exports/logo.svg"]) {
      expect(
        resolveWorkboardArtifactPath({ path: value, roots: configured })?.openUrl,
      ).toBeUndefined();
    }
    // Without a base URL a root is download-only.
    const downloadOnly = roots({ root: "/exports" });
    expect(
      resolveWorkboardArtifactPath({ path: "/exports/report.md", roots: downloadOnly })?.openUrl,
    ).toBeUndefined();
    // An unmapped path has no resolution at all.
    expect(
      resolveWorkboardArtifactPath({ path: "/srv/data/elsewhere/x.md", roots: configured }),
    ).toBeUndefined();
  });
});

describe("workboard file grant store", () => {
  it("binds a ticket to the pinned bytes and reuses it inside the TTL", () => {
    let now = 1_000;
    const store = createWorkboardFileAccessStore({ now: () => now });
    const bytes = Uint8Array.from([1, 2, 3]);
    const minted = store.mint({
      connId: "conn-1",
      hostPath: "/exports/a.bin",
      fileName: "a.bin",
      bytes,
    });
    expect(minted?.url).toMatch(
      new RegExp(`^${WORKBOARD_FILE_ACCESS_ROUTE_PATH}/conn-1/[A-Za-z0-9_-]{43}$`, "u"),
    );
    const ticket = minted!.url.split("/").pop()!;
    const grant = store.read("conn-1", ticket);
    expect(grant?.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(grant?.bytes).toEqual(bytes);
    // Bounded reuse: the same ticket still answers inside its TTL.
    expect(store.read("conn-1", ticket)).toBe(grant);
    // A ticket belongs to one connection.
    expect(store.read("conn-2", ticket)).toBeUndefined();
    now += 5 * 60_000;
    expect(store.read("conn-1", ticket)).toBeUndefined();
  });

  it("drops outstanding grants when the owning connection closes", () => {
    const store = createWorkboardFileAccessStore();
    const controller = new AbortController();
    const minted = store.mint({
      connId: "conn-1",
      connectionSignal: controller.signal,
      hostPath: "/exports/a.bin",
      fileName: "a.bin",
      bytes: Uint8Array.from([1]),
    });
    const ticket = minted!.url.split("/").pop()!;
    expect(store.size("conn-1")).toBe(1);
    controller.abort();
    expect(store.size("conn-1")).toBe(0);
    expect(store.read("conn-1", ticket)).toBeUndefined();
  });

  it("never mints for an already-aborted connection", () => {
    const store = createWorkboardFileAccessStore();
    const controller = new AbortController();
    controller.abort();
    expect(
      store.mint({
        connId: "conn-1",
        connectionSignal: controller.signal,
        hostPath: "/exports/a.bin",
        fileName: "a.bin",
        bytes: Uint8Array.from([1]),
      }),
    ).toBeUndefined();
  });

  it("caps outstanding grants per connection", () => {
    const store = createWorkboardFileAccessStore();
    for (let index = 0; index < 70; index += 1) {
      store.mint({
        connId: "conn-1",
        hostPath: `/exports/f${index}.bin`,
        fileName: `f${index}.bin`,
        bytes: Uint8Array.from([index % 250]),
      });
    }
    expect(store.size("conn-1")).toBe(64);
  });
});

describe("workboard attachment disposition", () => {
  it("keeps the basename, strips control characters and carries both name forms", () => {
    expect(buildAttachmentDisposition("report.md")).toBe(
      "attachment; filename=\"report.md\"; filename*=UTF-8''report.md",
    );
    const withNewline = buildAttachmentDisposition("evil\r\nX-Injected: 1");
    expect(withNewline).not.toContain("\r");
    expect(withNewline).not.toContain("\n");
    expect(withNewline.startsWith('attachment; filename="evil__X-Injected: 1"')).toBe(true);
    // Non-ASCII names keep an ASCII fallback; the exact name travels in filename*.
    const umlaut = buildAttachmentDisposition("prüfung.md");
    expect(umlaut).toContain('filename="pr_fung.md"');
    expect(umlaut).toContain("filename*=UTF-8''pr%C3%BCfung.md");
  });
});

/** Loopback fixture: the handler runs behind a real HTTP server, never called directly. */
async function withServer(
  run: (fixture: {
    request: (options: {
      path: string;
      method?: string;
      headers?: Record<string, string>;
    }) => Promise<{ status: number; headers: Headers; body: Buffer }>;
    /** Ticket path for `exports/report.md`, minted from the bytes on disk. */
    ticketPath: string;
    store: ReturnType<typeof createWorkboardFileAccessStore>;
  }) => Promise<void>,
) {
  const rootsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workboard-files-"));
  const exportDir = path.join(rootsDir, "exports");
  const outsideDir = path.join(rootsDir, "exports-other");
  await fs.mkdir(exportDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.mkdir(path.join(rootsDir, "secret"), { recursive: true });
  await fs.writeFile(path.join(exportDir, "report.md"), "# Report\n");
  await fs.writeFile(path.join(exportDir, "page.html"), "<script>alert(1)</script>");
  await fs.writeFile(path.join(outsideDir, "sibling.md"), "sibling");
  await fs.writeFile(path.join(rootsDir, "secret", "key.txt"), "secret");
  // A symlink that points outside the configured root must not be followed.
  await fs.symlink(path.join(rootsDir, "secret", "key.txt"), path.join(exportDir, "escape.txt"));
  const store = createWorkboardFileAccessStore();
  const handler = createWorkboardFileAccessHandler(store);
  let server: Server | undefined;
  try {
    server = createServer((req, res) => {
      // The handler is async; the server must keep streaming its own lifetime.
      void (async () => {
        const handled = await handler(req, res);
        if (!handled) {
          res.statusCode = 404;
          res.end("unhandled");
        }
      })();
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a loopback port");
    }
    // Mint through the same path the RPC uses, so the ticket covers real bytes.
    const resolution = resolveWorkboardArtifactPath({
      path: path.join(exportDir, "report.md"),
      roots: roots({ root: exportDir, baseUrl: "https://files.example.test/exports" }),
    });
    if (!resolution) {
      throw new Error("expected the fixture file to resolve");
    }
    const bytes = await readWorkboardFileWithinRoot({
      root: resolution.root,
      hostPath: resolution.hostPath,
    });
    const minted = bytes
      ? store.mint({
          connId: "conn-1",
          hostPath: resolution.hostPath,
          fileName: resolution.fileName,
          bytes,
        })
      : undefined;
    if (!minted) {
      throw new Error("expected the fixture ticket to mint");
    }
    await run({
      store,
      ticketPath: new URL(minted.url, "http://127.0.0.1").pathname,
      request: async (options) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${options.path}`, {
          method: options.method ?? "GET",
          headers: options.headers,
        });
        const body = Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers: response.headers, body };
      },
    });
  } finally {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    await fs.rm(rootsDir, { recursive: true, force: true });
  }
}

describe("workboard file access route", () => {
  it("serves GET and HEAD with the fixed no-document header set", async () => {
    await withServer(async ({ request, ticketPath }) => {
      const get = await request({ path: ticketPath });
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe("application/octet-stream");
      expect(get.headers.get("content-disposition")).toBe(
        "attachment; filename=\"report.md\"; filename*=UTF-8''report.md",
      );
      expect(get.headers.get("x-content-type-options")).toBe("nosniff");
      expect(get.headers.get("referrer-policy")).toBe("no-referrer");
      expect(get.headers.get("cache-control")).toBe("no-store");
      expect(get.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(get.body.toString("utf8")).toBe("# Report\n");
      const head = await request({ path: ticketPath, method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.body).toHaveLength(0);
      expect(head.headers.get("content-length")).toBe("9");
      expect(head.headers.get("content-disposition")).toBe(
        "attachment; filename=\"report.md\"; filename*=UTF-8''report.md",
      );
    });
  });

  it("answers 404 for an unknown, malformed or expired ticket and 405 for POST", async () => {
    await withServer(async ({ request, ticketPath, store }) => {
      const ticket = ticketPath.split("/").pop()!;
      expect((await request({ path: `/plugins/workboard/files/conn-1/unknown` })).status).toBe(404);
      expect((await request({ path: "/plugins/workboard/files/conn-1" })).status).toBe(404);
      expect((await request({ path: "/plugins/workboard/files/conn-1/a/b" })).status).toBe(404);
      expect((await request({ path: "/plugins/workboard/files/conn-1/%2e%2e%2fetc" })).status).toBe(
        404,
      );
      // The ticket is valid for another connection only after its own mint drops it.
      expect((await request({ path: `/plugins/workboard/files/conn-2/${ticket}` })).status).toBe(
        404,
      );
      expect((await request({ path: ticketPath, method: "POST" })).status).toBe(405);
      // Nothing above may have consumed the ticket: the grant is still live.
      expect(store.size("conn-1")).toBe(1);
      expect((await request({ path: ticketPath })).status).toBe(200);
    });
  });

  it("declines requests outside its own route prefix", async () => {
    await withServer(async ({ request }) => {
      expect((await request({ path: "/plugins/workboard/other" })).status).toBe(404);
      // Not our prefix at all: the fixture server reports "unhandled".
      const response = await request({ path: "/plugins/workboard/files" });
      expect(response.status).toBe(404);
    });
  });
});

describe("workboard artifact file access authorization", () => {
  it("keys the answer by artifact id and reads the path from the card, never the request", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workboard-authz-"));
    try {
      await fs.writeFile(path.join(dir, "one.md"), "one");
      const store = createWorkboardFileAccessStore();
      const configured = roots({ root: dir, baseUrl: "https://files.example.test/x" });
      const files = await authorizeWorkboardFileAccess({
        store,
        roots: configured,
        connection: { connId: "conn-1" },
        artifacts: [
          { id: "a1", createdAt: 1, path: path.join(dir, "one.md") },
          { id: "a2", createdAt: 1, path: "/etc/passwd" },
          { id: "a3", createdAt: 1, url: "https://example.test/remote" },
        ],
      });
      expect(Object.keys(files)).toEqual(["a1"]);
      expect(files.a1?.open?.url).toBe("https://files.example.test/x/one.md");
      expect(files.a1?.download?.url).toMatch(
        new RegExp(`^${WORKBOARD_FILE_ACCESS_ROUTE_PATH}/conn-1/[A-Za-z0-9_-]{43}$`, "u"),
      );
      // The refused artifacts are simply absent: no key, no dead action.
      expect(files.a2).toBeUndefined();
      expect(files.a3).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("never follows a symlink out of its root", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workboard-symlink-"));
    try {
      const rootDir = path.join(dir, "root");
      await fs.mkdir(rootDir);
      await fs.writeFile(path.join(dir, "secret.txt"), "secret");
      await fs.symlink(path.join(dir, "secret.txt"), path.join(rootDir, "escape.txt"));
      const store = createWorkboardFileAccessStore();
      const files = await authorizeWorkboardFileAccess({
        store,
        roots: roots({ root: rootDir }),
        connection: { connId: "conn-1" },
        artifacts: [{ id: "escape", createdAt: 1, path: path.join(rootDir, "escape.txt") }],
      });
      expect(files.escape).toBeUndefined();
      // The same guard refuses a root that is itself a symlink target outside the root.
      await fs.symlink(rootDir, path.join(dir, "root-link"));
      const viaLink = await authorizeWorkboardFileAccess({
        store,
        roots: roots({ root: path.join(dir, "root-link") }),
        connection: { connId: "conn-1" },
        artifacts: [
          { id: "real", createdAt: 1, path: path.join(rootDir, "escape.txt") },
          { id: "inside", createdAt: 1, path: path.join(rootDir, "secret-2.txt") },
        ],
      });
      expect(viaLink.real).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("approves nothing without a connection: the ticket is bound to the caller's connId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workboard-conn-"));
    try {
      await fs.writeFile(path.join(dir, "one.md"), "one");
      const files = await authorizeWorkboardFileAccess({
        store: createWorkboardFileAccessStore(),
        roots: roots({ root: dir, baseUrl: "https://files.example.test/x" }),
        connection: null,
        artifacts: [{ id: "a1", createdAt: 1, path: path.join(dir, "one.md") }],
      });
      // Without a connection the Open link may still be offered, but no ticket exists.
      expect(files.a1?.open?.url).toBe("https://files.example.test/x/one.md");
      expect(files.a1?.download).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses the root itself, an unreadable file and an oversized file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workboard-refuse-"));
    try {
      const big = path.join(dir, "big.bin");
      await fs.writeFile(big, Buffer.alloc(33 * 1024 * 1024, 1));
      const store = createWorkboardFileAccessStore();
      const files = await authorizeWorkboardFileAccess({
        store,
        roots: roots({ root: dir }),
        connection: { connId: "conn-1" },
        artifacts: [
          { id: "root", createdAt: 1, path: dir },
          { id: "missing", createdAt: 1, path: path.join(dir, "missing.bin") },
          { id: "big", createdAt: 1, path: big },
        ],
      });
      expect(files).toEqual({});
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
