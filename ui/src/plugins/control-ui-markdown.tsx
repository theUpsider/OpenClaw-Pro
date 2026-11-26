import { onSettled, Show } from "solid-js";
import type { ControlUiMarkdownProps } from "../../../src/plugin-sdk/control-ui-components.js";
import { MarkdownBlocks } from "../components/markdown-blocks-owner.ts";
import { handleMarkdownCodeBlockClick } from "../components/markdown-code-blocks.ts";
import { toSanitizedInlineMarkdownHtml, toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { SanitizedHtml } from "../components/solid/sanitized-html.tsx";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import "../styles/sidebar-markdown.css";

type PluginMarkdownProperties = { props: ControlUiMarkdownProps };

/** Block text: the host's Markdown lifecycle owner mounts Mermaid and code blocks. */
function PluginMarkdownBlock(properties: PluginMarkdownProperties) {
  let root!: HTMLElement;
  onSettled(() => {
    const blocks = new MarkdownBlocks(root);
    blocks.update(true);
    return () => blocks.dispose();
  });
  return (
    <SanitizedHtml
      tag="div"
      ref={(element) => {
        root = element;
      }}
      class={["sidebar-markdown", properties.props.class]}
      // Plugin text containers often preserve authored whitespace; rendered
      // Markdown carries its own line breaks and must not inherit pre-wrap.
      style={{ "white-space": "normal" }}
      onClick={handleMarkdownCodeBlockClick}
      html={toSanitizedMarkdownHtml(properties.props.markdown, {
        mode: properties.props.mode ?? "message",
        codeBlockChrome: properties.props.codeBlockChrome ?? "copy",
      })}
    />
  );
}

/** Inline text: phrasing content for a label inside a button/radio; no block owner. */
function PluginMarkdownInline(properties: PluginMarkdownProperties) {
  return (
    <SanitizedHtml
      tag="span"
      class={["sidebar-markdown", "sidebar-markdown--inline", properties.props.class]}
      style={{ "white-space": "normal" }}
      onClick={handleMarkdownCodeBlockClick}
      html={toSanitizedInlineMarkdownHtml(properties.props.markdown, {
        mode: properties.props.mode ?? "message",
      })}
    />
  );
}

export const PluginMarkdown = defineSolidBridge<PluginMarkdownProperties>(
  "openclaw-plugin-markdown",
  (properties) => (
    // Swapping the branch recreates the element, so a tag is never frozen and the
    // Mermaid owner is acquired/released when a mount switches between the two modes.
    <Show
      when={properties.props.inline === true}
      fallback={<PluginMarkdownBlock {...properties} />}
    >
      <PluginMarkdownInline {...properties} />
    </Show>
  ),
  {
    properties: {
      props: { default: { markdown: "" }, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-markdown": SolidBridgeElement<PluginMarkdownProperties>;
  }
}
