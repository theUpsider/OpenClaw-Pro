import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardAttachment } from "@openclaw/workboard-contract";
import { render } from "@solidjs/web";
import { createComponent, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { CardArtifacts } from "./view-card-artifacts.tsx";

/** UTF-8 bytes for "héllo ✓\n# Title\n\nBody" — the é is two bytes, so atob() alone would break it. */
const UNICODE_MARKDOWN = "héllo ✓\n\n# Title\n\nBody";
const UNICODE_MARKDOWN_BYTES = new TextEncoder().encode(UNICODE_MARKDOWN);
const UNICODE_MARKDOWN_BASE64 = btoa(String.fromCharCode(...UNICODE_MARKDOWN_BYTES));

function attachment(overrides: Partial<WorkboardAttachment> = {}): WorkboardAttachment {
  return {
    id: "att-1",
    cardId: "card-1",
    createdAt: 1,
    fileName: "notes.md",
    byteSize: 2048,
    ...overrides,
  };
}

function cardWith(...attachments: WorkboardAttachment[]): WorkboardCard {
  return createWorkboardCard({
    agentId: "a",
    sessionKey: "agent:a:s1",
    metadata: { attachments },
  });
}

let dispose: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

function mount(
  handler: (method: string, params: unknown) => unknown,
  cardUnderTest: WorkboardCard,
) {
  const { host } = workboardTestHost();
  const request = vi.mocked(host.request);
  request.mockReset();
  request.mockImplementation((async (method: string, params?: unknown) =>
    handler(method, params)) as never);
  const container = document.createElement("div");
  document.body.append(container);
  dispose = render(
    () =>
      createComponent(CardArtifacts, {
        card: cardUnderTest,
        onNavigate: () => undefined,
        workboard: { client: host, canWrite: true, controlUi: host, scopeAgentId: "a" },
      }),
    container,
  );
  const settle = async () => {
    await afterWorkboardUpdate(() => undefined);
    await afterWorkboardUpdate(() => undefined);
  };
  const row = (label: string) =>
    expectDefined(
      [...container.querySelectorAll<HTMLElement>(".workboard-artifacts__row")].find((r) =>
        r.textContent?.includes(label),
      ),
      label,
    );
  const button = (label: string, text: string) =>
    [...row(label).querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
  const openButton = (label: string) =>
    row(label).querySelector<HTMLButtonElement>("button[aria-label^='Open ']");
  return { container, request, settle, row, button, openButton };
}

/** Captures what the anchor actually hands the browser, instead of trusting a summary. */
function captureDownload() {
  const created: Array<{ type: string; size: number; blob: Blob }> = [];
  const anchors: Array<{ download: string; href: string }> = [];
  const revoked: string[] = [];
  const realCreateObjectURL = URL.createObjectURL.bind(URL);
  const realRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const objectUrls: string[] = [];
  URL.createObjectURL = ((blob: Blob) => {
    created.push({ type: blob.type, size: blob.size, blob });
    const url = `blob:fixture/${created.length}`;
    objectUrls.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchors.push({ download: this.download, href: this.href });
  });
  return {
    created,
    anchors,
    objectUrls,
    revoked,
    restore() {
      click.mockRestore();
      URL.createObjectURL = realCreateObjectURL;
      URL.revokeObjectURL = realRevokeObjectURL;
    },
  };
}

it("offers Download on every attachment row and Open only for a type it renders", async () => {
  const view = mount(
    () => ({}),
    cardWith(
      attachment({ id: "a-md", fileName: "notes.md", mimeType: "text/markdown" }),
      attachment({ id: "a-html", fileName: "page.html", mimeType: "text/html" }),
      attachment({ id: "a-svg", fileName: "logo.svg", mimeType: "image/svg+xml" }),
      attachment({ id: "a-png", fileName: "shot.png", mimeType: "image/png" }),
      attachment({ id: "a-pdf", fileName: "doc.pdf", mimeType: "application/pdf" }),
    ),
  );
  await view.settle();
  for (const label of ["notes.md", "page.html", "logo.svg", "shot.png", "doc.pdf"]) {
    expect(view.row(label).querySelector<HTMLButtonElement>("button")?.textContent?.trim()).toBe(
      "Download",
    );
  }
  // The negative case: attacker-influenced types must not get an in-app Open.
  expect(view.openButton("notes.md")).not.toBeNull();
  expect(view.openButton("shot.png")).not.toBeNull();
  expect(view.openButton("page.html")).toBeNull();
  expect(view.openButton("logo.svg")).toBeNull();
  // A PDF is opened in its own tab from verified bytes, never in an in-app frame.
  expect(view.openButton("doc.pdf")).not.toBeNull();
});

it("matches the declared MIME essence exactly, not by prefix", async () => {
  // A lookalike prefix is not a supported type; parameters do not change the type.
  const view = mount(
    () => ({}),
    cardWith(
      attachment({ id: "a-md-lookalike", fileName: "note.md", mimeType: "text/markdown-extra" }),
      attachment({
        id: "a-plain-lookalike",
        fileName: "note.md",
        mimeType: "text/plain-extra",
      }),
      attachment({ id: "a-params", fileName: "shot.bin", mimeType: "image/png; charset=binary" }),
    ),
  );
  await view.settle();
  const rowByMime = (mime: string) =>
    expectDefined(
      [...view.container.querySelectorAll<HTMLElement>(".workboard-artifacts__row")].find((r) =>
        r.textContent?.includes(mime),
      ),
      mime,
    );
  expect(rowByMime("text/markdown-extra").querySelector("button[aria-label^='Open ']")).toBeNull();
  expect(rowByMime("text/plain-extra").querySelector("button[aria-label^='Open ']")).toBeNull();
  // The parameterized declaration is still that raster type.
  expect(
    rowByMime("image/png; charset=binary").querySelector("button[aria-label^='Open ']"),
  ).not.toBeNull();
});

it("does not let a markdown file name override a script-capable declared type", async () => {
  // A markdown *name* is not evidence: the declaration is what would make the bytes a document.
  const view = mount(
    () => ({}),
    cardWith(
      attachment({ id: "a-md-html", fileName: "html.md", mimeType: "text/html" }),
      attachment({ id: "a-md-svg", fileName: "svg.md", mimeType: "image/svg+xml" }),
      // No declaration at all still opens: the name is the only signal there is.
      attachment({ id: "a-md-bare", fileName: "bare.md" }),
      // A plain-text declaration is compatible with a markdown name.
      attachment({ id: "a-md-txt", fileName: "note.md", mimeType: "text/plain" }),
      // A declared markdown type opens even under a name that says nothing.
      attachment({ id: "a-md-mime", fileName: "README", mimeType: "text/markdown" }),
    ),
  );
  await view.settle();
  // The two contradictory declarations must not get an in-app Open.
  expect(view.openButton("html.md")).toBeNull();
  expect(view.openButton("svg.md")).toBeNull();
  // The compatible ones do, and still keep Download.
  for (const label of ["bare.md", "note.md", "README"]) {
    expect(view.openButton(label)).not.toBeNull();
    expect(
      [...view.row(label).querySelectorAll<HTMLButtonElement>("button")].some(
        (candidate) => candidate.textContent?.trim() === "Download",
      ),
    ).toBe(true);
  }
});

it("downloads once through the attachment-id RPC as inert octet-stream bytes", async () => {
  const captured = captureDownload();
  try {
    // The record declares HTML; the download must not become a document.
    const view = mount(
      (method, params) => {
        if (method === "workboard.cards.attachments.get") {
          expect(params).toEqual({ id: "a-html" });
          return {
            version: 1,
            attachment: attachment({ id: "a-html", fileName: "page.html", mimeType: "text/html" }),
            contentBase64: btoa("<script>alert(1)</script>"),
          };
        }
        return {};
      },
      cardWith(attachment({ id: "a-html", fileName: "page.html", mimeType: "text/html" })),
    );
    await view.settle();
    expectDefined(view.button("page.html", "Download"), "download").click();
    await view.settle();
    expect(
      view.request.mock.calls.filter(([method]) => method === "workboard.cards.attachments.get"),
    ).toHaveLength(1);
    expect(captured.created).toHaveLength(1);
    expect(captured.created[0]?.type).toBe("application/octet-stream");
    expect(captured.created[0]?.size).toBe("<script>alert(1)</script>".length);
    expect(captured.anchors).toEqual([
      { download: "page.html", href: expect.stringMatching(/^blob:/u) },
    ]);
    expect(captured.anchors[0]?.href).toBe(captured.objectUrls[0]);
  } finally {
    captured.restore();
  }
});

it("renders markdown through the host mount with real UTF-8 text", async () => {
  const view = mount(
    (method) =>
      method === "workboard.cards.attachments.get"
        ? {
            version: 1,
            attachment: attachment({ id: "a-md", fileName: "notes.md", mimeType: "text/markdown" }),
            contentBase64: UNICODE_MARKDOWN_BASE64,
          }
        : {},
    cardWith(attachment({ id: "a-md", fileName: "notes.md", mimeType: "text/markdown" })),
  );
  await view.settle();
  expectDefined(view.openButton("notes.md"), "open").click();
  await view.settle();
  expect(view.request).toHaveBeenCalledWith("workboard.cards.attachments.get", { id: "a-md" });
  const node = expectDefined(
    view.container.querySelector("[data-test-dialog] [data-test-markdown]"),
    "markdown",
  );
  expect(node.getAttribute("data-markdown")).toBe(UNICODE_MARKDOWN);
  expect(workboardTestHost().host.components.mountMarkdown).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({
      markdown: UNICODE_MARKDOWN,
      mode: "document",
      codeBlockChrome: "none",
    }),
  );
  // The plugin delegates rendering: it never builds a document of its own from the bytes.
  const dialog = expectDefined(view.container.querySelector("[data-test-dialog]"), "dialog");
  expect(dialog.querySelector("script, iframe, img, object, embed")).toBeNull();
  for (const element of dialog.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      expect(attribute.name.startsWith("on")).toBe(false);
    }
  }
});

