import { getGroupThreadDispatchContext } from "../../auto-reply/group-thread-context.js";
import { copyReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  markReplyDispatchBeforeDeliverDeadlineOwned,
  type ReplyDispatchBeforeDeliver,
} from "../../auto-reply/reply/reply-dispatcher.js";
import { runReplyPayloadSendingHook } from "../../auto-reply/reply/reply-payload-sending-hook.js";
import { consumeReplyUsageState } from "../../auto-reply/reply/reply-usage-state.js";
import type { FinalizedMsgContext, MsgContext } from "../../auto-reply/templating.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
  toPluginMessageContext,
} from "../../hooks/message-hook-mappers.js";
import { hasOutboundReplyContent } from "../../plugin-sdk/reply-payload.js";
import { unwrapHookFailureClosedError } from "../../plugins/hook-failure-policy.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { normalizeEmptyPayloadForDelivery } from "./deliver-payload.js";
import type { OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import type { QueuedReplyPayloadSendingHook } from "./delivery-queue-storage.js";
import {
  summarizeOutboundPayloadForTransport,
  type NormalizedOutboundPayload,
} from "./payloads.js";

/** The legacy `message_sending` stage's result, typed from its only producer. */
type PluginHookMessageSendingResult = Awaited<
  ReturnType<NonNullable<ReturnType<typeof getGlobalHookRunner>>["runMessageSending"]>
>;

export type ReplyPayloadSuppressedObserver = (
  payload: ReplyPayload,
  info: Parameters<ReplyDispatchBeforeDeliver>[1],
  reason: "cancelled_by_reply_payload_sending_hook" | "empty_after_reply_payload_sending_hook",
) => void | Promise<void>;

type PayloadSendingHookResult = {
  cancelled: boolean;
  changed: boolean;
  payload: ReplyPayload;
  hookEffect?: Extract<OutboundPayloadDeliveryOutcome, { status: "suppressed" }>["hookEffect"];
};

/** Suppression reason recorded when a fail-closed hook denies outbound delivery. */
const FAILED_CLOSED_SUPPRESSION_REASON = "plugin_hook_failed_closed";

/** A denied delivery carries no payload; the caller must not fall back to the original. */
type DeniedSendingHookResult = Omit<PayloadSendingHookResult, "payload">;

/**
 * Fail-closed hooks abort their guarded operation. A guard that times out or
 * throws must therefore keep the payload from leaving the Gateway, which the
 * delivery lanes express as a suppression rather than an unguarded send.
 */
function toFailedClosedSuppression(error: unknown): DeniedSendingHookResult | undefined {
  const blocked = unwrapHookFailureClosedError(error);
  if (!blocked) {
    return undefined;
  }
  return {
    cancelled: true,
    changed: false,
    hookEffect: {
      cancelReason: FAILED_CLOSED_SUPPRESSION_REASON,
      metadata: { hookName: blocked.hookName, pluginId: blocked.pluginId },
    },
  };
}

export function buildInboundReplyPayloadSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
  runState: { runId?: string },
  onSuppressed?: ReplyPayloadSuppressedObserver,
): ReplyDispatchBeforeDeliver {
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  return markReplyDispatchBeforeDeliverDeadlineOwned(async (payload, info) => {
    const group = getGroupThreadDispatchContext();
    const deliveryContext = group?.ctx ?? finalized;
    const deliveryHookContext = group ? deriveInboundMessageHookContext(group.ctx) : hookCtx;
    const runId = group ? group.runState.runId : runState.runId;
    let hookedPayload: ReplyPayload | null;
    try {
      hookedPayload = await runReplyPayloadSendingHook({
        payload,
        kind: info.kind,
        channel: deliveryContext.Surface ?? deliveryContext.Provider,
        sessionKey: deliveryContext.SessionKey,
        runId,
        usageState: consumeReplyUsageState(runId),
        context: { ...toPluginMessageContext(deliveryHookContext), runId },
      });
    } catch (error) {
      // A fail-closed guard denies this delivery instead of letting it through;
      // the hook runner already logged which plugin failed closed.
      if (unwrapHookFailureClosedError(error)) {
        await onSuppressed?.(payload, info, "cancelled_by_reply_payload_sending_hook");
        return null;
      }
      throw error;
    }
    if (!hookedPayload) {
      await onSuppressed?.(payload, info, "cancelled_by_reply_payload_sending_hook");
      return null;
    }
    if (!hasOutboundReplyContent(hookedPayload)) {
      await onSuppressed?.(hookedPayload, info, "empty_after_reply_payload_sending_hook");
      return null;
    }
    return hookedPayload;
  });
}

