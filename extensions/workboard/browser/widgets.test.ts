import type { ControlUiDictationControlProps } from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { installDomComponents } from "./test/dom-host.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";
import { voiceGateButton } from "./test/voice-gate.ts";
import { createWorkboardWidget } from "./widgets.tsx";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

function mountWidget(canMutate = true, presented = true) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const initialListeners = new Set(fixture.listeners);
  const card = createWorkboardCard();
  const request = vi.fn(async () => ({ cards: [card] }));
  fixture.host.request = request as typeof fixture.host.request;
  const container = document.createElement("div");
  document.body.append(container);
  const context = createViewContext(
    fixture.host,
    {
      sessionKey: "main",
      widget: { name: "Card", props: { cardId: card.id } },
      canMutate,
      canGrant: true,
    },
    presented,
  );
  const mounted = createWorkboardWidget(fixture.host, "card")(container, context);
  disposers.push(() => mounted?.dispose?.());
  return { fixture, request, card, container, context, mounted, initialListeners };
}

it("renders the public card widget with read-only status controls", async () => {
  const widget = mountWidget(false);
  await vi.waitFor(() => expect(widget.container.textContent).toContain(widget.card.title));
  const select = widget.container.querySelector("select");
  expect(select?.disabled).toBe(true);
  select!.value = "done";
  select!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(widget.request.mock.calls).toHaveLength(1);
});

it("starts visible widgets and releases hidden widget subscriptions", async () => {
  const widget = mountWidget(true, false);
  expect(widget.request).not.toHaveBeenCalled();
  widget.mounted?.update?.({ ...widget.context, presented: true });
  await vi.waitFor(() => expect(widget.container.textContent).toContain(widget.card.title));
  const select = widget.container.querySelector("select")!;
  const count = widget.request.mock.calls.length;
  widget.mounted?.update?.({ ...widget.context, presented: false });
  flush();
  expect(widget.container.querySelector("select")).toBe(select);
  expect(select.disabled).toBe(true);
  select.value = "done";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(widget.request).toHaveBeenCalledTimes(count);
  expect(widget.fixture.listeners).toEqual(widget.initialListeners);
  expect(widget.fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
  widget.fixture.emit("plugin.workboard.changed", {});
  expect(widget.request).toHaveBeenCalledTimes(count);
  widget.mounted?.update?.({ ...widget.context, presented: true });
  await vi.waitFor(() => expect(widget.request).toHaveBeenCalledTimes(count + 1));
});

it("offers retry after an owner request fails, then replaces the error with cards", async () => {
  const widget = mountWidget(true, false);
  widget.request.mockRejectedValueOnce(new Error("Catalog temporarily unavailable"));
  widget.mounted?.update?.({ ...widget.context, presented: true });
  await vi.waitFor(() =>
    expect(widget.container.textContent).toContain("Catalog temporarily unavailable"),
  );
  widget.container.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(widget.container.textContent).toContain(widget.card.title));
  expect(widget.container.querySelector('[role="alert"]')).toBeNull();
});

it("sends a board widget voice turn about its configured board", async () => {
  const fixture = workboardTestHost();
  installDomComponents(fixture.host);
  fixture.connection.connected = true;
  const card = createWorkboardCard();
  const request = vi.fn(async (method: string) =>
    method === "workboard.cards.list"
      ? {
          cards: [card],
          boards: [
            { id: "release", name: "Release", total: 1, active: 1, archived: 0, byStatus: {} },
          ],
        }
      : {},
  );
  fixture.host.request = request as typeof fixture.host.request;
  const openSession = vi.fn();
  Object.assign(fixture.host, { dock: { openSession, close: vi.fn(), openSessionKey: null } });
  vi.mocked(fixture.host.sessions.create).mockResolvedValue("agent:main:widget-voice");
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = createWorkboardWidget(fixture.host, "board")(
    container,
    createViewContext(fixture.host, {
      sessionKey: "main",
      widget: { name: "Board", props: { boardId: "release" } },
      canMutate: false,
      canGrant: false,
    }),
  );
  disposers.push(() => mounted?.dispose?.());
  const microphone = await vi.waitFor(() => {
    const element = container.querySelector<
      HTMLButtonElement & { props: ControlUiDictationControlProps }
    >(".workboard-widget-board__header [data-test-dictation]");
    expect(element).not.toBeNull();
    return element!;
  });

  microphone.props.onStart?.();
  microphone.props.onTranscript("move the release card to review");
  await vi.waitFor(() => {
    flush();
    voiceGateButton("Send").click();
  });

  const context = { page: "workboard", detail: { boardId: "release", boardKind: "cards" } };
  await vi.waitFor(() =>
    expect(openSession).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:main:widget-voice",
      agentId: "main",
      label: "Workboard · Release",
      context,
    }),
  );
  expect(request).toHaveBeenCalledWith("chat.send", {
    sessionKey: "agent:main:widget-voice",
    message: "move the release card to review",
    idempotencyKey: expect.any(String),
    workContext: context,
  });
});
