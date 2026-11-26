import { assert, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeEmptyPayloadForDelivery } from "./deliver-payload.js";
import { prepareOutboundPayloadBatch } from "./deliver-prepare.js";

const metadata = { precedingInputAnswer: true } as const;
const voice = { text: " \n ", mediaUrl: "https://example.test/voice.ogg", audioAsVoice: true };

describe("outbound preparation metadata", () => {
  it.each([
    ["flattened details", "<details><summary>More</summary>Body</details>", "**More**\n\nBody"],
    ["changed sanitized text", "Before.", "After."],
    ["unchanged sanitized text", "Ready café 世界.", "Ready café 世界."],
    ["message hook visible-text rewrite", "Before.", "After."],
    ["message hook spoken-text rewrite", "Before.", "After."],
  ])("preserves reply metadata through %s", async (name, before, after) => {
    const spoken = name === "message hook spoken-text rewrite";
    const hooked = name.startsWith("message hook");
    const payload: ReplyPayload = spoken ? { ...voice, spokenText: before } : { text: before };
    const expectedPayload = spoken ? { ...voice, text: "", spokenText: after } : { text: after };
    const input = setReplyPayloadMetadata({ ...payload }, metadata);
    const deliveryInput = spoken ? normalizeEmptyPayloadForDelivery(input) : input;
    assert(deliveryInput);
    if (spoken) {
      expect(deliveryInput).toEqual({ ...payload, text: "" });
    }
    const send = vi.fn(async () => {
      throw new Error("Preparation must not send to the transport");
    });
    const plugin = createOutboundTestPlugin({
      id: "metadata-test",
      outbound: {
        deliveryMode: "direct",
        sendText: send,
        sendMedia: send,
        ...(name === "flattened details" ? {} : { preserveMarkdownDetails: () => true }),
        ...(name.includes("sanitized") ? { sanitizeText: () => after } : {}),
      },
    });
    const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
    if (hooked) {
      addTestHook({
        registry,
        pluginId: plugin.id,
        hookName: "message_sending",
        handler: () => ({ content: after }),
      });
    }
    const batch = await withPluginRuntimeRegistryScope(registry, () =>
      prepareOutboundPayloadBatch(
        { cfg: {}, channel: plugin.id, to: "test-recipient", payloads: [deliveryInput] },
        { hookRunner: createHookRunner(registry) },
      ),
    );
    expect(batch.entries).toHaveLength(1);
    const entry = batch.entries[0];
    assert(entry?.status === "accepted", "Expected one accepted payload");
    expect(entry.payload).toEqual(expectedPayload);
    expect(getReplyPayloadMetadata(entry.payload)).toEqual(metadata);
    expect(input).toEqual(payload);
    expect(getReplyPayloadMetadata(input)).toEqual(metadata);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { name: "fails open by default", failurePolicy: undefined, expectedStatus: "accepted" },
    {
      name: "suppresses the send on a fail-closed guard",
      failurePolicy: "fail-closed",
      expectedStatus: "suppressed",
    },
  ] as const)("$name when the outbound guard throws", async ({ failurePolicy, expectedStatus }) => {
    const send = vi.fn(async () => {
      throw new Error("Preparation must not send to the transport");
    });
    const plugin = createOutboundTestPlugin({
      id: "guard-outage-test",
      outbound: { deliveryMode: "direct", sendText: send, sendMedia: send },
    });
    const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
    addTestHook({
      registry,
      pluginId: plugin.id,
      hookName: "message_sending",
      ...(failurePolicy ? { failurePolicy } : {}),
      handler: () => {
        throw new Error("guard gateway unreachable");
      },
    });

    const batch = await withPluginRuntimeRegistryScope(registry, () =>
      prepareOutboundPayloadBatch(
        { cfg: {}, channel: plugin.id, to: "test-recipient", payloads: [{ text: "guarded" }] },
        { hookRunner: createHookRunner(registry) },
      ),
    );

    const entry = batch.entries[0];
    if (expectedStatus === "suppressed") {
      // A fail-closed guard must deny the send instead of shipping unguarded content.
      expect(entry).toEqual({
        sourceIndex: 0,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
        hookEffect: {
          cancelReason: "plugin_hook_failed_closed",
          metadata: { hookName: "message_sending", pluginId: plugin.id },
        },
      });
    } else {
      expect(entry).toMatchObject({ sourceIndex: 0, status: "accepted" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses only the payload whose fail-closed reply_payload_sending guard times out", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => {
        throw new Error("Preparation must not send to the transport");
      });
      const plugin = createOutboundTestPlugin({
        id: "reply-guard-timeout-test",
        outbound: { deliveryMode: "direct", sendText: send, sendMedia: send },
      });
      const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
      addTestHook({
        registry,
        pluginId: plugin.id,
        hookName: "reply_payload_sending",
        failurePolicy: "fail-closed",
        timeoutMs: 50,
        handler: (event: { payload: ReplyPayload }) =>
          event.payload.text === "stalls" ? new Promise<never>(() => {}) : undefined,
      });

      const preparing = withPluginRuntimeRegistryScope(registry, () =>
        prepareOutboundPayloadBatch(
          {
            cfg: {},
            channel: plugin.id,
            to: "test-recipient",
            payloads: [{ text: "stalls" }, { text: "passes" }],
            replyPayloadSendingHook: { kind: "final", context: { channelId: plugin.id } },
          },
          { hookRunner: createHookRunner(registry) },
        ),
      );
      await vi.advanceTimersByTimeAsync(60);
      const batch = await preparing;

      expect(batch.entries).toEqual([
        {
          sourceIndex: 0,
          status: "suppressed",
          reason: "cancelled_by_reply_payload_sending_hook",
          hookEffect: {
            cancelReason: "plugin_hook_failed_closed",
            metadata: { hookName: "reply_payload_sending", pluginId: plugin.id },
          },
        },
        expect.objectContaining({
          sourceIndex: 1,
          status: "accepted",
          payload: { text: "passes" },
        }),
      ]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses whitespace-only payloads without mutating the source", () => {
    const input = setReplyPayloadMetadata({ text: " \n " }, metadata);
    expect(normalizeEmptyPayloadForDelivery(input)).toBeNull();
    expect(input.text).toBe(" \n ");
    expect(getReplyPayloadMetadata(input)).toEqual(metadata);
  });
});
