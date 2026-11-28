// Leaf text-budget core for worker frames.
//
// This module is deliberately dependency-light: it imports only typebox-free
// types (erased at runtime) plus the leaf `worker-protocol-primitives.ts`, so
// `worker-inference.ts` can use the budget check without pulling the heavier
// `worker-admission.ts` schema module into its import closure. The previous
// layout closed an ESM cycle
//   worker-admission -> worker-turn-admission -> worker-inference ->
//   worker-transcript-budget -> worker-admission
// whose module-level schema reads (`WorkerInferenceContextSchema.properties`,
// `WORKER_TURN_ADMISSION_PROTOCOL_FEATURE`) then hit the temporal dead zone at
// import time. `worker-transcript-budget.ts` re-exports this API for the
// existing importers, so no public surface changes.
import type { WorkerTranscriptMessage } from "./schema/worker-admission.js";
import type { WorkerInferenceContext } from "./schema/worker-inference.js";
import {
  WORKER_CONTEXT_MAX_RESIDUAL_BYTES,
  WORKER_CONTEXT_MAX_TEXT_BYTES,
  WORKER_MESSAGE_MAX_TEXT_BYTES,
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES,
  WORKER_PROTOCOL_MAX_NON_IMAGE_PAYLOAD_BYTES,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
} from "./schema/worker-protocol-primitives.js";

type BudgetMessage = WorkerTranscriptMessage | WorkerInferenceContext["messages"][number];
type WorkerTextContext = {
  messages?: readonly BudgetMessage[];
  systemPrompt?: string;
  runtimeContext?: readonly { text: string }[];
  text?: readonly string[];
  /**
   * "context" for frames that carry a conversation; their residual grows with every tool call and
   * gets WORKER_CONTEXT_MAX_RESIDUAL_BYTES. Default "control" keeps the ordinary control budget.
   */
  residual?: "control" | "context";
};

/** Serialized leaf bytes, excluding quotes which remain part of residual control. */
function leafBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/**
 * Call only after validating the carrier's exact schema. This deliberately visits
 * named data leaves, never arbitrary strings in tool arguments, details or metadata.
 * Launch transport may reserve additional bytes and exclude its separately schema-
 * bounded private endpoint from residual control; both still count toward total data.
 */
export function isWorkerTextFrameWithinBudget(
  frame: unknown,
  context: WorkerTextContext,
  transport: { additionalBytes?: number; residualMetadataBytes?: number } = {},
): boolean {
  try {
    const bytes =
      Buffer.byteLength(JSON.stringify(frame), "utf8") + (transport.additionalBytes ?? 0);
    if (bytes > WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES) {
      return false;
    }
    let textBytes = 0;
    let replayBytes = 0;
    let imageBytes = 0;
    const addMessage = (message: BudgetMessage): boolean => {
      let messageBytes = 0;
      if (typeof message.content === "string") {
        messageBytes += leafBytes(message.content);
      } else {
        for (const part of message.content) {
          switch (part.type) {
            case "text":
              messageBytes += leafBytes(part.text);
              if (part.textSignature !== undefined) {
                messageBytes += leafBytes(part.textSignature);
              }
              break;
            case "thinking":
              messageBytes += leafBytes(part.thinking);
              if (part.thinkingSignature !== undefined) {
                messageBytes += leafBytes(part.thinkingSignature);
              }
              break;
            case "toolCall":
              if (part.thoughtSignature !== undefined) {
                messageBytes += leafBytes(part.thoughtSignature);
              }
              break;
            case "image":
              imageBytes += leafBytes(part.data);
              break;
          }
        }
      }
      if (message.role === "assistant" && message.providerReplay !== undefined) {
        replayBytes += leafBytes(message.providerReplay.data);
      }
      if (message.role === "custom" && message.customType === "openclaw.runtime-context") {
        for (const fragment of message.details.fragments ?? []) {
          messageBytes += leafBytes(fragment.text);
        }
      }
      textBytes += messageBytes;
      return messageBytes <= WORKER_MESSAGE_MAX_TEXT_BYTES;
    };
    if (!(context.messages ?? []).every(addMessage)) {
      return false;
    }
    if (context.systemPrompt !== undefined) {
      textBytes += leafBytes(context.systemPrompt);
    }
    for (const fragment of context.runtimeContext ?? []) {
      const fragmentBytes = leafBytes(fragment.text);
      if (fragmentBytes > WORKER_MESSAGE_MAX_TEXT_BYTES) {
        return false;
      }
      textBytes += fragmentBytes;
    }
    const eventTextBytes = (context.text ?? []).reduce((total, text) => total + leafBytes(text), 0);
    textBytes += eventTextBytes;
    const residualLimit =
      context.residual === "context"
        ? WORKER_CONTEXT_MAX_RESIDUAL_BYTES
        : WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
    return (
      eventTextBytes <= WORKER_MESSAGE_MAX_TEXT_BYTES &&
      textBytes <= WORKER_CONTEXT_MAX_TEXT_BYTES &&
      replayBytes <= WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES &&
      bytes - imageBytes <= WORKER_PROTOCOL_MAX_NON_IMAGE_PAYLOAD_BYTES &&
      bytes - imageBytes - textBytes - replayBytes - (transport.residualMetadataBytes ?? 0) <=
        residualLimit
    );
  } catch {
    return false;
  }
}
