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

/** The real PDP artifact shape: a path outside every agent workspace. */
const PDP_PATH =
  "/workspace/shared/reports-export/report-export/example-anforderungsformat-v1.0.md";

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
  const actions = (label: string) =>
    expectDefined(
      row(label).querySelector<HTMLElement>(".workboard-artifacts__actions"),
      `${label} actions`,
    );
  const actionByText = (label: string, text: string) =>
    [...actions(label).querySelectorAll<HTMLAnchorElement | HTMLButtonElement>("a, button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
  return { container, request, settle, row, actions, actionByText };
}

function cardWithArtifact(overrides: Partial<WorkboardCard["metadata"]>): WorkboardCard {
  return createWorkboardCard({
    agentId: "a",
    sessionKey: "agent:a:s1",
    metadata: overrides,
  });
}

it("asks the Gateway once per card and renders Open and Download from its own answer", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const view = mount(
    (method, params) => {
      calls.push({ method, params });
      if (method === "workboard.artifacts.fileAccess") {
        return {
          files: {
            pdp: {
              open: {
                url: "https://files.example.test/reports-export/report-export/example-anforderungsformat-v1.0.md",
              },
              download: {
                url: "/plugins/workboard/files/conn-1/ticket-1",
                expiresAt: "2026-11-10T10:19:00.000Z",
              },
            },
          },
        };
      }
      return {};
    },
    cardWithArtifact({
      artifacts: [{ id: "pdp", createdAt: 1, label: "PDP", path: PDP_PATH }],
    }),
  );
  await view.settle();
  // One read for the whole card, addressed by card id only — the path never travels.
  expect(calls.filter((call) => call.method === "workboard.artifacts.fileAccess")).toEqual([
    { method: "workboard.artifacts.fileAccess", params: { cardId: "card-1" } },
  ]);
  const open = expectDefined(view.actionByText("PDP", "Open"), "open") as HTMLAnchorElement;
  expect(open.getAttribute("href")).toBe(
    "https://files.example.test/reports-export/report-export/example-anforderungsformat-v1.0.md",
  );
  expect(open.getAttribute("target")).toBe("_blank");
  expect(open.getAttribute("rel")).toBe("noopener noreferrer");
  const download = expectDefined(
    view.actionByText("PDP", "Download"),
    "download",
  ) as HTMLAnchorElement;
  expect(download.getAttribute("href")).toBe("/plugins/workboard/files/conn-1/ticket-1");
  expect(download.hasAttribute("download")).toBe(true);
  // The row keeps its copyable reference beside the new actions.
  expect(view.row("PDP").querySelector("code")?.textContent).toBe(PDP_PATH);
});

it("renders no dead button when the server did not approve a path", async () => {
  const view = mount(
    (method) => (method === "workboard.artifacts.fileAccess" ? { files: {} } : {}),
    cardWithArtifact({
      artifacts: [
        { id: "unmapped", createdAt: 1, label: "Unmapped", path: "/srv/data/other/file.txt" },
      ],
    }),
  );
  await view.settle();
  expect(view.actionByText("Unmapped", "Open")).toBeUndefined();
  expect(view.actionByText("Unmapped", "Download")).toBeUndefined();
  // The existing Copy path (and Share) is what the row keeps; no Open, no Download.
  expect(view.actions("Unmapped").querySelectorAll("a")).toHaveLength(0);
  expect(
    [...view.actions("Unmapped").querySelectorAll("button")].map((b) => b.textContent?.trim()),
  ).toEqual(["Copy path", "Share…"]);
});

it("keeps html and svg path artifacts download-only even when a root maps them", async () => {
  const view = mount(
    (method) =>
      method === "workboard.artifacts.fileAccess"
        ? {
            files: {
              html: { download: { url: "/plugins/workboard/files/conn-1/html-ticket" } },
              svg: { download: { url: "/plugins/workboard/files/conn-1/svg-ticket" } },
            },
          }
        : {},
    cardWithArtifact({
      artifacts: [
        { id: "html", createdAt: 1, label: "Page", path: "/srv/export/page.html" },
        { id: "svg", createdAt: 1, label: "Logo", path: "/srv/export/logo.svg" },
      ],
    }),
  );
  await view.settle();
  for (const label of ["Page", "Logo"]) {
    expect(view.actionByText(label, "Open")).toBeUndefined();
    const download = expectDefined(
      view.actionByText(label, "Download"),
      `${label} download`,
    ) as HTMLAnchorElement;
    expect(download.hasAttribute("download")).toBe(true);
  }
});

it("does not ask the Gateway for a card whose artifacts carry no path", async () => {
  const view = mount(
    () => ({}),
    cardWithArtifact({
      artifacts: [{ id: "web", createdAt: 1, label: "Report", url: "https://example.test/r" }],
    }),
  );
  await view.settle();
  expect(view.request).not.toHaveBeenCalled();
  expect(view.actionByText("Report", "Open")?.getAttribute("href")).toBe("https://example.test/r");
});
