/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type {
  ControlUiComposerSendActionProps,
  ControlUiComposerSessionControlsProps,
} from "../../../src/plugin-sdk/control-ui-components.js";
import type { GatewaySessionRow, ModelCatalogEntry } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { successfulSessionPatch } from "../test-helpers/app-sidebar.ts";
import { sessionMutationGatewayHello } from "../test-helpers/gateway-methods.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

const DOCK = "agent:main:dock-voice";
const luna = { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" };
const sol = { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true };

function createHost(row: Partial<GatewaySessionRow> | null, models: ModelCatalogEntry[] = []) {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const request = vi.fn(async (method: string) => (method === "models.list" ? { models } : {}));
  const sessionRow =
    row && ({ key: DOCK, agentId: "main", sessionId: "dock-1", ...row } as GatewaySessionRow);
  const observeRow = vi.fn((_target: { key: string; agentId: string }) => ({
    row: sessionRow,
    sessionId: sessionRow?.sessionId ?? null,
    hasObserved: true,
    isCurrent: () => true,
    captureReconcile: () => () => ({ status: "retired" as const }),
    dispose: vi.fn(),
  }));
  const patch = vi.fn(async (key: string) => successfulSessionPatch(key));
  const settings: { chatFollowUpMode?: "queue" | "steer" } = {};
  const context = {
    navigate: vi.fn(),
    gateway: {
      subscribe,
      subscribeEvents: () => () => undefined,
      snapshot: { phase: "connected", client: { request }, hello: sessionMutationGatewayHello() },
    },
    agents: {
      subscribe,
      state: {
        agentsList: {
          defaultId: "main",
          agents: [{ id: "main", model: { primary: "openai/gpt-5.6-luna" } }],
        },
      },
    },
    theme: { subscribe, settings },
    runtimeConfig: { subscribe, state: { bootstrapConfig: {} } },
    sessions: {
      subscribe,
      observeRow,
      patch,
      refresh: vi.fn(async () => undefined),
      settingsPreview: () => undefined,
      captureConnectionScope: () => ({}),
      isConnectionScopeCurrent: () => true,
      state: {
        modelOverrides: {},
        result: {
          defaults: { model: "gpt-5.6-luna", modelProvider: "openai" },
          sessions: [],
        },
      },
    },
  } as unknown as ApplicationContext;
  const lifetime = new AbortController();
  const onError = vi.fn();
  const components = createControlUiComponents({
    current: () => context,
    signal: lifetime.signal,
    onError,
  });
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    lifetime.abort();
    container.remove();
  });
  return { components, container, request, observeRow, patch, settings, onError };
}

async function mountSendAction(
  row: Partial<GatewaySessionRow> | null,
  props: Partial<ControlUiComposerSendActionProps> = {},
  followUpMode?: "queue" | "steer",
) {
  const host = createHost(row);
  host.settings.chatFollowUpMode = followUpMode;
  const onSend = vi.fn();
  const handle = host.components.mountComposerSendAction(host.container, {
    sessionKey: DOCK,
    agentId: "main",
    draft: "move the release card",
    onSend,
    ...props,
  });
  await vi.dynamicImportSettled();
  const button = await vi.waitFor(() => {
    expect(host.onError).not.toHaveBeenCalled();
    const found = host.container.querySelector<HTMLButtonElement>(".chat-send-btn--send");
    expect(found).not.toBeNull();
    return found!;
  });
  return { ...host, handle, button, onSend };
}

