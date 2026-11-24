import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookReplyPayloadSendingContext,
  PluginHookReplyUsageState,
} from "../../plugins/hook-types.js";
import { pluginInvocationContext } from "../../plugins/plugin-instance-scope.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

export async function runReplyPayloadSendingHook(
  params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    channel?: string;
    sessionKey?: string;
    runId?: string;
    usageState?: PluginHookReplyUsageState;
    context: PluginHookReplyPayloadSendingContext;
  },
  hookRunner = getGlobalHookRunner(),
): Promise<ReplyPayload | null> {
  if (!hookRunner?.hasHooks("reply_payload_sending")) {
    return params.payload;
  }

  // Reply drains can outlive the producer's invocation; this dispatch owns fresh
  // plugin calls, not the closed producer's finite scope.
  const result = await pluginInvocationContext.exit(() =>
    hookRunner.runReplyPayloadSending(
      {
        payload: params.payload,
        kind: params.kind,
        channel: params.channel,
        sessionKey: params.sessionKey,
        runId: params.runId,
        usageState: params.usageState,
      },
      params.context,
    ),
  );

  if (result?.cancel) {
    return null;
  }
  const payload = result?.payload ?? params.payload;
  return copyReplyPayloadMetadata(params.payload, payload);
}