it("hands markdown markup to the host sanitizer verbatim instead of rendering it", async () => {
  // Sanitization is the host mount's contract (proven in ui/src/components/markdown.test.ts
  // »strips scripts and unsafe links«). The plugin's own job is to decode the bytes and pass
  // the source on unchanged — never to pre-render, strip, or re-escape it.
  const source = "<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n# héllo";
  const view = mount(
    (method) =>
      method === "workboard.cards.attachments.get"
        ? {
            version: 1,
            attachment: attachment({ id: "a-md", fileName: "notes.md", mimeType: "text/markdown" }),
            contentBase64: btoa(String.fromCharCode(...new TextEncoder().encode(source))),
          }
        : {},
    cardWith(attachment({ id: "a-md", fileName: "notes.md", mimeType: "text/markdown" })),
  );
  await view.settle();
  expectDefined(view.openButton("notes.md"), "open").click();
  await view.settle();
  expect(workboardTestHost().host.components.mountMarkdown).toHaveBeenCalledTimes(1);
  const [, props] = vi.mocked(workboardTestHost().host.components.mountMarkdown).mock.calls[0]!;
  expect(props.markdown).toBe(source);
  // Nothing the plugin owns turned the markup into nodes.
  const dialog = expectDefined(view.container.querySelector("[data-test-dialog]"), "dialog");
  expect(dialog.querySelector("script, [onclick], a[href^='javascript:']")).toBeNull();
});

