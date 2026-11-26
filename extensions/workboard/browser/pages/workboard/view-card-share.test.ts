import "../../test/dom.setup.ts";
import type { ChannelsStatusResult } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/web";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { CardArtifacts } from "./view-card-artifacts.tsx";
import { createWorkboardView, type SelectPicker } from "./view.test-support.ts";

// Test names map to docs/ui/screen-state-matrix.md ("Artefakt teilen").

const twoChannels: ChannelsStatusResult = {
  ts: 1,
  channelOrder: ["whatsapp", "telegram"],
  channelLabels: { whatsapp: "WhatsApp", telegram: "Telegram" },
  channels: {},
  channelAccounts: {
    whatsapp: [{ accountId: "personal", name: "Personal" }],
    telegram: [
      { accountId: "bot", name: "Bot" },
      { accountId: "work", name: "Work" },
    ],
  },
  channelDefaultAccountId: { whatsapp: "personal", telegram: "work" },
};

const artifactCard = createWorkboardCard({
  status: "done",
  agentId: "b",
  metadata: {
    artifacts: [
      { id: "a1", createdAt: 1, label: "Demo", path: "/workspace/out/demo.mp4" },
      { id: "a2", createdAt: 1, url: "https://example.test/report" },
    ],
    attachments: [{ id: "f1", cardId: "card-1", createdAt: 1, fileName: "log.txt", byteSize: 10 }],
  },
});

type Responses = {
  channels?: () => unknown;
  send?: () => unknown;
  directory?: () => unknown;
};

let disposeRoot: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposeRoot?.();
  disposeRoot = undefined;
  vi.useRealTimers();
});

