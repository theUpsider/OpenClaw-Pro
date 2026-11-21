import type { DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { RuntimeConfig } from "./config.js";
import { decisionFailure } from "./errors.js";

const loadClient = createLazyRuntimeModule(() => import("./client.js"));

/** Translate the host-selected decision contract through the Example transport. */
export function createDecisionProvider(getConfig: () => RuntimeConfig): DecisionProviderV1 {
  return {
    id: "example",
    contractVersion: 1,
    isReady: () => Boolean(getConfig().baseUrl),
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      // Registration and readiness do not need the transport; the cold import
      // only settles on the first evaluation.
      const { evaluate } = await loadClient();
      context.signal.throwIfAborted();
      const config = getConfig();
      const baseUrl = config.baseUrl;
      if (!baseUrl) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const remaining = context.deadlineMonotonicMs - performance.now();
      if (remaining <= 0) {
        return { status: "unavailable", reason: "transport" };
      }
      try {
        return await evaluate(
          batch,
          {
            baseUrl,
            timeoutMs: Math.min(config.timeoutMs, remaining),
            maxTokens: config.maxTokens,
          },
          context,
        );
      } catch (error) {
        context.signal.throwIfAborted();
        return decisionFailure(error);
      }
    },
  };
}
