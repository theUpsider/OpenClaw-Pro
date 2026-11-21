import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createWorkboardView, inlineEditor } from "./view.test-support.ts";

const notes = "**bold** notes\n- first\n- second\nrun `pnpm test`";
const comment = "**owner** says\n- check `logs`\nthen ship";
const proofNote = "**passed** locally\n- `pnpm check`\nsecond line";

function blockMarkdownSources(root: Element | null) {
  return (
    [...(root?.querySelectorAll<HTMLElement>("[data-test-markdown]") ?? [])]
      .filter((element) => !(element as { props?: { inline?: boolean } }).props?.inline)
      // The waiting line is its own block mount, not notes/comments/proof.
      .filter((element) => !element.closest(".workboard-waiting"))
      .map((element) => element.getAttribute("data-markdown"))
  );
}

function literalTextNodes(root: Element, source: string) {
  // The old plaintext path put the raw source into its own <p> or <span>.
  return [...root.querySelectorAll("p, span")].filter(
    (element) =>
      !element.closest("[data-test-markdown]") &&
      !element.querySelector("[data-test-markdown]") &&
      element.textContent === source,
  );
}

function renderCardDetails(options: { writable: boolean; archived?: boolean }) {
  const card = createWorkboardCard({
    notes,
    metadata: {
      ...(options.archived ? { archivedAt: 10 } : {}),
      comments: [{ id: "comment-1", body: comment, createdAt: 3 }],
      proof: [{ id: "proof-1", status: "passed", label: "Unit", note: proofNote, createdAt: 5 }],
    },
  });
  const view = createWorkboardView(
    options.writable ? { client: createWorkboardTestClient({}) } : {},
  );
  view.state.cards = [card];
  view.state.showArchived = Boolean(options.archived);
  view.state.detailCardId = card.id;
  view.renderView();
  return view;
}

describe("card detail markdown", () => {
  it("hands overview notes, activity comments and proof notes to the host markdown mount", () => {
    const { container } = renderCardDetails({ writable: true });
    const panel = (id: string) =>
      expectDefined(
        container.querySelector(`#workboard-detail-panel-${id}`),
        `#workboard-detail-panel-${id}`,
      );

    expect(blockMarkdownSources(panel("overview"))).toEqual([notes]);
    expect(blockMarkdownSources(panel("activity"))).toEqual([comment]);
    expect(blockMarkdownSources(panel("details"))).toEqual([proofNote]);
    for (const [id, source] of [
      ["overview", notes],
      ["activity", comment],
      ["details", proofNote],
    ] as const) {
      expect(literalTextNodes(panel(id), source)).toEqual([]);
    }
    const mountMarkdown = workboardTestHost().host.components.mountMarkdown;
    expect(mountMarkdown).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ markdown: notes, codeBlockChrome: "none" }),
    );
  });

  it("renders read-only notes through the read path", () => {
    const { container } = renderCardDetails({ writable: false, archived: true });
    const overview = expectDefined(
      container.querySelector("#workboard-detail-panel-overview"),
      "overview panel",
    );

    expect(overview.querySelector(".workboard-detail__text-trigger--notes")).toBeNull();
    // A read-only note the convention does not cover still reaches the host mount, as the
    // fallback's lead.
    expect(blockMarkdownSources(overview)).toEqual([notes]);
    expect(overview.querySelector("p.workboard-detail__description")).toBeNull();
    expect(overview.querySelector(".workboard-notes--unstructured")).not.toBeNull();
  });

  it("edits the raw notes source", async () => {
    const { container } = renderCardDetails({ writable: true });
    const { open } = await inlineEditor(container, "notes");

    const textarea = await open();
    expect(textarea.value).toBe(notes);
  });

  it("renders the waiting line as block markdown through the host mount", () => {
    const { container } = renderCardDetails({ writable: true });
    const line = expectDefined(
      container.querySelector<HTMLElement>(".workboard-waiting"),
      "waiting line",
    );
    const mount = expectDefined(
      line.querySelector<HTMLElement>("[data-test-markdown]"),
      "markdown mount",
    );
    // The waiting line is a <div>, so it renders block Markdown like the notes.
    expect(mount.parentElement?.tagName.toLowerCase()).toBe("div");
    const mountMarkdown = workboardTestHost().host.components.mountMarkdown;
    const call = mountMarkdown.mock.calls.find(([target]) =>
      (target as HTMLElement).closest(".workboard-waiting"),
    );
    expect(call?.[1]).toEqual(expect.not.objectContaining({ inline: true }));
  });

  it("hands a ```mermaid fence in notes to the host mount unchanged", () => {
    const source = "Sketch:\n\n```mermaid\nflowchart LR\n  A --> B\n```";
    const card = createWorkboardCard({ notes: source });
    const view = createWorkboardView({ client: createWorkboardTestClient({}) });
    view.state.cards = [card];
    view.state.detailCardId = card.id;
    view.renderView();
    const overview = expectDefined(
      view.container.querySelector("#workboard-detail-panel-overview"),
      "overview panel",
    );
    expect(blockMarkdownSources(overview)).toContain(source);
  });
});