it("says so in place when a declared raster image cannot be decoded", async () => {
  const captured = captureDownload();
  try {
    const view = mount(
      (method) =>
        method === "workboard.cards.attachments.get"
          ? {
              version: 1,
              attachment: attachment({
                id: "a-png",
                fileName: "shot.png",
                mimeType: "image/png",
              }),
              // Declared image/png, but the bytes are not a PNG.
              contentBase64: btoa("not an image at all"),
            }
          : {},
      cardWith(attachment({ id: "a-png", fileName: "shot.png", mimeType: "image/png" })),
    );
    await view.settle();
    expectDefined(view.openButton("shot.png"), "open").click();
    await view.settle();
    const image = expectDefined(
      view.container.querySelector<HTMLImageElement>(".workboard-attachment-viewer__image"),
      "image",
    );
    // The stub <img> never loads, so the failure has to be delivered by hand.
    image.dispatchEvent(new Event("error"));
    await view.settle();
    const dialog = expectDefined(view.container.querySelector("[data-test-dialog]"), "dialog");
    expect(dialog.querySelector("[role='alert']")?.textContent).toContain("can't be shown here");
    expect(dialog.querySelector(".workboard-attachment-viewer__image")).toBeNull();
  } finally {
    captured.restore();
  }
});

it("renders a raster image from a blob URL and revokes it on close", async () => {
  const captured = captureDownload();
  try {
    const view = mount(
      (method) =>
        method === "workboard.cards.attachments.get"
          ? {
              version: 1,
              attachment: attachment({
                id: "a-png",
                fileName: "shot.png",
                mimeType: "image/png",
              }),
              contentBase64: btoa("\u0089PNG\r\n\u001a\n"),
            }
          : {},
      cardWith(attachment({ id: "a-png", fileName: "shot.png", mimeType: "image/png" })),
    );
    await view.settle();
    expectDefined(view.openButton("shot.png"), "open").click();
    await view.settle();
    const image = expectDefined(
      view.container.querySelector<HTMLImageElement>(".workboard-attachment-viewer__image"),
      "image",
    );
    expect(image.getAttribute("src")).toBe(captured.objectUrls[0]);
    expect(image.getAttribute("alt")).toBe("shot.png");
    expect(captured.revoked).toEqual([]);
    // Escape closes the dialog; the object URL must not outlive it.
    const dialog = expectDefined(view.container.querySelector("[data-test-dialog]"), "dialog");
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await view.settle();
    expect(captured.revoked).toEqual([captured.objectUrls[0]]);
  } finally {
    captured.restore();
  }
});

