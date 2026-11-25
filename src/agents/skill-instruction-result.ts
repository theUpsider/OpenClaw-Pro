import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { hasDiagnosticTracePropagationConsumer } from "../infra/diagnostic-trace-propagation.js";

// Private result metadata never changes model-facing content or serialized tool details.
// The delivery promise shares the same lifetime as the existing whole-read cache.
const deliveredFingerprints = new WeakMap<object, string>();

export function rememberSkillInstructionDelivery(
  result: object,
  content: string,
  delivery?: object,
): void {
  if (!hasDiagnosticTracePropagationConsumer()) {
    return;
  }
  const fingerprint = sha256Hex(content);
  deliveredFingerprints.set(result, fingerprint);
  if (delivery) {
    deliveredFingerprints.set(delivery, fingerprint);
  }
}

export function createAlreadyDeliveredSkillResult(delivery: object) {
  const text =
    "Skill instructions were already served whole earlier in the current model context. Reuse that content; the full document will be served again if compaction removes it.";
  const result = {
    content: [{ type: "text" as const, text }],
    details: { kind: "text" as const, content: text },
  };
  const fingerprint = deliveredFingerprints.get(delivery);
  if (fingerprint) {
    deliveredFingerprints.set(result, fingerprint);
  }
  return result;
}

export function getSkillInstructionFingerprint(result: unknown): string | undefined {
  return result && typeof result === "object" && hasDiagnosticTracePropagationConsumer()
    ? deliveredFingerprints.get(result)
    : undefined;
}

import { hash } from "node:crypto";

export type SkillInstructionResult = {
  name: string;
  relativePath?: string;
  location: string;
  locationNote?: string;
  content: string;
};

type SkillInstructionRead = {
  runId: string;
  toolCallId: string;
} & (
  | { reason: "limit_exceeded" | "incomplete_collection" }
  | { name: string; sha256: string; bytes: number; textSha256: string }
);

// Only opted-in native reads mint this fact. Weak keys follow the existing result
// lifetime; only hashes survive, so later result edits cannot change the served fact.
const instructionReads = new WeakMap<object, SkillInstructionRead>();

export function bindSkillInstructionRead(
  instructions: SkillInstructionResult,
  text: string,
  runId: string | undefined,
  toolCallId: string,
): void {
  if (runId) {
    const bytes = Buffer.byteLength(instructions.content, "utf8");
    const provenance = { runId, toolCallId };
    if (
      bytes > 256 * 1024 ||
      text.length - instructions.content.length > 4096 ||
      instructions.name.length > 256 ||
      toolCallId.length > 256
    ) {
      instructionReads.set(instructions, { ...provenance, reason: "limit_exceeded" });
      return;
    }
    if (!instructions.content.isWellFormed() || !text.isWellFormed()) {
      instructionReads.set(instructions, { ...provenance, reason: "incomplete_collection" });
      return;
    }
    instructionReads.set(instructions, {
      ...provenance,
      name: instructions.name,
      sha256: hash("sha256", instructions.content),
      bytes,
      textSha256: hash("sha256", text),
    });
  }
}

export function readSkillInstructionRead(
  details: object,
): Readonly<SkillInstructionRead> | undefined {
  return instructionReads.get(details);
}

/** Keep model-facing context separate from the complete, unmodified instruction body. */
export function formatSkillInstructions(result: SkillInstructionResult): string {
  if (result.relativePath !== undefined) {
    return result.content;
  }
  const context = [
    `Skill location: ${result.location}`,
    "Resolve relative resource paths from the directory containing this SKILL.md.",
  ];
  if (result.locationNote) {
    context.push(result.locationNote);
  }
  return `${context.join("\n")}\n\n${result.content}`;
}
