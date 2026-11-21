/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiMarkdownProps } from "../../../src/plugin-sdk/control-ui-components.js";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

async function mountMarkdown(props: ControlUiMarkdownProps) {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  const context = createContext(gateway.gateway, createSessions("main", []));
  const lifetime = new AbortController();
  const onError = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const handle = createControlUiComponents({
    current: () => context,
    signal: lifetime.signal,
    onError,
  }).mountMarkdown(container, props);
  onTestFinished(() => {
    lifetime.abort();
    container.remove();
  });
  await vi.dynamicImportSettled();
  const rendered = await vi.waitFor(() => {
    expect(onError).not.toHaveBeenCalled();
    const element = container.querySelector<HTMLElement>(
      "openclaw-plugin-markdown .sidebar-markdown",
    );
    expect(element).not.toBeNull();
    return element!;
  });
  return { container, handle, rendered, onError };
}

it("renders plugin text through the host's Markdown renderer", async () => {
  const { rendered, handle, container } = await mountMarkdown({
    markdown: "**bold** and `code`\nnext line\n\n- a\n- b",
    class: "workboard-detail__description",
  });

  expect(rendered.classList.contains("workboard-detail__description")).toBe(true);
  expect(rendered.querySelector("strong")?.textContent).toBe("bold");
  expect(rendered.querySelector("code")?.textContent).toBe("code");
  expect(rendered.querySelector("p br")).not.toBeNull();
  expect([...rendered.querySelectorAll("ul > li")].map((item) => item.textContent)).toEqual([
    "a",
    "b",
  ]);
  expect(rendered.children.length).toBeGreaterThanOrEqual(2);

  handle.update({ markdown: "first\n\nsecond" });
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll(".sidebar-markdown > p")].map((p) => p.textContent),
    ).toEqual(["first", "second"]),
  );

  handle.dispose();
  expect(container.childElementCount).toBe(0);
});

it("keeps raw HTML in plugin text inert", async () => {
  const { rendered, onError } = await mountMarkdown({
    markdown: "<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>",
  });

  expect(rendered.querySelector("script")).toBeNull();
  expect(rendered.querySelector("[onerror]")).toBeNull();
  expect(rendered.querySelector("img")).toBeNull();
  expect(rendered.innerHTML).not.toMatch(/<(?:script|img)/iu);
  expect(
    [...rendered.querySelectorAll("*")].flatMap((element) =>
      element.getAttributeNames().filter((name) => name.startsWith("on")),
    ),
  ).toEqual([]);
  // The source survives only as escaped text.
  expect(rendered.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(rendered.textContent).toContain("<script>alert(1)</script>");
  expect(onError).not.toHaveBeenCalled();
});

it("mounts a ```mermaid fence as a diagram, not a code block", async () => {
  const { rendered } = await mountMarkdown({
    markdown: "Before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter",
  });

  const diagram = await vi.waitFor(() => {
    const element = rendered.querySelector("openclaw-mermaid");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(diagram.textContent).toContain("flowchart LR");
  // The original code block was replaced by the diagram component (rendering of the
  // SVG itself is owned by markdown-mermaid.test.ts).
  expect(rendered.querySelector(".markdown-mermaid > pre")).toBeNull();
  expect(rendered.querySelector(".markdown-mermaid > openclaw-mermaid")).toBe(diagram);
});

it("renders an inline label as phrasing content without a block wrapper", async () => {
  const { rendered } = await mountMarkdown({
    markdown: "Ship **now** with `pnpm`",
    inline: true,
  });

  expect(rendered.tagName.toLowerCase()).toBe("span");
  expect(rendered.querySelector("p")).toBeNull();
  expect(rendered.querySelector("strong")?.textContent).toBe("now");
  expect(rendered.querySelector("code")?.textContent).toBe("pnpm");
});

it("drops a link inside an inline label so the control stays valid", async () => {
  const { rendered } = await mountMarkdown({
    markdown: "See [Docs](https://example.com)",
    inline: true,
  });

  expect(rendered.querySelector("a")).toBeNull();
  expect(rendered.textContent).toBe("See Docs");
});

it("acquires the diagram owner when a mount switches from inline to block", async () => {
  const { container, rendered, handle } = await mountMarkdown({ markdown: "chip", inline: true });
  expect(rendered.tagName.toLowerCase()).toBe("span");

  handle.update({ markdown: "```mermaid\nflowchart LR\n  A --> B\n```", inline: false });
  const block = await vi.waitFor(() => {
    const element = container.querySelector<HTMLElement>(
      "openclaw-plugin-markdown .sidebar-markdown:not(.sidebar-markdown--inline)",
    );
    expect(element).not.toBeNull();
    return element!;
  });
  expect(block.tagName.toLowerCase()).toBe("div");
  const diagram = await vi.waitFor(() => {
    const element = block.querySelector("openclaw-mermaid");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(diagram.textContent).toContain("flowchart LR");

  // Switching back to inline swaps the element again and releases the diagram owner.
  handle.update({ markdown: "chip again", inline: true });
  await vi.waitFor(() =>
    expect(
      container
        .querySelector<HTMLElement>("openclaw-plugin-markdown .sidebar-markdown--inline")
        ?.tagName.toLowerCase(),
    ).toBe("span"),
  );
  expect(container.querySelector("openclaw-mermaid")).toBeNull();
});
