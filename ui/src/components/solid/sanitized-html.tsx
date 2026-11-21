import { dynamic, type JSX } from "@solidjs/web";
import { untrack } from "solid-js";

/** Only accepts HTML escaped or sanitized by the caller's content owner. */
export function SanitizedHtml(props: {
  html: string;
  tag?: "article" | "code" | "div" | "pre" | "span";
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  style?: JSX.HTMLAttributes<HTMLElement>["style"];
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
  /** Observe the rendered root, e.g. to attach a Markdown block lifecycle owner. */
  ref?: (element: HTMLElement) => void;
}) {
  const tag = untrack(() => props.tag ?? "div");
  const Container = dynamic(() => tag);
  return (
    <Container
      class={props.class}
      style={props.style}
      onClick={props.onClick}
      ref={props.ref}
      // eslint-disable-next-line solid/no-innerhtml -- Content is escaped or sanitized by the caller's canonical owner.
      innerHTML={props.html}
    />
  );
}
