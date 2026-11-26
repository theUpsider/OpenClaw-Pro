import "../../test/host.setup.ts";
import type { ChannelsStatusResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  buildShareMessage,
  canShareArtifactRow,
  loadShareSuggestions,
  sendArtifactShare,
  shareableChannels,
} from "./share-channel.ts";

function snapshot(overrides: Partial<ChannelsStatusResult> = {}): ChannelsStatusResult {
  return {
    ts: 1,
    channelOrder: [],
    channelLabels: {},
    channels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
    ...overrides,
  };
}

function requestClient(implementation: (method: string, params?: unknown) => unknown) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) =>
    implementation(method, params),
  );
  return { client: { request: request as never }, request };
}

describe("buildShareMessage", () => {
  it("puts the label above the reference", () => {
    expect(
      buildShareMessage({ label: "Demo video", reference: "/workspace/demo.mp4" }),
    ).toBe("Demo video\n/workspace/demo.mp4");
    expect(buildShareMessage({ label: "Report", href: "https://example.test/report" })).toBe(
      "Report\nhttps://example.test/report",
    );
  });

  it("sends a label equal to the reference once", () => {
    expect(buildShareMessage({ label: "s3://bucket/a.txt", reference: "s3://bucket/a.txt" })).toBe(
      "s3://bucket/a.txt",
    );
  });

  it("prefers the web URL over the host path", () => {
    expect(
      buildShareMessage({
        label: "Build",
        href: "https://example.test/build",
        reference: "/srv/build.log",
      }),
    ).toBe("Build\nhttps://example.test/build");
  });
});

describe("canShareArtifactRow", () => {
  it("accepts href and reference rows and rejects bare attachments", () => {
    expect(canShareArtifactRow({ label: "a", href: "https://example.test/a" })).toBe(true);
    expect(canShareArtifactRow({ label: "b", reference: "/srv/b.png" })).toBe(true);
    expect(canShareArtifactRow({ label: "notes.pdf" })).toBe(false);
    expect(canShareArtifactRow({ label: "blank", reference: "  " })).toBe(false);
  });
});

describe("shareableChannels", () => {
  it("drops disabled and unconfigured accounts and channels without accounts", () => {
    const channels = shareableChannels(
      snapshot({
        channelOrder: ["whatsapp", "telegram", "signal"],
        channelLabels: { whatsapp: "WhatsApp", telegram: "Telegram", signal: "Signal" },
        channelAccounts: {
          whatsapp: [
            { accountId: "personal", name: "Personal" },
            { accountId: "old", enabled: false },
          ],
          telegram: [{ accountId: "bot", configured: false }],
          signal: [],
        },
        channelDefaultAccountId: { whatsapp: "personal" },
      }),
    );
    expect(channels).toEqual([
      {
        id: "whatsapp",
        label: "WhatsApp",
        accounts: [{ id: "personal", label: "Personal" }],
        defaultAccountId: "personal",
        needsAccountChoice: false,
      },
    ]);
  });

  it("selects the default account and asks for a choice with several accounts", () => {
    const [telegram] = shareableChannels(
      snapshot({
        channelOrder: ["telegram"],
        channelLabels: { telegram: "Telegram" },
        channelAccounts: {
          telegram: [{ accountId: "first" }, { accountId: "work", name: "Work" }],
        },
        channelDefaultAccountId: { telegram: "work" },
      }),
    );
    expect(telegram?.defaultAccountId).toBe("work");
    expect(telegram?.needsAccountChoice).toBe(true);
  });

  it("falls back to the first usable account when the default is unusable", () => {
    const [channel] = shareableChannels(
      snapshot({
        channelOrder: ["slack"],
        channelLabels: {},
        channelAccounts: { slack: [{ accountId: "a" }, { accountId: "b", enabled: false }] },
        channelDefaultAccountId: { slack: "b" },
      }),
    );
    expect(channel).toMatchObject({ label: "slack", defaultAccountId: "a" });
  });

  it("returns no channels for an empty snapshot", () => {
    expect(shareableChannels(snapshot())).toEqual([]);
    expect(shareableChannels(null)).toEqual([]);
  });
});

describe("loadShareSuggestions", () => {
  it("only asks conversations.list with admin access", async () => {
    const { client, request } = requestClient(() => ({ conversations: [] }));
    await expect(
      loadShareSuggestions({ client, canAdmin: false, agentId: "main", channel: "whatsapp" }),
    ).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("filters to the chosen channel and account and drops duplicates", async () => {
    const entry = { kind: "direct", firstSeenAt: 1, lastSeenAt: 2 } as const;
    const { client, request } = requestClient(() => ({
      conversations: [
        { ...entry, conversationRef: "c1", channel: "whatsapp", accountId: "a", target: "+491" },
        { ...entry, conversationRef: "c2", channel: "whatsapp", accountId: "a", target: "+491" },
        { ...entry, conversationRef: "c3", channel: "whatsapp", accountId: "b", target: "+492" },
        { ...entry, conversationRef: "c4", channel: "telegram", accountId: "a", target: "@x" },
        {
          ...entry,
          conversationRef: "c5",
          channel: "whatsapp",
          accountId: "a",
          target: "+493",
          label: "Alex",
        },
      ],
    }));
    await expect(
      loadShareSuggestions({
        client,
        canAdmin: true,
        agentId: "main",
        channel: "whatsapp",
        accountId: "a",
      }),
    ).resolves.toEqual([{ value: "+491" }, { value: "+493", label: "Alex" }]);
    expect(request).toHaveBeenCalledExactlyOnceWith("conversations.list", {
      agentId: "main",
      channel: "whatsapp",
      limit: 100,
    });
  });

  it("swallows directory failures", async () => {
    const { client } = requestClient(() => {
      throw new Error("missing scope: operator.admin");
    });
    await expect(
      loadShareSuggestions({ client, canAdmin: true, agentId: "main", channel: "whatsapp" }),
    ).resolves.toEqual([]);
  });
});

describe("sendArtifactShare", () => {
  it("makes exactly one text-only send request", async () => {
    const { client, request } = requestClient(() => ({ ok: true }));
    await expect(
      sendArtifactShare({
        client,
        channel: "whatsapp",
        accountId: "personal",
        to: "+15551234567",
        message: "Demo\n/srv/demo.mp4",
      }),
    ).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    const [method, params] = request.mock.calls[0]!;
    expect(method).toBe("send");
    expect(params).toEqual({
      channel: "whatsapp",
      accountId: "personal",
      to: "+15551234567",
      message: "Demo\n/srv/demo.mp4",
      idempotencyKey: expect.any(String),
    });
  });

  it("returns the formatted error and uses a new key per attempt", async () => {
    const { client, request } = requestClient(() => {
      throw new Error("unknown recipient");
    });
    const share = {
      client,
      channel: "whatsapp",
      accountId: "personal",
      to: "+1",
      message: "x",
    };
    await expect(sendArtifactShare(share)).resolves.toEqual({
      ok: false,
      error: "unknown recipient",
    });
    await sendArtifactShare(share);
    const keys = request.mock.calls.map(
      ([, params]) => (params as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
  });
});
