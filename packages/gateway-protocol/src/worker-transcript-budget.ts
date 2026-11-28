import { Value } from "typebox/value";
import {
  WorkerTranscriptCommitRequestFrameSchema,
  type WorkerTranscriptCommitRequestFrame,
  type WorkerTranscriptMessage,
} from "./schema/worker-admission.js";
import {
  checkWorkerProtocolJson,
  WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "./schema/worker-protocol-primitives.js";
import { isWorkerTextFrameWithinBudget } from "./worker-text-budget.js";

// Keep the text-budget API on this module for existing importers; the core lives in the leaf
// `worker-text-budget.ts` so `worker-inference.ts` can use it without a cycle through
// `worker-admission.ts`.
export { isWorkerTextFrameWithinBudget } from "./worker-text-budget.js";

export function isWorkerTranscriptFrameWithinBudget(
  frame: WorkerTranscriptCommitRequestFrame,
): boolean {
  return (
    !checkWorkerProtocolJson(frame) &&
    Value.Check(WorkerTranscriptCommitRequestFrameSchema, frame) &&
    isWorkerTextFrameWithinBudget(frame, { messages: frame.params.messages, residual: "context" })
  );
}

function transcriptImageData({ content }: WorkerTranscriptMessage): string[] {
  return typeof content === "string"
    ? []
    : content.flatMap((part) => (part.type === "image" ? [part.data] : []));
}

export function takeFittingWorkerTranscriptBatch(
  frame: WorkerTranscriptCommitRequestFrame,
): WorkerTranscriptMessage[] {
  const batch: WorkerTranscriptMessage[] = [];
  try {
    let bytes = Buffer.byteLength(
      JSON.stringify({ ...frame, params: { ...frame.params, messages: [] } }),
      "utf8",
    );
    let imageBytes = 0;
    for (const message of frame.params.messages) {
      // JSON messages contribute their own bytes plus the comma between array entries.
      bytes += Buffer.byteLength(JSON.stringify(message), "utf8") + (batch.length > 0 ? 1 : 0);
      for (const data of transcriptImageData(message)) {
        imageBytes += Buffer.byteLength(JSON.stringify(data), "utf8") - 2;
      }
      if (
        bytes > WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES ||
        bytes - imageBytes > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES
      ) {
        break;
      }
      batch.push(message);
    }
  } catch {
    // Match frame admission: an unserializable message cannot join the batch.
  }
  return batch;
}