it("labels the composer's send, steer and queue actions and reports the delivery", async () => {
  const idle = await mountSendAction({ status: "done" });
  expect(idle.observeRow).toHaveBeenCalledWith(
    { key: DOCK, agentId: "main" },
    expect.any(Function),
  );
  expect(idle.button.textContent).toBe("Send");
  idle.button.click();
  await vi.waitFor(() => expect(idle.onSend).toHaveBeenCalledExactlyOnceWith(undefined));

  const steering = await mountSendAction({ status: "running", queueMode: "steer" });
  expect(steering.button.textContent).toBe("Steer");
  steering.button.click();
  await vi.waitFor(() => expect(steering.onSend).toHaveBeenCalledExactlyOnceWith("steer"));

  // The composer's local queue has no plugin outbox; the Gateway's follow-up queue stands in.
  const queued = await mountSendAction({ status: "running" }, {}, "queue");
  expect(queued.button.textContent).toBe("Queue");
  queued.button.click();
  await vi.waitFor(() => expect(queued.onSend).toHaveBeenCalledExactlyOnceWith("followup"));

  // A conversation the plugin creates on send has nothing running yet.
  const fresh = await mountSendAction(null, { sessionKey: null });
  expect(fresh.observeRow).not.toHaveBeenCalled();
  expect(fresh.button.textContent).toBe("Send");
});

it("keeps the composer's refusals and the plugin's description", async () => {
  const empty = await mountSendAction({ status: "done" }, { draft: "  ", describedBy: "why" });
  expect(empty.button.disabled).toBe(true);
  expect(empty.button.getAttribute("aria-describedby")?.split(" ")).toContain("why");

  const readOnly = await mountSendAction(
    { status: "done" },
    { disabledReason: "Sending messages is unavailable with your current access." },
  );
  expect(readOnly.button.disabled).toBe(true);
  expect(readOnly.button.getAttribute("aria-label")).toBe(
    "Sending messages is unavailable with your current access.",
  );
  readOnly.button.click();
  expect(readOnly.onSend).not.toHaveBeenCalled();

  readOnly.handle.update({
    sessionKey: DOCK,
    draft: "move it",
    sending: true,
    onSend: readOnly.onSend,
  });
  await vi.waitFor(() => expect(readOnly.button.getAttribute("aria-busy")).toBe("true"));
  expect(readOnly.button.disabled).toBe(true);
});

async function mountSessionControls(
  row: Partial<GatewaySessionRow> | null,
  props: Partial<ControlUiComposerSessionControlsProps> = {},
) {
  const host = createHost(row, [luna, sol]);
  const onPluginError = vi.fn();
  const handle = host.components.mountComposerSessionControls(host.container, {
    sessionKey: DOCK,
    agentId: "main",
    onError: onPluginError,
    ...props,
  });
  await vi.dynamicImportSettled();
  const trigger = await vi.waitFor(() => {
    expect(host.onError).not.toHaveBeenCalled();
    const found = host.container.querySelector<HTMLElement>("[data-chat-model-select]");
    expect(found).not.toBeNull();
    return found!;
  });
  return { ...host, handle, trigger, onPluginError };
}

it("applies a model choice to the target conversation through the session owner", async () => {
  const controls = await mountSessionControls({ model: "gpt-5.6-luna", modelProvider: "openai" });
  expect(controls.request).toHaveBeenCalledWith(
    "models.list",
    expect.objectContaining({ agentId: "main", sessionKey: DOCK }),
    expect.anything(),
  );
  const option = await vi.waitFor(() => {
    const found = controls.container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="openai/gpt-5.6-sol"]',
    );
    expect(found).not.toBeNull();
    return found!;
  });
  expect(controls.trigger.textContent).toContain("GPT-5.6 Luna");

  option.click();
  await vi.waitFor(() =>
    expect(controls.patch).toHaveBeenCalledWith(
      DOCK,
      { model: "openai/gpt-5.6-sol" },
      expect.objectContaining({ expectedSessionId: "dock-1" }),
    ),
  );
  expect(controls.onPluginError).not.toHaveBeenCalled();
});

it("shows a conversation that does not exist yet disabled with the plugin's reason", async () => {
  const controls = await mountSessionControls(null, {
    sessionKey: null,
    disabledReason: "Model and thinking can be changed once the first turn creates it.",
  });
  expect(controls.observeRow).not.toHaveBeenCalled();
  expect(controls.trigger.matches(":disabled, [aria-disabled=true]")).toBe(true);
  controls.container
    .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-5.6-sol"]')
    ?.click();
  expect(controls.patch).not.toHaveBeenCalled();
});
