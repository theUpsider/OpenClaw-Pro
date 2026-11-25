import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { OwnedSessionTranscriptWriteContext } from "../../../config/sessions/transcript-write-context.types.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import { buildTrajectoryRunMetadata } from "../../../trajectory/metadata.js";
import { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { CODEX_HARNESS_ID, resolveAttemptTrajectoryAttribution } from "./runtime-resolution.js";
import { projectTrajectorySessionTarget } from "./shared-run-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function prepareEmbeddedHarnessTrajectory(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "config" | "runId" | "disableTrajectory" | "sessionPersistence"
  >;
  harnessId: string;
  model: { api?: string; provider?: string };
  modelId: string;
  provider: string;
  runtimePlan: AgentRuntimePlan;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
  workspaceDir: string;
}) {
  const { attempt } = input;
  const attribution = resolveAttemptTrajectoryAttribution(input);
  if (
    input.harnessId !== CODEX_HARNESS_ID ||
    attempt.disableTrajectory ||
    attempt.sessionPersistence === "detached"
  ) {
    return undefined;
  }
  return await createTrajectoryRuntimeRecorder({
    cfg: attempt.config,
    env: process.env,
    runId: attempt.runId,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    sessionFile: input.sessionFile,
    ...projectTrajectorySessionTarget(input.sessionTarget, true),
    provider: attribution.provider,
    modelId: attribution.modelId,
    modelApi: attribution.modelApi,
    workspaceDir: input.workspaceDir,
    // boolean | undefined: when the caller's owner status is unknown this is
    // undefined, and JSON serialization omits the key entirely. Absent therefore
    // means "unknown", not "not the owner" — only an explicit false does.
    senderIsOwner: attempt.senderIsOwner,
    capabilityToolNames: sortedCapabilityToolNames,
    // A basis above the limiter's 64-item array cap loses names silently. The
    // limiter does append a `trajectory-array-size-limit` marker, but it sits at
    // index 64 and the diagnostic projection that follows keeps only the first 64
    // keys of a value, so the marker is dropped; the array reads as a plain
    // 64-item list with no cue. The count and digest cover the full
    // pre-truncation set, so a truncated array stays detectable.
    capabilityToolNamesCount: sortedCapabilityToolNames.length,
    // JSON framing, not a plain separator join: tool names are trimmed but may
    // contain any character, so a separator join could collide two set shapes.
    capabilityToolNamesHash: sha256Hex(JSON.stringify(sortedCapabilityToolNames)),
    // The constructed (wire) surface: the pinned session tool set the next
    // provider request is built from, in contrast to capabilityToolNames*, the
    // admission basis. Recorded before dispatch, so the prompt-hook cap
    // (applyPromptBuildToolsAllow) can still intersect it: this is the session
    // surface at turn start, not a byte-for-byte capture of the dispatched array.
    wireToolNames: sortedWireToolNames,
    // Count and digest cover the full pre-truncation set like the basis above:
    // the 64-item array cap silently hides names past index 64.
    wireToolNamesCount: sortedWireToolNames.length,
    wireToolNamesHash: sha256Hex(JSON.stringify(sortedWireToolNames)),
  });
}