/** Legacy dispatcher-owned `message_sending` stage retained for low-level SDK compatibility. */
export function buildLegacyInboundMessageSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
): ReplyDispatchBeforeDeliver | undefined {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return undefined;
  }
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);
  return markReplyDispatchBeforeDeliverDeadlineOwned(
    async (payload: ReplyPayload): Promise<ReplyPayload | null> => {
      if (!payload.text) {
        return payload;
      }
      const group = getGroupThreadDispatchContext();
      let result: PluginHookMessageSendingResult | undefined;
      try {
        result = await hookRunner.runMessageSending(
          { content: payload.text, to: replyTarget },
          {
            ...toPluginMessageContext(hookCtx),
            ...(group ? { sessionKey: group.ctx.SessionKey, runId: group.runState.runId } : {}),
          },
        );
      } catch (error) {
        // A fail-closed guard denies this delivery instead of letting it through.
        if (unwrapHookFailureClosedError(error)) {
          return null;
        }
        throw error;
      }
      if (result?.cancel) {
        return null;
      }
      return result?.content == null
        ? payload
        : copyReplyPayloadMetadata(payload, { ...payload, text: result.content });
    },
  );
}

/** Run media-aware message policy before a core owner can capture projected output. */
export function buildProjectedInboundMessageSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
): ReplyDispatchBeforeDeliver {
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);
  return markReplyDispatchBeforeDeliverDeadlineOwned(async (payload) => {
    const hookRunner = getGlobalHookRunner();
    // applyMessageSendingHook already maps a fail-closed guard failure to a cancellation.
    const hookResult = await applyMessageSendingHook({
      hookRunner,
      enabled: hookRunner?.hasHooks("message_sending") ?? false,
      payload,
      payloadSummary: summarizeOutboundPayloadForTransport(payload),
      to: replyTarget,
      channel: hookCtx.channelId,
      accountId: hookCtx.accountId,
      replyToId: payload.replyToId ?? finalized.ReplyToIdFull ?? finalized.ReplyToId,
      threadId: finalized.MessageThreadId,
      sessionKey: finalized.SessionKey,
    });
    if (hookResult.cancelled) {
      return null;
    }
    return normalizeEmptyPayloadForDelivery(hookResult.payload);
  });
}

export async function applyMessageSendingHook(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  enabled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
  to: string;
  channel: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  sessionKey?: string;
}): Promise<PayloadSendingHookResult> {
  const unchanged = () => ({
    cancelled: false,
    changed: false,
    payload: params.payload,
  });
  if (!params.enabled) {
    return unchanged();
  }
  try {
    const group = getGroupThreadDispatchContext();
    const sendingResult = await params.hookRunner!.runMessageSending(
      {
        to: params.to,
        content: params.payloadSummary.hookContent ?? params.payloadSummary.text,
        replyToId: params.replyToId ?? undefined,
        threadId: params.threadId ?? undefined,
        metadata: {
          channel: params.channel,
          accountId: params.accountId,
          mediaUrls: params.payloadSummary.mediaUrls,
        },
      },
      {
        channelId: params.channel,
        accountId: params.accountId ?? undefined,
        conversationId: params.to,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(group ? { sessionKey: group.ctx.SessionKey, runId: group.runState.runId } : {}),
      },
    );
    if (sendingResult?.cancel) {
      const { cancelReason, metadata } = sendingResult;
      return {
        ...unchanged(),
        cancelled: true,
        hookEffect:
          cancelReason || metadata
            ? {
                ...(cancelReason ? { cancelReason } : {}),
                ...(metadata ? { metadata } : {}),
              }
            : undefined,
      };
    }
    if (sendingResult?.content == null) {
      return unchanged();
    }
    const spokenOnly = params.payloadSummary.hookContent && !params.payloadSummary.text;
    const payload = copyReplyPayloadMetadata(params.payload, {
      ...params.payload,
      [spokenOnly ? "spokenText" : "text"]: sendingResult.content,
    });
    return {
      cancelled: false,
      changed: true,
      payload,
    };
  } catch (error) {
    // Registrations may opt into fail-closed; then a failed guard must block.
    const denied = toFailedClosedSuppression(error);
    if (denied) {
      return { payload: params.payload, ...denied };
    }
    // Otherwise a hook failure stays non-blocking for outbound delivery.
    return unchanged();
  }
}

export async function applyReplyPayloadSendingHook(
  params: {
    hook: QueuedReplyPayloadSendingHook | undefined;
    payload: ReplyPayload;
  },
  hookRunner = getGlobalHookRunner(),
): Promise<PayloadSendingHookResult> {
  if (!params.hook) {
    return { cancelled: false, payload: params.payload, changed: false };
  }
  let nextPayload: ReplyPayload | null;
  try {
    nextPayload = await runReplyPayloadSendingHook(
      {
        payload: params.payload,
        kind: params.hook.kind,
        ...(params.hook.channel ? { channel: params.hook.channel } : {}),
        ...(params.hook.sessionKey ? { sessionKey: params.hook.sessionKey } : {}),
        ...(params.hook.runId ? { runId: params.hook.runId } : {}),
        context: params.hook.context,
      },
      hookRunner,
    );
  } catch (error) {
    // A fail-closed guard suppresses only this payload; other errors are host
    // invariant failures that the preparation owner attributes and aborts on.
    const denied = toFailedClosedSuppression(error);
    if (denied) {
      return { payload: params.payload, ...denied };
    }
    throw error;
  }
  return {
    cancelled: !nextPayload,
    payload: nextPayload ?? params.payload,
    changed: nextPayload !== null && nextPayload !== params.payload,
  };
}
