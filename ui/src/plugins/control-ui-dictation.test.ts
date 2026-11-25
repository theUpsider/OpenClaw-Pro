/* @vitest-environment jsdom */

import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiDictationControlProps } from "../../../src/plugin-sdk/control-ui-components.js";
import type * as ComposerDictationModule from "../pages/chat/composer-dictation.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

const harness = vi.hoisted(() => ({
  controllers: [] as Array<{
    active: boolean;
    options: { enabled: boolean; onCommit: (text: string) => void; onStateChange: () => void };
    startDirect: ReturnType<typeof vi.fn>;
  }>,
  transcript: "  move the release card to review  ",
}));

// The canonical controller owns capture and transcription; this seam stands in
// for the microphone so the test observes only the host wiring around it.
vi.mock("../pages/chat/composer-dictation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof ComposerDictationModule>()),
  ComposerDictationController: class {
    active = false;
    connecting = false;
    finalizing = false;
    arming = false;
    transcript = "";
    get locksComposer() {
      return this.active;
    }
    constructor(public options: (typeof harness.controllers)[number]["options"]) {
      harness.controllers.push(this as never);
    }
    update(options: (typeof harness.controllers)[number]["options"]) {
      this.options = options;
    }
    startDirect = vi.fn(() => {
      if (!this.options.enabled) {
        return false;
      }
      this.active = true;
      this.options.onStateChange();
      return true;
    });
    handleClick = vi.fn(() => {
      this.active = false;
      this.options.onCommit(harness.transcript);
      this.options.onStateChange();
    });
    handleContextMenu() {}
    dispose() {
      this.active = false;
      this.options.onStateChange();
    }
  },
}));

vi.mock("../pages/chat/composer-microphone-picker.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pages/chat/composer-microphone-picker.ts")>()),
  ComposerMicrophonePicker: class {
    devices = [];
    loading = false;
    open = false;
    issue = null;
    realtimeStatus = "ready";
    dictationStatus = "ready";
    syncCatalog() {}
    handleOpen() {}
    handleClose() {}
    dispose() {}
  },
}));

beforeEach(() => {
  harness.controllers = [];
});

async function mountDictation(props: Partial<ControlUiDictationControlProps> = {}) {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  const context = createContext(gateway.gateway, createSessions("main", []));
  const lifetime = new AbortController();
  const onError = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const callbacks = {
    onStart: vi.fn(),
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onStateChange: vi.fn(),
  };
  const handle = createControlUiComponents({
    current: () => context,
    signal: lifetime.signal,
    onError,
  }).mountDictationControl(container, {
    enabled: true,
    accessibleLabel: "Talk to the board",
    ...callbacks,
    ...props,
  });
  onTestFinished(() => {
    lifetime.abort();
    container.remove();
  });
  await vi.dynamicImportSettled();
  const microphone = await vi.waitFor(() => {
    expect(onError).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>(".chat-send-btn--voice");
    expect(button).not.toBeNull();
    return button!;
  });
  return { container, handle, microphone, callbacks, onError, gateway };
}

it("runs the composer's direct dictation and hands the plugin one trimmed transcript", async () => {
  const { container, handle, microphone, callbacks, onError } = await mountDictation();

  expect(microphone.getAttribute("aria-label")).toBe("Talk to the board");
  microphone.click();

  expect(callbacks.onStart).toHaveBeenCalledOnce();
  expect(harness.controllers[0]?.startDirect).toHaveBeenCalledOnce();
  expect(callbacks.onStateChange).toHaveBeenLastCalledWith({ active: true });
  const stop = await vi.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>(".chat-send-btn--dictating");
    expect(button).not.toBeNull();
    return button!;
  });
  stop.click();

  expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith("move the release card to review");
  expect(callbacks.onStateChange).toHaveBeenLastCalledWith({ active: false });

  harness.transcript = "   ";
  container.querySelector<HTMLButtonElement>(".chat-send-btn--voice")?.click();
  container.querySelector<HTMLButtonElement>(".chat-send-btn--dictating")?.click();
  expect(callbacks.onTranscript).toHaveBeenCalledOnce();
  harness.transcript = "  move the release card to review  ";

  const stateChanges = callbacks.onStateChange.mock.calls.length;
  handle.dispose();
  expect(container.childElementCount).toBe(0);
  expect(callbacks.onStateChange).toHaveBeenCalledTimes(stateChanges);
  expect(onError).not.toHaveBeenCalled();
});

it("renders the disabled reason and never starts capture while disabled", async () => {
  const { microphone, callbacks } = await mountDictation({
    enabled: false,
    disabledReason: "Reconnect to dictate.",
  });

  expect(microphone.disabled).toBe(true);
  expect(
    (microphone.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
      ?.content,
  ).toBe("Reconnect to dictate.");
  expect(callbacks.onTranscript).not.toHaveBeenCalled();
});

it("follows Gateway reconnects instead of keeping the mount-time client", async () => {
  const { container, gateway } = await mountDictation();
  const element = container.querySelector("openclaw-plugin-dictation-control")!;
  const original = gateway.gateway.snapshot.client;
  expect(element.connected).toBe(true);

  gateway.publish({ phase: "connecting", client: null });
  expect(element.connected).toBe(false);
  expect(element.client).toBeNull();

  const reconnected = createTestGatewayClient(async () => ({}));
  gateway.publish({ phase: "connected", client: reconnected });
  expect(element.connected).toBe(true);
  expect(element.client).toBe(reconnected);
  expect(element.client).not.toBe(original);
});