function mountShare(
  options: {
    responses?: Responses;
    canWrite?: boolean;
    canAdmin?: boolean;
    online?: boolean;
    card?: WorkboardCard;
  } = {},
) {
  const { host } = workboardTestHost();
  Object.assign(host.connection, { canAdmin: options.canAdmin ?? false });
  const responses = options.responses ?? {};
  const request = vi.mocked(host.request);
  request.mockClear();
  request.mockImplementation(async (method) => {
    if (method === "workboard.artifacts.fileAccess") {
      // The rows that carry a path ask once per card; this fixture approves nothing.
      return { files: {} } as never;
    }
    if (method === "channels.status") {
      return (responses.channels?.() ?? twoChannels) as never;
    }
    if (method === "conversations.list") {
      return (responses.directory?.() ?? { conversations: [] }) as never;
    }
    if (method === "send") {
      return (responses.send?.() ?? { ok: true }) as never;
    }
    throw new Error(`unexpected ${method}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  disposeRoot = render(
    () =>
      createComponent(CardArtifacts, {
        card: options.card ?? artifactCard,
        onNavigate: () => undefined,
        workboard: {
          client: options.online === false ? null : host,
          canWrite: options.canWrite ?? true,
          controlUi: host,
          scopeAgentId: "main",
        },
      }),
    container,
  );
  const dialog = () => container.querySelector<HTMLElement>("[data-test-dialog]");
  const inDialog = () => expectDefined(dialog(), "share dialog");
  const view = {
    request,
    container,
    dialog,
    rows: () => [...container.querySelectorAll<HTMLElement>(".workboard-artifacts__row")],
    shareButtons: () => [
      ...container.querySelectorAll<HTMLButtonElement>("button[aria-haspopup=dialog]"),
    ],
    pickers: () => [...inDialog().querySelectorAll<SelectPicker>("[data-test-select-picker]")],
    field: () => expectDefined(inDialog().querySelector<HTMLInputElement>("input"), "recipient"),
    sendButton: () =>
      expectDefined(inDialog().querySelector<HTMLButtonElement>("button[type=submit]"), "Send"),
    reason: () => inDialog().querySelector(".workboard-share__reason")?.textContent ?? "",
    alert: () => inDialog().querySelector("[role=alert]")?.textContent,
    preview: () => inDialog().querySelector(".workboard-share__message")?.textContent,
    receipt: () => container.querySelector(".workboard-artifacts__feedback")?.textContent,
    calls: (method: string) => request.mock.calls.filter(([name]) => name === method),
    settle: () => afterWorkboardUpdate(() => undefined),
    async open(index = 0) {
      await this.settle();
      expectDefined(this.shareButtons()[index], "share action").click();
      await this.settle();
      await this.settle();
    },
    async type(value: string) {
      const input = this.field();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await this.settle();
    },
    async submit() {
      this.sendButton().click();
      await this.settle();
      await this.settle();
    },
    async cancelEvent() {
      const event = new Event("cancel", { cancelable: true });
      inDialog().dispatchEvent(event);
      await this.settle();
      return event;
    },
  };
  return view;
}

it("offers the share action only on rows with a URL or path, and only while connected", async () => {
  const view = mountShare();
  await view.settle();
  expect(view.rows()).toHaveLength(3);
  expect(view.shareButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
    "Share Demo",
    "Share report",
  ]);
  expect(view.rows()[2]?.querySelector("button[aria-haspopup=dialog]")).toBeNull();
  // Nothing but the one path-artifact approval read happens before the dialog opens.
  expect(view.request.mock.calls.map(([method]) => method)).toEqual([
    "workboard.artifacts.fileAccess",
  ]);
  disposeRoot?.();
  const offline = mountShare({ online: false });
  await offline.settle();
  expect(offline.shareButtons()).toHaveLength(0);
});

it("loading channels: shows the loading line and blocks Send", async () => {
  const view = mountShare({
    responses: {
      channels: () =>
        new Promise(() => {
          // Never settles: the dialog stays in its loading state.
        }),
    },
  });
  await view.open();
  expect(view.preview()).toBe("Demo\n/workspace/out/demo.mp4");
  expect(view.reason()).toBe("Loading channels…");
  expect(view.sendButton().disabled).toBe(true);
  expect(view.pickers()).toHaveLength(0);
});

it("no channels: explains why Send is blocked", async () => {
  const view = mountShare({
    responses: { channels: () => ({ ...twoChannels, channelOrder: [] }) },
  });
  await view.open();
  await view.type("+15551234567");
  expect(view.reason()).toBe(
    "No channel is set up for sending. Set one up under Channels, then try again.",
  );
  expect(view.sendButton().disabled).toBe(true);
  expect(view.sendButton().getAttribute("aria-describedby")).toBeTruthy();
});

it("channel list failure: shows the error and blocks Send", async () => {
  const view = mountShare({
    responses: {
      channels: () => {
        throw new Error("missing scope: operator.read");
      },
    },
  });
  await view.open();
  await view.type("+15551234567");
  expect(view.alert()).toBe("Could not load channels: missing scope: operator.read");
  expect(view.sendButton().disabled).toBe(true);
});

it("empty recipient blocks Send with a reason and makes no request", async () => {
  const view = mountShare();
  await view.open();
  expect(view.reason()).toBe("Enter a recipient to send.");
  expect(view.sendButton().disabled).toBe(true);
  await view.type("   ");
  view.sendButton().closest("form")?.requestSubmit();
  await view.settle();
  expect(view.calls("send")).toHaveLength(0);
});

it("read-only: blocks Send with a visible reason and makes no request", async () => {
  const view = mountShare({ canWrite: false });
  await view.open();
  await view.type("+15551234567");
  expect(view.reason()).toBe("This connection is read-only. Sending needs write access.");
  expect(view.sendButton().disabled).toBe(true);
  view.sendButton().closest("form")?.requestSubmit();
  await view.settle();
  expect(view.calls("send")).toHaveLength(0);
});

it("sends once: exactly one text-only send, closes, and shows the receipt at the row", async () => {
  const view = mountShare();
  await view.open();
  await view.type("+15551234567");
  expect(view.reason()).toBe("");
  await view.submit();
  expect(view.calls("send")).toEqual([
    [
      "send",
      {
        channel: "whatsapp",
        accountId: "personal",
        to: "+15551234567",
        message: "Demo\n/workspace/out/demo.mp4",
        idempotencyKey: expect.any(String),
      },
    ],
  ]);
  expect(view.calls("conversations.send")).toHaveLength(0);
  expect(
    view.request.mock.calls.every(
      ([method]) => method === "workboard.artifacts.fileAccess" || !method.startsWith("workboard."),
    ),
  ).toBe(true);
  expect(view.dialog()).toBeNull();
  expect(view.receipt()).toBe("Sent to +15551234567 via WhatsApp.");
  expect(view.container.querySelector(".workboard-artifacts__feedback")?.getAttribute("role")).toBe(
    "status",
  );
});

it("changing the channel or account sends nothing", async () => {
  const view = mountShare();
  await view.open();
  await view.type("+15551234567");
  expectDefined(view.pickers()[0], "channel picker").onSelect("telegram");
  await view.settle();
  expect(view.calls("send")).toHaveLength(0);
  expectDefined(view.pickers()[1], "account picker").onSelect("bot");
  await view.settle();
  expect(view.calls("send")).toHaveLength(0);
  expect(view.dialog()).not.toBeNull();
});

it("several accounts: shows the account picker with the default chosen and sends that account", async () => {
  const view = mountShare();
  await view.open();
  expect(view.pickers()).toHaveLength(1);
  expectDefined(view.pickers()[0], "channel picker").onSelect("telegram");
  await view.settle();
  const account = expectDefined(view.pickers()[1], "account picker");
  expect(account.value).toBe("work");
  expect(account.options.map((option) => option.label)).toEqual(["Bot", "Work"]);
  await view.type("@alex");
  await view.submit();
  expect(view.calls("send")[0]?.[1]).toMatchObject({ channel: "telegram", accountId: "work" });
});

it("send failure keeps the dialog, recipient and channel and allows a retry with a new key", async () => {
  let fail = true;
  const view = mountShare({
    responses: {
      send: () => {
        if (fail) {
          throw new Error("unknown recipient");
        }
        return { ok: true };
      },
    },
  });
  await view.open();
  expectDefined(view.pickers()[0], "channel picker").onSelect("telegram");
  await view.settle();
  await view.type("@nobody");
  await view.submit();
  expect(view.dialog()).not.toBeNull();
  expect(view.alert()).toBe(
    "Could not send: unknown recipient. The recipient and channel are kept; try again.",
  );
  expect(view.field().value).toBe("@nobody");
  expect(view.pickers()[0]?.value).toBe("telegram");
  expect(view.sendButton().disabled).toBe(false);
  fail = false;
  await view.submit();
  const keys = view
    .calls("send")
    .map(([, params]) => (params as { idempotencyKey: string }).idempotencyKey);
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(2);
  expect(view.dialog()).toBeNull();
  expect(view.receipt()).toBe("Sent to @nobody via Telegram.");
});

it("sending: Send shows Sending… and is disabled; a second click and Escape do nothing", async () => {
  let resolveSend: (value: unknown) => void = () => undefined;
  const view = mountShare({
    responses: {
      send: () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    },
  });
  await view.open();
  await view.type("+15551234567");
  await view.submit();
  expect(view.sendButton().textContent).toBe("Sending…");
  expect(view.sendButton().disabled).toBe(true);
  expect(view.field().disabled).toBe(true);
  expect(view.reason()).toBe("Sending…");
  view.sendButton().closest("form")?.requestSubmit();
  expect((await view.cancelEvent()).defaultPrevented).toBe(true);
  expect(view.calls("send")).toHaveLength(1);
  resolveSend({ ok: true });
  await view.settle();
  await view.settle();
  expect(view.dialog()).toBeNull();
});

it("cancel and Escape close without a request", async () => {
  const view = mountShare();
  await view.open();
  await view.type("+15551234567");
  const cancel = [...expectDefined(view.dialog(), "dialog").querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  );
  expectDefined(cancel, "Cancel").click();
  await view.settle();
  expect(view.dialog()).toBeNull();
  await view.open();
  expect((await view.cancelEvent()).defaultPrevented).toBe(false);
  expect(view.dialog()).toBeNull();
  expect(view.calls("send")).toHaveLength(0);
  expect(view.receipt()).toBeUndefined();
});

it("suggestions: only with admin access; a failed directory shows no error", async () => {
  const writer = mountShare({ canAdmin: false });
  await writer.open();
  expect(writer.calls("conversations.list")).toHaveLength(0);
  expect(writer.field().getAttribute("list")).toBeNull();
  disposeRoot?.();

  const admin = mountShare({
    canAdmin: true,
    responses: {
      directory: () => ({
        conversations: [
          {
            conversationRef: "c1",
            channel: "whatsapp",
            accountId: "personal",
            kind: "direct",
            target: "+4915700000000",
            label: "Alex",
            firstSeenAt: 1,
            lastSeenAt: 2,
          },
        ],
      }),
    },
  });
  await admin.open();
  expect(admin.calls("conversations.list")[0]?.[1]).toEqual({
    agentId: "main",
    channel: "whatsapp",
    limit: 100,
  });
  const listId = expectDefined(admin.field().getAttribute("list"), "datalist id");
  expect(document.getElementById(listId)?.querySelector("option")?.getAttribute("value")).toBe(
    "+4915700000000",
  );
  disposeRoot?.();

  const broken = mountShare({
    canAdmin: true,
    responses: {
      directory: () => {
        throw new Error("directory offline");
      },
    },
  });
  await broken.open();
  await broken.type("+15551234567");
  expect(broken.calls("conversations.list")).toHaveLength(1);
  expect(broken.alert()).toBeUndefined();
  expect(broken.sendButton().disabled).toBe(false);
});

it("card drawer shares through the operator's client with the scope agent's directory", async () => {
  const { host } = workboardTestHost();
  const request = vi.mocked(host.request);
  request.mockImplementation(async (method) =>
    method === "channels.status"
      ? (twoChannels as never)
      : method === "conversations.list"
        ? ({ conversations: [] } as never)
        : ({} as never),
  );
  const { state, container, renderView } = createWorkboardView({
    client: host,
    controlUi: host,
    scopeAgentId: "c",
  });
  state.cards = [artifactCard];
  state.detailCardId = artifactCard.id;
  renderView();
  await afterWorkboardUpdate(() => undefined);
  const share = expectDefined(
    container.querySelector<HTMLButtonElement>(
      ".workboard-detail__content .workboard-artifacts button[aria-haspopup=dialog]",
    ),
    "share action in the drawer",
  );
  share.click();
  await afterWorkboardUpdate(() => undefined);
  await afterWorkboardUpdate(() => undefined);
  expect(request).toHaveBeenCalledWith("channels.status", { probe: false, timeoutMs: 8000 });
  expect(request).toHaveBeenCalledWith("conversations.list", {
    agentId: "c",
    channel: "whatsapp",
    limit: 100,
  });
});
