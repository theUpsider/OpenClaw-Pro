import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/web";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { CardArtifacts } from "./view-card-artifacts.tsx";

const card = createWorkboardCard({
  agentId: "a",
  sessionKey: "agent:a:s1",
  metadata: {
    artifacts: [
      { id: "md", createdAt: 1, label: "Plan", path: "plans/plan.md" },
      { id: "abs", createdAt: 1, label: "Out", path: "/mnt/fileserver/x/out.md" },
      { id: "bin", createdAt: 1, label: "Video", path: "out/demo.mp4" },
      { id: "web", createdAt: 1, label: "Report", url: "https://example.test/report" },
    ],
  },
});

let dispose: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

function mount(
  handler: (method: string, params: unknown) => unknown,
  cardUnderTest: WorkboardCard = card,
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
  const preview = (label: string) =>
    row(label).querySelector<HTMLButtonElement>("button[aria-label^='Preview']");
  return { container, request, settle, row, preview };
}

it("offers Preview only on markdown path rows", async () => {
  const view = mount(() => ({}));
  await view.settle();
  expect(view.preview("Plan")).not.toBeNull();
  expect(view.preview("Out")).not.toBeNull();
  expect(view.preview("Video")).toBeNull();
  expect(view.preview("Report")).toBeNull();
});

it("hands the fetched file to the host markdown mount in document mode", async () => {
  const source = "# Plan\n\n- one\n```ts\nx\n```";
  const view = mount((method) =>
    method === "agents.workspace.get" ? { file: { content: source, encoding: "utf8" } } : {},
  );
  await view.settle();
  expectDefined(view.preview("Plan"), "preview").click();
  await view.settle();
  const node = expectDefined(
    view.container.querySelector("[data-test-dialog] [data-test-markdown]"),
    "markdown",
  );
  expect(node.getAttribute("data-markdown")).toBe(source);
  expect(view.container.querySelector("[data-test-dialog] pre")).toBeNull();
  expect(workboardTestHost().host.components.mountMarkdown).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({ markdown: source, mode: "document", codeBlockChrome: "none" }),
  );
  expect(view.request).toHaveBeenCalledWith("agents.workspace.get", {
    agentId: "a",
    path: "plans/plan.md",
  });
});

it("shows a plain message and no markdown for an unreachable path, without reading", async () => {
  const view = mount((method) =>
    method === "agents.files.list" ? { workspace: "/ws/a" } : {},
  );
  await view.settle();
  expectDefined(view.preview("Out"), "preview").click();
  await view.settle();
  const dialog = expectDefined(view.container.querySelector("[data-test-dialog]"), "dialog");
  expect(dialog.querySelector("[role=alert]")?.textContent).toContain("can't be previewed");
  expect(dialog.querySelector("[data-test-markdown]")).toBeNull();
  expect(view.request.mock.calls.map(([m]) => m)).toEqual([
    "workboard.artifacts.fileAccess",
    "agents.files.list",
  ]);
});

it("does not retry a refusal through the next reader, but retries a transport fault", async () => {
  const refused = mount((method) => {
    if (method === "agents.workspace.get") {
      throw Object.assign(new Error("nope"), { code: "workspace_file_not_found" });
    }
    return { file: { content: "other", previewKind: "text", contentEncoding: "utf8" } };
  });
  await refused.settle();
  expectDefined(refused.preview("Plan"), "preview").click();
  await refused.settle();
  expect(refused.request.mock.calls.map(([m]) => m)).toEqual([
    "workboard.artifacts.fileAccess",
    "agents.workspace.get",
  ]);
  expect(refused.container.querySelector("[data-test-markdown]")).toBeNull();
  dispose?.();
  refused.container.remove();

  const flaky = mount((method) => {
    if (method === "agents.workspace.get") {
      throw new Error("socket closed");
    }
    return { file: { content: "from session", previewKind: "text", contentEncoding: "utf8" } };
  });
  await flaky.settle();
  expectDefined(flaky.preview("Plan"), "preview").click();
  await flaky.settle();
  expect(flaky.container.querySelector("[data-test-markdown]")?.getAttribute("data-markdown")).toBe(
    "from session",
  );
});

it("drops a late response after Escape closes the dialog and disposes the handles", async () => {
  let release: (value: unknown) => void = () => undefined;
  const view = mount((method) =>
    method === "agents.workspace.get"
      ? new Promise((resolve) => {
          release = resolve;
        })
      : {},
  );
  await view.settle();
  expectDefined(view.preview("Plan"), "preview").click();
  await view.settle();
  const dialog = expectDefined(view.container.querySelector("[data-test-dialog]"), "dialog");
  expect(dialog.querySelector("[role=status]")?.textContent).toContain("Loading");
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  await view.settle();
  expect(view.container.querySelector("[data-test-dialog]")).toBeNull();
  release({ file: { content: "late", encoding: "utf8" } });
  await view.settle();
  expect(view.container.querySelector("[data-test-markdown]")).toBeNull();
  const dialogMount = vi.mocked(workboardTestHost().host.components.mountDialog);
  const handle = dialogMount.mock.results.at(-1)?.value;
  expect(handle.dispose).toHaveBeenCalled();
});

it("keeps Open and Copy path unchanged", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const view = mount(() => ({}));
  await view.settle();
  const link = expectDefined(view.row("Report").querySelector("a"), "open link");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  const copy = [...view.row("Plan").querySelectorAll("button")].find(
    (b) => b.textContent === "Copy path",
  );
  expectDefined(copy, "copy").click();
  await view.settle();
  expect(writeText).toHaveBeenCalledWith("plans/plan.md");
});
