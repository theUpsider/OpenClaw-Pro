import { dynamic, type JSX } from "@solidjs/web";

/** Only accepts HTML escaped or sanitized by the caller's content owner. */
export function SanitizedHtml(props: {
  html: string;
  tag?: "article" | "code" | "div" | "pre" | "span";
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  style?: JSX.HTMLAttributes<HTMLElement>["style"];
  onClick?: JSX.EventHandler<HTMLElement, MouseEvent>;
  role?: JSX.HTMLAttributes<HTMLElement>["role"];
  "aria-label"?: string;
  tabindex?: number;
  /** Observe the rendered root, e.g. to attach a Markdown block lifecycle owner. */
  ref?: (element: HTMLElement) => void;
}) {
  const Container = dynamic(() => props.tag ?? "div");
  return (
    <Container
      class={props.class}
      style={props.style}
      onClick={props.onClick}
      role={props.role}
      aria-label={props["aria-label"]}
      tabindex={props.tabindex}
      ref={props.ref}
      // eslint-disable-next-line solid/no-innerhtml -- Content is escaped or sanitized by the caller's canonical owner.
      innerHTML={props.html}
    />
  );
}