it("refuses markdown-typed bytes that are not UTF-8 instead of showing mojibake", async () => {
  const view = mount(
    (method) =>
      method === "workboard.cards.attachments.get"
        ? {
            version: 1,
            attachment: attachment({ id: "a-md", fileName: "notes.md", mimeType: "text/markdown" }),
            // 0xff 0xfe is not valid UTF-8.
            contentBase64: btoa(String.fromCharCode(0xff, 0xfe, 0x41)),
          }
        : {},
    cardWith(attachment({ id: "a-md", fileName: "notes.md", mimeType: "text/markdown" })),
  );
  await view.settle();
  expectDefined(view.openButton("notes.md"), "open").click();
  await view.settle();
  const dialog = expectDefined(view.container.querySelector("[data-test-dialog]"), "dialog");
  expect(dialog.querySelector("[role='alert']")?.textContent).toContain("can't be shown here");
  expect(dialog.querySelector("[data-test-markdown]")).toBeNull();
});

it("shows a failed read in place and offers no fallback to the bytes", async () => {
  const view = mount(
    (method) => {
      if (method === "workboard.cards.attachments.get") {
        throw Object.assign(new Error("socket closed"), {
          gatewayCode: "FORBIDDEN",
          code: "FORBIDDEN",
        });
      }
      return {};
    },
    cardWith(attachment({ id: "a-md", fileName: "notes.md", mimeType: "text/markdown" })),
  );
  await view.settle();
  expectDefined(view.openButton("notes.md"), "open").click();
  await view.settle();
  const dialog = expectDefined(view.container.querySelector("[data-test-dialog]"), "dialog");
  expect(dialog.querySelector("[role='alert']")?.textContent).toContain("may not read the file");
  expect(dialog.querySelector("[data-test-markdown]")).toBeNull();
  expect(dialog.querySelector("a")).toBeNull();
  expect(view.container.querySelector(".workboard-attachment-viewer__image")).toBeNull();
});

it("reports a failed download at the row and keeps one click to one request", async () => {
  const view = mount(
    (method) => {
      if (method === "workboard.cards.attachments.get") {
        throw new Error("gateway offline");
      }
      return {};
    },
    cardWith(attachment({ id: "a-html", fileName: "page.html", mimeType: "text/html" })),
  );
  await view.settle();
  const download = expectDefined(view.button("page.html", "Download"), "download");
  download.click();
  flush();
  // While in flight the button is disabled: a second click cannot issue a second read.
  expect(download.disabled).toBe(true);
  download.click();
  await view.settle();
  expect(
    view.request.mock.calls.filter(([method]) => method === "workboard.cards.attachments.get"),
  ).toHaveLength(1);
  const feedback = expectDefined(
    view.row("page.html").querySelector<HTMLElement>(".workboard-artifacts__feedback"),
    "row feedback",
  );
  expect(feedback.getAttribute("role")).toBe("status");
  expect(feedback.textContent).toContain("gateway offline");
  expect(download.disabled).toBe(false);
});

