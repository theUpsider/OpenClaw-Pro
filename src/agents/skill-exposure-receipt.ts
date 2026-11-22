import { hash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readSkillInstructionRead } from "./skill-instruction-result.js";

type ReadFingerprint = {
  name: string;
  sha256: string;
  bytes: number;
  toolCallId: string;
  textSha256: string;
};

type IncludedToolText = {
  toolCallId: string;
  textSha256: string;
  requestIndex: number;
  requestSha256: string;
};

export type LoadedSkillReceipt = Omit<ReadFingerprint, "textSha256"> & {
  runId: string;
  requestIndex: number;
  requestSha256: string;
};

type UnavailableReason =
  | "unsupported_provider"
  | "no_serialized_request"
  | "incomplete_collection"
  | "limit_exceeded";

export type SkillExposureReceipt = {
  loadedSkills: LoadedSkillReceipt[];
  skillExposure: {
    version: 1;
    status: "available" | "unavailable";
    scope: "native-skills-read/openai-completions";
    reason?: UnavailableReason;
  };
};

const MAX_READS = 64;
const MAX_REQUESTS = 64;
const MAX_TOOL_TEXTS = 256;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_ID_CHARS = 256;

/** Invocation-local, content-free evidence. Neither tool success nor onPayload is inclusion. */
export function createSkillExposureReceiptCollector(runId: string) {
  const reads: ReadFingerprint[] = [];
  const included: IncludedToolText[] = [];
  const requests: Array<{ encoded: boolean }> = [];
  let requestCount = 0;
  let awaitingSelectedModel = false;
  let unavailable: UnavailableReason | undefined;
  let finished: SkillExposureReceipt | undefined;
  const fail = (reason: UnavailableReason) => {
    unavailable ??= reason;
  };

  return {
    modelSelected: () => {
      if (finished) {
        return;
      }
      if (awaitingSelectedModel) {
        fail("incomplete_collection");
      }
      awaitingSelectedModel = true;
    },
    onAgentToolResult: (event: { toolName: string; result: unknown; isError: boolean }) => {
      if (finished || unavailable || event.isError || event.toolName !== "skills_read") {
        return;
      }
      const details = isRecord(event.result) ? event.result.details : undefined;
      const read = isRecord(details) ? readSkillInstructionRead(details) : undefined;
      if (!read || read.runId !== runId) {
        return;
      }
      if ("reason" in read) {
        fail(read.reason);
        return;
      }
      if (read.bytes === 0) {
        return;
      }
      const prior = reads.find((entry) => entry.toolCallId === read.toolCallId);
      if (prior) {
        // A reused call ID cannot bind two served bodies to one wire result.
        if (prior.name !== read.name || prior.textSha256 !== read.textSha256) {
          fail("incomplete_collection");
        }
        return;
      }
      if (reads.length >= MAX_READS) {
        fail("limit_exceeded");
        return;
      }
      reads.push({
        name: read.name,
        sha256: read.sha256,
        bytes: read.bytes,
        toolCallId: read.toolCallId,
        textSha256: read.textSha256,
      });
    },
    beginRequest(requestRunId: string, model: { api: string }) {
      if (finished || unavailable || requestRunId !== runId) {
        return undefined;
      }
      if (model.api !== "openai-completions") {
        fail("unsupported_provider");
        return undefined;
      }
      if (requests.length >= MAX_REQUESTS) {
        fail("limit_exceeded");
        return undefined;
      }
      const request = { encoded: false };
      requests.push(request);
      // Called only by the existing provider prompt owner, with its final encoded body.
      return (body: Uint8Array) => {
        if (finished || unavailable) {
          return;
        }
        if (body.byteLength > MAX_REQUEST_BYTES || requestCount >= MAX_REQUESTS) {
          fail("limit_exceeded");
          return;
        }
        try {
          const payload: unknown = JSON.parse(new TextDecoder().decode(body));
          if (!isRecord(payload) || !Array.isArray(payload.messages)) {
            fail("unsupported_provider");
            return;
          }
          request.encoded = true;
          awaitingSelectedModel = false;
          const requestIndex = ++requestCount;
          const requestSha256 = hash("sha256", body);
          for (const message of payload.messages) {
            if (!isRecord(message) || message.role !== "tool") {
              continue;
            }
            if (typeof message.tool_call_id !== "string" || typeof message.content !== "string") {
              fail("unsupported_provider");
              return;
            }
            if (!message.content.isWellFormed()) {
              fail("incomplete_collection");
              return;
            }
            if (included.length >= MAX_TOOL_TEXTS || message.tool_call_id.length > MAX_ID_CHARS) {
              fail("limit_exceeded");
              return;
            }
            included.push({
              toolCallId: message.tool_call_id,
              textSha256: hash("sha256", message.content),
              requestIndex,
              requestSha256,
            });
          }
        } catch {
          // Receipt bookkeeping cannot change whether an otherwise valid request runs.
          fail("incomplete_collection");
        }
      };
    },
    finish(collectionSettled = true): SkillExposureReceipt {
      if (finished) {
        return finished;
      }
      if (!collectionSettled) {
        fail("incomplete_collection");
      }
      if (!requests.length) {
        fail("no_serialized_request");
      } else if (awaitingSelectedModel || requests.some((request) => !request.encoded)) {
        fail("incomplete_collection");
      }
      const loadedSkills: LoadedSkillReceipt[] = [];
      if (!unavailable) {
        for (const { textSha256, ...read } of reads) {
          const match = included.find(
            (item) => item.toolCallId === read.toolCallId && item.textSha256 === textSha256,
          );
          if (match) {
            loadedSkills.push({
              ...read,
              runId,
              requestIndex: match.requestIndex,
              requestSha256: match.requestSha256,
            });
          }
        }
      }
      finished = {
        loadedSkills,
        skillExposure: {
          version: 1,
          status: unavailable ? "unavailable" : "available",
          scope: "native-skills-read/openai-completions",
          ...(unavailable ? { reason: unavailable } : {}),
        },
      };
      reads.length = 0;
      included.length = 0;
      return finished;
    },
  };
}

export type SkillExposureReceiptCollector = ReturnType<typeof createSkillExposureReceiptCollector>;
