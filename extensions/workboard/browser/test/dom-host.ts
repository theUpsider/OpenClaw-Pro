import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { vi } from "vitest";

/** The fixture exposes only the DOM-mount contract; host component internals have their own tests. */
export function installDomComponents(host: ControlUiHost): void {
  host.components.mountDialog = vi.fn((container, initial) => {
    const element = document.createElement("section");
    element.dataset.testDialog = "";
    let props = initial;
    const apply = (next: typeof initial) => {
      props = next;
      element.setAttribute("aria-label", next.label);
      element.setAttribute("aria-description", next.description ?? "");
      element.className = next.className ?? "";
      if (element.firstChild !== next.content) {
        element.replaceChildren(next.content);
      }
    };
    element.addEventListener("cancel", (event) => {
      if (props.onCancel() === false) {
        event.preventDefault();
      }
    });
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAgentPicker = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAgentPicker = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountSelectPicker = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testSelectPicker = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAgentAvatar = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAgentAvatar = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAppearancePicker = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAppearancePicker = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAppearanceGlyph = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAppearanceGlyph = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountSessionSummary = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testSessionSummary = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountDashboard = vi.fn((container, initial) => {
    const element = document.createElement("section");
    element.dataset.testDashboard = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountDictationControl = vi.fn((container, initial) => {
    // Tests drive the plugin callbacks directly; the host owns capture and transcription.
    const element = document.createElement("button");
    element.dataset.testDictation = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, { props });
      element.disabled = !props.enabled;
      element.setAttribute("aria-label", props.accessibleLabel);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountComposerSessionControls = vi.fn((container, initial) => {
    // The host owns the catalog and applies choices; tests observe the target.
    const element = document.createElement("span");
    element.dataset.testSessionControls = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, { props });
      element.title = props.disabledReason ?? "";
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountComposerSendAction = vi.fn((container, initial) => {
    // The host resolves the delivery; tests set `followUpMode` to the one it would report.
    const element = Object.assign(document.createElement("button"), {
      followUpMode: undefined as Parameters<typeof initial.onSend>[0],
      textContent: "Send",
    });
    element.type = "button";
    element.dataset.testSendAction = "";
    let props = initial;
    const apply = (next: typeof initial) => {
      props = next;
      Object.assign(element, { props });
      element.disabled = Boolean(next.sending || next.disabledReason || !next.draft.trim());
      if (next.describedBy) {
        element.setAttribute("aria-describedby", next.describedBy);
      } else {
        element.removeAttribute("aria-describedby");
      }
    };
    element.addEventListener("click", () => props.onSend(element.followUpMode));
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountMarkdown = vi.fn((container, initial) => {
    // The host owns parsing and sanitizing; tests observe the authored source.
    const element = document.createElement("div");
    element.dataset.testMarkdown = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, { props });
      element.textContent = props.markdown;
      element.setAttribute("data-markdown", props.markdown);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
}