/** Captures every new-tab open and the blob URL handed to it. */
function captureNewTab() {
  const opened: Array<{ url: string; target: string; features: string }> = [];
  const created: Array<{ type: string; size: number }> = [];
  const revoked: string[] = [];
  const realCreateObjectURL = URL.createObjectURL.bind(URL);
  const realRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const realOpen = window.open;
  URL.createObjectURL = ((blob: Blob) => {
    created.push({ type: blob.type, size: blob.size });
    return `blob:fixture/pdf-${created.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    opened.push({ url: String(url), target: target ?? "", features: features ?? "" });
    return null;
  }) as typeof window.open;
  return {
    opened,
    created,
    revoked,
    restore() {
      window.open = realOpen;
      URL.createObjectURL = realCreateObjectURL;
      URL.revokeObjectURL = realRevokeObjectURL;
    },
  };
}

it("opens a declared PDF in a new tab from verified bytes and revokes the object URL", async () => {
  const captured = captureNewTab();
  try {
    const view = mount(
      (method) =>
        method === "workboard.cards.attachments.get"
          ? {
              version: 1,
              attachment: attachment({
                id: "a-pdf",
                fileName: "doc.pdf",
                mimeType: "application/pdf",
              }),
              contentBase64: btoa("%PDF-1.7\nbody"),
            }
          : {},
      cardWith(attachment({ id: "a-pdf", fileName: "doc.pdf", mimeType: "application/pdf" })),
    );
    await view.settle();
    expectDefined(view.openButton("doc.pdf"), "open").click();
    await view.settle();
    expect(view.request).toHaveBeenCalledWith("workboard.cards.attachments.get", { id: "a-pdf" });
    expect(captured.created).toEqual([{ type: "application/pdf", size: 13 }]);
    expect(captured.opened).toEqual([
      { url: "blob:fixture/pdf-1", target: "_blank", features: "noopener,noreferrer" },
    ]);
    // The object URL must not outlive the click.
    await vi.advanceTimersByTimeAsync(1);
    expect(captured.revoked).toEqual(["blob:fixture/pdf-1"]);
    // Nothing was written into the row as an in-app surface.
    expect(view.container.querySelector("[data-test-dialog]")).toBeNull();
  } finally {
    captured.restore();
  }
});

it("refuses to open a PDF whose bytes are not a PDF, and keeps Download", async () => {
  const captured = captureNewTab();
  try {
    const view = mount(
      (method) =>
        method === "workboard.cards.attachments.get"
          ? {
              version: 1,
              attachment: attachment({
                id: "a-pdf",
                fileName: "doc.pdf",
                mimeType: "application/pdf",
              }),
              // Declared application/pdf, but the bytes are HTML.
              contentBase64: btoa("<script>alert(1)</script>"),
            }
          : {},
      cardWith(attachment({ id: "a-pdf", fileName: "doc.pdf", mimeType: "application/pdf" })),
    );
    await view.settle();
    expectDefined(view.openButton("doc.pdf"), "open").click();
    await view.settle();
    // No tab, no blob URL, and no fallback to the bytes — the row says why instead.
    expect(captured.created).toEqual([]);
    expect(captured.opened).toEqual([]);
    const feedback = expectDefined(
      view.row("doc.pdf").querySelector<HTMLElement>(".workboard-artifacts__feedback"),
      "row feedback",
    );
    expect(feedback.getAttribute("role")).toBe("status");
    expect(feedback.textContent).toContain("%PDF-");
    expect(view.container.querySelector("[data-test-dialog]")).toBeNull();
  } finally {
    captured.restore();
  }
});

it("reports a failed PDF read at the row and opens nothing", async () => {
  const captured = captureNewTab();
  try {
    const view = mount(
      (method) => {
        if (method === "workboard.cards.attachments.get") {
          throw new Error("gateway offline");
        }
        return {};
      },
      cardWith(attachment({ id: "a-pdf", fileName: "doc.pdf", mimeType: "application/pdf" })),
    );
    await view.settle();
    expectDefined(view.openButton("doc.pdf"), "open").click();
    await view.settle();
    expect(captured.opened).toEqual([]);
    const feedback = expectDefined(
      view.row("doc.pdf").querySelector<HTMLElement>(".workboard-artifacts__feedback"),
      "row feedback",
    );
    expect(feedback.textContent).toContain("gateway offline");
  } finally {
    captured.restore();
  }
});

it("does not open a PDF whose declared type only carries parameters", async () => {
  // `application/pdf; charset=binary` is still a PDF declaration, and the magic byte decides.
  const captured = captureNewTab();
  try {
    const view = mount(
      (method) =>
        method === "workboard.cards.attachments.get"
          ? {
              version: 1,
              attachment: attachment({
                id: "a-pdf",
                fileName: "doc.pdf",
                mimeType: "application/pdf; charset=binary",
              }),
              contentBase64: btoa("not a pdf"),
            }
          : {},
      cardWith(
        attachment({
          id: "a-pdf",
          fileName: "doc.pdf",
          mimeType: "application/pdf; charset=binary",
        }),
      ),
    );
    await view.settle();
    expect(view.openButton("doc.pdf")).not.toBeNull();
    expectDefined(view.openButton("doc.pdf"), "open").click();
    await view.settle();
    expect(captured.opened).toEqual([]);
  } finally {
    captured.restore();
  }
});
