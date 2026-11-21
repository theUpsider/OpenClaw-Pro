import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { OwnedSessionTranscriptWriteContext } from "../../../config/sessions/transcript-write-context.types.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import { buildTrajectoryRunMetadata } from "../../../trajectory/metadata.js";
import { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import type { AgentSession } from "../../sessions/index.js";
import { resolveAttemptTrajectorySessionFile } from "./attempt-transcript-helpers.js";
import { projectTrajectorySessionTarget } from "./shared-run-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function prepareEmbeddedAttemptTrajectory(input: {
  activeSession: Pick<AgentSession, "sessionId">;
  transcriptOwner?: Pick<
    OwnedSessionTranscriptWriteContext,
    "sessionTarget" | "assertCommitAllowed" | "initialWriter"
  >;
  attempt: EmbeddedRunAttemptParams;
  capabilityToolNames: Iterable<string>;
  clientToolCount: number;
  effectiveToolCount: number;
  effectiveWorkspace: string;
  localModelLeanEnabled: boolean;
  sessionAgentId: string;
  systemPromptReport?: SessionSystemPromptReport;
  wireToolNames: Iterable<string>;
}): Promise<Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>> {
  const { activeSession, attempt } = input;
  const sortedCapabilityToolNames = [...input.capabilityToolNames].toSorted();
  const sortedWireToolNames = [...input.wireToolNames].toSorted();
  const candidate = input.transcriptOwner?.sessionTarget;
  const sessionKey = candidate?.sessionKey;
  const assertCommitAllowed = input.transcriptOwner?.assertCommitAllowed;
  const initialWriter = input.transcriptOwner?.initialWriter;
  // Reuse only the lock owner's descriptive key; recorder persistence retains its own authority.
  const retained =
    candidate &&
    sessionKey &&
    assertCommitAllowed &&
    candidate.agentId === input.sessionAgentId &&
    candidate.sessionId === activeSession.sessionId &&
    sessionKey === attempt.sessionKey &&
    candidate.storePath &&
    candidate.storePath === attempt.sessionTarget?.storePath
      ? {
          sessionKey,
          assertCurrent() {
            assertCommitAllowed();
            initialWriter?.assertActive();
          },
        }
      : undefined;
  retained?.assertCurrent();
  const trajectorySessionFile = retained
    ? retained.sessionKey
    : await resolveAttemptTrajectorySessionFile({
        agentId: input.sessionAgentId,
        config: attempt.config,
        sessionFile: attempt.sessionFile,
        sessionId: activeSession.sessionId,
        sessionKey: attempt.sessionKey,
        sessionTarget: attempt.sessionTarget,
      });
  if (attempt.disableTrajectory || attempt.sessionPersistence === "detached") {
    return null;
  }
  const assertActive = resolveAdmittedRunActiveAssertion(
    attempt.admittedRunContext,
    attempt.abortSignal,
  );
  if (!assertActive) {
    throw new Error("trajectory preparation requires an active admitted run");
  }
  assertActive();
  retained?.assertCurrent();
  const { sessionTarget } = projectTrajectorySessionTarget(attempt.sessionTarget);
  const recorder = await createTrajectoryRuntimeRecorder({
    cfg: attempt.config,
    env: process.env,
    runId: attempt.runId,
    sessionId: activeSession.sessionId,
    sessionKey: attempt.sessionKey,
    sessionFile: trajectorySessionFile,
    sessionTarget,
    provider: attempt.provider,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    workspaceDir: attempt.workspaceDir,
  });
  assertActive();
  retained?.assertCurrent();
  recorder?.recordEvent("session.started", {
    trigger: attempt.trigger,
    sessionFile: attempt.sessionFile,
    workspaceDir: input.effectiveWorkspace,
    agentId: input.sessionAgentId,
    messageProvider: attempt.messageProvider,
    messageChannel: attempt.messageChannel,
    localModelLean: input.localModelLeanEnabled,
    toolCount: input.effectiveToolCount,
    clientToolCount: input.clientToolCount,
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
  const fastMode = typeof attempt.fastMode === "boolean" ? attempt.fastMode : undefined;
  recorder?.recordEvent(
    "trace.metadata",
    buildTrajectoryRunMetadata({
      env: process.env,
      config: attempt.config,
      ...(attempt.preparedModelRuntime?.metadataSnapshot
        ? { pluginMetadataSnapshot: attempt.preparedModelRuntime.metadataSnapshot }
        : {}),
      workspaceDir: input.effectiveWorkspace,
      sessionFile: attempt.sessionFile,
      sessionKey: attempt.sessionKey,
      agentId: input.sessionAgentId,
      trigger: attempt.trigger,
      messageProvider: attempt.messageProvider,
      messageChannel: attempt.messageChannel,
      provider: attempt.provider,
      modelId: attempt.modelId,
      modelApi: attempt.model.api,
      timeoutMs: attempt.timeoutMs,
      fastMode,
      thinkLevel: attempt.thinkLevel,
      reasoningLevel: attempt.reasoningLevel,
      toolResultFormat: attempt.toolResultFormat,
      disableTools: attempt.disableTools,
      toolsAllow: attempt.toolsAllow,
      skillsSnapshot: attempt.skillsSnapshot,
      systemPromptReport: input.systemPromptReport,
    }),
  );
  return recorder;
}
