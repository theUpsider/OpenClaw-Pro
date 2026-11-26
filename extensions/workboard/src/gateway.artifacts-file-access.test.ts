import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { createWorkboardFileAccessStore, parseWorkboardFileRoots } from "./file-access.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

function captureFileAccess(store: WorkboardStore, pluginConfig: unknown, client?: unknown) {
  let handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1] | undefined;
  const api = createTestPluginApi({
    registerGatewayMethod: (name, registered) => {
      if (name === "workboard.artifacts.fileAccess") {
        handler = registered;
      }
    },
  });
  registerWorkboardGatewayMethods({
    api,
    store,
    fileAccess: {
      store: createWorkboardFileAccessStore(),
      roots: () => parseWorkboardFileRoots(pluginConfig),
    },
  });
  if (!handler) {
    throw new Error("expected the file access method to register");
  }
  return async (params: Record<string, unknown>) => {
    const respond = vi.fn();
    await handler!({ params, respond, client } as never);
    return respond;
  };
}

/** The PDP card shape: a path outside every agent workspace, plus a web artifact. */
const PDP_PATH =
  "/workspace/shared/reports-export/report-export/example-anforderungsformat-v1.0.md";

describe("workboard.artifacts.fileAccess", () => {
  it("answers with server-approved access keyed by artifact id, resolved from the card", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workboard-rpc-"));
    try {
      const reportDir = path.join(dir, "reports-export");
      await fs.mkdir(reportDir, { recursive: true });
      await fs.writeFile(path.join(reportDir, "report.md"), "# Report\n");
      const { store } = createWorkboardSqliteTestHarness();
      const card = await store.create({
        title: "PDP",
        metadata: {
          artifacts: [
            {
              id: "pdp",
              createdAt: 1,
              label: "Anforderungsformat",
              path: path.join(reportDir, "report.md"),
            },
            { id: "web", createdAt: 1, url: "https://example.test/report" },
            { id: "outside", createdAt: 1, path: "/etc/passwd" },
          ],
        },
      });
      const request = captureFileAccess(
        store,
        { fileRoots: [{ root: reportDir, baseUrl: "https://files.example.test/reports" }] },
        { connId: "conn-1" },
      );
      const respond = await request({ cardId: card.id });
      expect(respond).toHaveBeenCalledWith(true, {
        files: {
          pdp: {
            open: { url: "https://files.example.test/reports/report.md" },
            download: {
              url: expect.stringMatching(
                /^\/plugins\/workboard\/files\/conn-1\/[A-Za-z0-9_-]{43}$/u,
              ),
              expiresAt: expect.any(String),
            },
          },
        },
      });
      // A request cannot name a path — only the card id is accepted.
      const rejected = await request({ cardId: card.id, path: "/etc/passwd" });
      expect(rejected.mock.calls[0]?.[0]).toBe(true);
      // A missing card is an error, not an empty approval.
      const missing = await request({ cardId: "missing-card" });
      expect(missing.mock.calls[0]?.[0]).toBe(false);
      expect(missing.mock.calls[0]?.[2]?.code).toBe("workboard_error");
      // Without a cardId the request is refused before any lookup.
      const noCard = await request({});
      expect(noCard.mock.calls[0]?.[0]).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("approves nothing when no roots are configured, and never reads the PDP path", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const card = await store.create({
      title: "PDP",
      metadata: { artifacts: [{ id: "pdp", createdAt: 1, path: PDP_PATH }] },
    });
    const request = captureFileAccess(store, {}, { connId: "conn-1" });
    const respond = await request({ cardId: card.id });
    expect(respond).toHaveBeenCalledWith(true, { files: {} });
    expect(respond.mock.calls[0]?.[1]).toEqual({ files: {} });
  });

  it("keeps a document artifact download-only even under an approved root", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workboard-rpc-doc-"));
    try {
      await fs.writeFile(path.join(dir, "page.html"), "<script>alert(1)</script>");
      const { store } = createWorkboardSqliteTestHarness();
      const card = await store.create({
        title: "Page",
        metadata: {
          artifacts: [
            { id: "html", createdAt: 1, path: path.join(dir, "page.html"), mimeType: "text/html" },
          ],
        },
      });
      const request = captureFileAccess(
        store,
        { fileRoots: [{ root: dir, baseUrl: "https://files.example.test/x" }] },
        { connId: "conn-1" },
      );
      const respond = await request({ cardId: card.id });
      expect(respond).toHaveBeenCalledWith(true, {
        files: { html: { download: expect.objectContaining({ url: expect.any(String) }) } },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
