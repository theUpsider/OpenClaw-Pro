import { hash } from "node:crypto";

export type SkillInstructionResult = {
  name: string;
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
  const context = [
    `Skill location: ${result.location}`,
    "Resolve relative resource paths from the directory containing this SKILL.md.",
  ];
  if (result.locationNote) {
    context.push(result.locationNote);
  }
  return `${context.join("\n")}\n\n${result.content}`;
}
