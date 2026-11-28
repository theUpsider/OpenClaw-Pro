import { spread } from "@solidjs/web";
import { createRoot } from "solid-js";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type {
  ControlUiComponentHandle,
  ControlUiComponents,
  ControlUiDialogProps,
} from "../../../src/plugin-sdk/control-ui-components.js";
import type { ApplicationContext } from "../app/context.ts";
import { readGatewayOperatorAccess } from "../app/operator-access.ts";
import { listen as listenTo } from "../lib/reactive/listener.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import {
  sharedAgentIdentityProjection,
  sharedAgentsProjection,
} from "../lib/reactive/shared-application-projections.ts";

function resolveAppearanceColor(value: string | null | undefined): string {
  const color = normalizeSessionColorValue(value ?? "");
  if (color) {
    return `var(--session-color-${color})`;
  }
  const raw = value?.trim() ?? "";
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(raw) ? raw : "";
}

export function createControlUiComponents(options: {
  current: () => ApplicationContext;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}): ControlUiComponents {
  function mount<P, E extends HTMLElement>(
    container: HTMLElement,
    initial: P,
    load: () => Promise<E>,
    apply: (element: E, props: P, current: () => ApplicationContext) => void,
    listen?: (element: E, props: () => P) => () => void,
    observe?: (context: ApplicationContext, refresh: () => void) => () => void,
  ): ControlUiComponentHandle<P> {
    options.current();
    options.signal.throwIfAborted();
    let props = initial;
    let element: E | undefined;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    const current = () => {
      if (!active) {
        throw new Error("This plugin component has been disposed.");
      }
      options.signal.throwIfAborted();
      return options.current();
    };
    const refresh = () => {
      if (element && active) {
        apply(element, props, current);
      }
    };
    const dispose = () => {
      if (!active) {
        return;
      }
      active = false;
      options.signal.removeEventListener("abort", dispose);
      unsubscribe?.();
      unlisten?.();
      element?.remove();
    };
    options.signal.addEventListener("abort", dispose, { once: true });
    void load()
      .then((loaded) => {
        // Imports can finish after navigation or reload. The retired mount must
        // never reconnect a dialog, provider lease, or event callback.
        if (!active || options.signal.aborted) {
          return;
        }
        current();
        element = loaded;
        unlisten = listen?.(element, () => {
          current();
          return props;
        });
        refresh();
        container.append(element);
        const context = current();
        const stops = [context.gateway.subscribe(refresh), context.agents.subscribe(refresh)];
        if (observe) {
          stops.push(observe(context, refresh));
        }
        unsubscribe = () => stops.forEach((stop) => stop());
      })
      .catch((error: unknown) => {
        if (active) {
          dispose();
          options.onError(error);
        }
      });
    return {
      update(next) {
        current();
        props = next;
        refresh();
      },
      dispose,
    };
  }

  function component<P, K extends keyof HTMLElementTagNameMap>(
    tag: K,
    load: () => Promise<unknown>,
    bindings: (props: P, current: () => ApplicationContext) => Record<string, unknown>,
    listen?: (element: HTMLElementTagNameMap[K], props: () => P) => () => void,
    sources: (
      context: ApplicationContext,
    ) => { subscribe(notify: () => void): () => void }[] = () => [],
    apply?: (element: HTMLElementTagNameMap[K], props: P) => void,
    hydrate?: (props: P, context: ApplicationContext) => void,
  ): (container: HTMLElement, initial: P) => ControlUiComponentHandle<P> {
    return (container, initial) => {
      let props = initial;
      let element: HTMLElementTagNameMap[K] | undefined;
      let active = true;
      let disposeBindings: (() => void) | undefined;
      let publish = () => {};
      let unlisten: (() => void) | undefined;
      const current = () => {
        if (!active) {
          throw new Error("This plugin component has been disposed.");
        }
        options.signal.throwIfAborted();
        return options.current();
      };
      current();
      const dispose = () => {
        if (!active) {
          return;
        }
        active = false;
        unlistenAbort();
        disposeBindings?.();
        unlisten?.();
        element?.remove();
      };
      const unlistenAbort = listenTo(options.signal, "abort", dispose, { once: true });
      void load()
        .then(() => {
          // Late imports must not reconnect retired dialogs, leases, or callbacks.
          if (!active || options.signal.aborted) {
            return;
          }
          current();
          const loaded = document.createElement(tag);
          element = loaded;
          unlisten = listen?.(element, () => {
            current();
            return props;
          });
          apply?.(element, props);
          hydrate?.(props, current());
          disposeBindings = createRoot((disposeRoot) => {
            const presentation = projectSource(current(), {
              read: () => bindings(props, current),
              subscribe: (context, notify) => {
                publish = () => {
                  hydrate?.(props, current());
                  notify();
                };
                const stops = sources(context).map((source) => source.subscribe(publish));
                return () => {
                  publish = () => {};
                  stops.forEach((stop) => stop());
                };
              },
              equality: "revision",
            });
            spread(loaded, presentation.read, true);
            return disposeRoot;
          });
          container.append(element);
        })
        .catch((error: unknown) => {
          if (active) {
            dispose();
            options.onError(error);
          }
        });
      return {
        update(next) {
          current();
          props = next;
          if (element) {
            apply?.(element, props);
          }
          publish();
        },
        dispose,
      };
    };
  }

  return {
    resolveAppearanceColor(value) {
      options.current();
      options.signal.throwIfAborted();
      return resolveAppearanceColor(value);
    },
    mountAgentAvatar: component(
      "openclaw-agent-avatar",
      () => import("../components/solid/agent-avatar.tsx"),
      (next, current) => {
        const context = current();
        const agentsList = context.agents.state.agentsList;
        const id = next.agentId || agentsList?.defaultId || "";
        return {
          "prop:option": {
            value: id,
            label: next.label,
            agent: agentsList?.agents.find((agent) => agent.id === id) ?? { id },
          },
          "prop:identity": context.agentIdentity.get(id),
        };
      },
      undefined,
      (context) => [
        sharedAgentsProjection(context.agents),
        sharedAgentIdentityProjection(context.agentIdentity),
      ],
      undefined,
      (next, context) => {
        void context.agentIdentity.ensure([
          next.agentId || context.agents.state.agentsList?.defaultId || "",
        ]);
      },
    ),
    mountAppearancePicker: component(
      "openclaw-appearance-picker",
      () => import("../components/appearance-picker.tsx"),
      (next, current) => ({
        "prop:props": {
          ...next,
          onChange: (appearance: Parameters<typeof next.onChange>[0]) => {
            current();
            next.onChange(appearance);
          },
        },
      }),
    ),
    mountAppearanceGlyph: component(
      "openclaw-appearance-glyph",
      () => import("../components/appearance-picker.tsx"),
      (next) => ({
        "prop:props": next,
        style: { "--appearance-color": resolveAppearanceColor(next.color) || "var(--muted)" },
      }),
    ),
    mountDialog: (container, props) => {
      let content: HTMLElement | undefined;
      return component(
        "openclaw-modal-dialog",
        () => import("../components/modal-dialog.tsx"),
        (next: ControlUiDialogProps) => ({
          "prop:label": next.label,
          "prop:description": next.description ?? "",
          class: next.className ?? "",
          style: next.style ?? "",
        }),
        (element, getProps) => {
          // Plugin content is a foreign DOM island with native autofocus semantics.
          element.initialFocus = () =>
            content?.matches("[autofocus]")
              ? content
              : (content?.querySelector<HTMLElement>("[autofocus]") ?? null);
          return listenTo(element, "modal-cancel", (event) => {
            if (getProps().onCancel() === false) {
              event.preventDefault();
            }
          });
        },
        undefined,
        (element, next) => {
          // SDK updates settle content custody and focus targets synchronously.
          if (next.returnFocusTarget !== undefined) {
            element.setReturnFocusTarget(next.returnFocusTarget);
          }
          if (content !== next.content) {
            if (content) {
              content.replaceWith(next.content);
            } else {
              element.append(next.content);
            }
            content = next.content;
          }
        },
      )(container, props);
    },
    mountAgentPicker: component(
      "openclaw-agent-select",
      () => import("../components/agent-select-registration.ts"),
      (next, current) => {
        const agents = current().agents.state.agentsList?.agents ?? [];
        return {
          "prop:options": next.options.map((option) => ({
            ...option,
            agent: agents.find((agent) => agent.id === option.agent?.id) ?? option.agent,
          })),
          "prop:value": next.value,
          "prop:placeholder": next.placeholder ?? "",
          "prop:accessibleLabel": next.accessibleLabel,
          "prop:menuLabel": next.menuLabel ?? "",
          "prop:variant": next.variant ?? "default",
          "prop:disabled": next.disabled ?? false,
          "prop:onSelect": (value: string) => {
            current();
            next.onSelect(value);
          },
        };
      },
      undefined,
      (context) => [sharedAgentsProjection(context.agents)],
    ),
    mountSelectPicker: component(
      "openclaw-select-picker",
      () => import("../components/select-picker.ts"),
      (next, current) => ({
        class: "settings-select picker-select",
        "prop:params": {
          options: next.options,
          value: next.value,
          label: next.accessibleLabel,
          searchable: next.searchable,
          disabled: next.disabled,
          onChange: (value: string) => {
            current();
            next.onSelect(value);
          },
        },
      }),
    ),
    mountSessionSummary: component(
      "openclaw-plugin-session-summary",
      () => import("./control-ui-session-summary.tsx"),
      (next, current) => ({
        "prop:session": next.session,
        "prop:gateway": current().gateway,
        "prop:agents": current().agents.state.agentsList?.agents ?? [],
        "prop:agentIdentity": current().agentIdentity,
        "prop:presented": next.presented,
      }),
      undefined,
      (context) => [sharedAgentsProjection(context.agents)],
    ),
    mountDashboard: component(
      "openclaw-plugin-session-dashboard",
      () => import("./control-ui-dashboard.tsx"),
      (next, current) => {
        const snapshot = current().gateway.snapshot;
        const access = readGatewayOperatorAccess(snapshot);
        return {
          "prop:session": next.session,
          "prop:client": snapshot.client,
          "prop:connected": snapshot.phase === "connected",
          "prop:canMutate": next.canMutate && access.canWrite,
          "prop:canGrant": next.canGrant && access.canGrantApprovals,
          "prop:presented": next.presented ?? true,
        };
      },
      undefined,
      (context) => [context.gateway],
    ),
    mountDictationControl: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("./control-ui-dictation.tsx");
          return document.createElement("openclaw-plugin-dictation-control");
        },
        (element, next, current) => {
          const context = current();
          const snapshot = context.gateway.snapshot;
          element.client = snapshot.client;
          element.connected = snapshot.phase === "connected";
          element.inputDeviceId = context.theme.settings.realtimeTalkInputDeviceId;
          element.enabled = next.enabled;
          element.disabledReason = next.disabledReason;
          element.accessibleLabel = next.accessibleLabel;
          element.onStart = () => {
            current();
            next.onStart?.();
          };
          element.onTranscript = (text) => {
            current();
            next.onTranscript(text);
          };
          element.onError = (message) => {
            current();
            next.onError(message);
          };
          element.onStateChange = (state) => {
            current();
            next.onStateChange?.(state);
          };
        },
        undefined,
        (context, refresh) => context.theme.subscribe(refresh),
      ),
    mountComposerSessionControls: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("./control-ui-composer-session-controls.tsx");
          return document.createElement("openclaw-plugin-composer-session-controls");
        },
        (element, next, current) => {
          element.context = current();
          // Host publications re-resolve the catalog, access and defaults.
          element.revision = {};
          element.sessionKey = next.sessionKey;
          element.agentId = next.agentId;
          element.disabledReason = next.disabledReason;
          element.onError = (message) => {
            current();
            next.onError?.(message);
          };
        },
        undefined,
        (context, refresh) => context.sessions.subscribe(refresh),
      ),
    mountComposerSendAction: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("./control-ui-composer-send-action.tsx");
          return document.createElement("openclaw-plugin-composer-send-action");
        },
        (element, next, current) => {
          element.context = current();
          element.revision = {};
          element.sessionKey = next.sessionKey;
          element.agentId = next.agentId;
          element.draft = next.draft;
          element.sending = next.sending ?? false;
          element.disabledReason = next.disabledReason;
          element.describedBy = next.describedBy;
          element.onSend = (followUpMode) => {
            current();
            next.onSend(followUpMode);
          };
        },
        undefined,
        (context, refresh) => {
          const stops = [
            context.sessions.subscribe(refresh),
            context.theme.subscribe(refresh),
            context.runtimeConfig.subscribe(refresh),
          ];
          return () => stops.forEach((stop) => stop());
        },
      ),
    mountMarkdown: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("./control-ui-markdown.tsx");
          return document.createElement("openclaw-plugin-markdown");
        },
        (element, next) => {
          element.props = next;
        },
      ),
  };
}
