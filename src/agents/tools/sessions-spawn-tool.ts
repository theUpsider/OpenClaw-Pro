import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import { getRuntimeConfig } from "../../config/config.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import {
  captureExecRequestOwners,
  withExecRequestOwners,
} from "../../infra/exec-request-context.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  normalizeAcceptedSessionSpawnResult,
} from "../accepted-session-spawn.js";
import { captureAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
} from "../inherited-tool-deny.js";
import { resolveSenderRestrictedSpawnError } from "../spawn-requester-policy.js";
import { withParentExecutionIdentity } from "../subagents/spawn/execution-identity-spawn-context.js";
import { resolveAcpSessionsSpawnImageAttachments } from "../subagents/spawn/subagent-attachments.js";
import type { SpawnSubagentParams } from "../subagents/spawn/subagent-spawn-contract.js";
import { normalizeSubagentTaskName } from "../subagents/spawn/subagent-task-name.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "../subagents/swarm/swarm-code-mode.js";
import {
  bindCollectorSpawnTool,
  captureCollectorSpawnGuard,
  captureCollectorPluginContext,
} from "../subagents/swarm/swarm-collector-capability.js";
import { resolveSwarmConfig } from "../subagents/swarm/swarm-config.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { withToolEffectBoundary } from "../tool-effect-receipt.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readNonNegativeIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  wrapGatewayPersonalToolExecution,
} from "./gateway-caller-context.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  recordSessionToolActionFact,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
} from "./sessions-helpers.js";
import {
  PlacedSessionsSpawnSchema,
  PLACED_SESSIONS_SPAWN_DESCRIPTION,
} from "./sessions-placement-tool-contract.js";
import { readSessionsSpawnCyberAccessProgram } from "./sessions-spawn-access-program.js";
import { resolveSessionsSpawnAcpUnavailableMessage } from "./sessions-spawn-acp-availability.js";
import { describeSessionsSpawnAgentId } from "./sessions-spawn-agent-id.js";
import { ALLOW_MESSAGING_SCHEMA, readAllowMessaging } from "./sessions-spawn-messaging.js";
import type { SessionsSpawnToolOptions } from "./sessions-spawn-options.js";
import { resolveSessionsSpawnThreadAvailability } from "./sessions-spawn-thread-availability.js";
import { createSessionsSpawnToolSchema } from "./sessions-spawn-tool.schema.js";

const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;
const loadAcpSpawnModule = createLazyPromise(() => import("../subagents/spawn/acp-spawn.js"));
// Tool discovery needs schemas, not the runtimes that create child sessions.
const loadSubagentSpawnModule = createLazyPromise(
  () => import("../subagents/spawn/subagent-spawn.js"),
);
const loadVisibleSpawnModule = createLazyPromise(() => import("./sessions-spawn-visible.js"));

function recordAcceptedSessionSpawn(
  result: Record<string, unknown>,
  context: "fork" | "isolated" | undefined,
  collector = false,
): void {
  const instance = getGatewayToolCallerIdentity()?.operationalRunInstance;
  const accepted = normalizeAcceptedSessionSpawnResult({ details: result });
  if (instance && accepted) {
    mergeAcceptedSessionSpawnsForRun(instance, [collector ? { ...accepted, collector } : accepted]);
  }
  const childSessionKey =
    typeof result.childSessionKey === "string" ? result.childSessionKey.trim() : "";
  const targetAgentId = childSessionKey
    ? parseAgentSessionKey(childSessionKey)?.agentId
    : undefined;
  if (result.status !== "accepted" || !childSessionKey || !targetAgentId || !context) {
    return;
  }
  recordSessionToolActionFact({
    operation: context === "fork" ? "fork" : "create",
    fact: "committed",
    targetAgentId,
    targetSessionKey: childSessionKey,
  });
}

function resolveSessionsSpawnThreadAvailability(opts?: {
  config?: OpenClawConfig;
  agentChannel?: string;
  agentAccountId?: string;
}) {
  const channel = opts?.agentChannel;
  const cfg = opts?.config;
  if (!channel || !cfg || !supportsThreadBindingSpawn(channel)) {
    return { subagent: false, acp: false };
  }
  const resolve = (kind: "subagent" | "acp") => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg,
      channel,
      accountId: opts?.agentAccountId,
      kind,
    });
    return policy.enabled && policy.spawnEnabled;
  };
  return {
    subagent: resolve("subagent"),
    acp: resolve("acp"),
  };
}

const createSessionsSpawnToolSchema = createCachedToolSchema({
  build: buildSessionsSpawnToolSchema,
  key: (params) =>
    `${params.acpAvailable}:${params.threadAvailable}:${params.subagentThreadAvailable}:${params.swarmEnabled}`,
});

function buildSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
  subagentThreadAvailable: boolean;
  swarmEnabled: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const schema = {
    task: Type.String(),
    user: requesterProfileSchema(),
    taskName: Type.Optional(
      Type.String({
        description:
          "Stable later-target alias; starts lowercase letter; then lowercase/digit/_/-.",
      }),
    ),
    label: Type.Optional(
      Type.String({
        description: "Short task title shown in UI lists; name the work, not the agent.",
      }),
    ),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
      { description: 'Runtime; visible=true and managed worktrees require "subagent".' },
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Child run timeout in seconds; overrides the configured subagent default and is preserved on native continuations. Zero disables the timeout; requester wake turns use their own budget.",
      }),
    ),
    thinking: Type.Optional(
      Type.String({ description: "Thinking override; unavailable with visible=true." }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Child working directory. Visible paths outside configured agent workspaces require operator.admin. Mutually exclusive with projectId/projectGitUrl. With no source selector and worktree=true: inherit the same-agent parent managed repository; otherwise use the target agent workspace.",
      }),
    ),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description:
                'Bind to the current conversation or a new thread, as supported by the channel; true defaults mode="session"; unavailable with visible=true.',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes, {
      description: params.threadAvailable
        ? '"run" one-shot; "session" persistent/thread-bound. Visible sessions accept only omitted/default "run" and remain persistent.'
        : '"run" one-shot. Visible sessions accept omitted/default "run" and remain persistent.',
    }),
    cleanup: optionalStringEnum(["delete", "keep"] as const, {
      description:
        "Hidden session cleanup; delete snapshots and removes its managed worktree through session cleanup. visible=true always keeps the session.",
    }),
    expectsCompletionMessage: Type.Optional(
      Type.Boolean({
        description:
          "false: fire-and-forget; requester gets no completion handoff when the child finishes.",
      }),
    ),
    completionTarget: optionalStringEnum(["parent"] as const, {
      description:
        "parent: return results in a private requester turn; no automatic channel delivery. After sessions_yield, answer under the conversation's normal reply rules (NO_REPLY stays silent). Native hidden run only; unavailable with ACP, collect, visible, thread, session mode, or expectsCompletionMessage=false.",
    }),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES, {
      description: '"inherit" parent sandbox policy; "require" fails unless child is sandboxed.',
    }),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description: describeSubagentSpawnContext(params.subagentThreadAvailable),
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description: "Light bootstrap; subagent only; unavailable with visible=true.",
      }),
    ),
    allowMessaging: ALLOW_MESSAGING_SCHEMA,
    ...(params.swarmEnabled
      ? {
          collect: Type.Optional(
            Type.Boolean({
              description:
                "Swarm collector child for large parallel fan-out, not one or a few children; no completion notification.",
            }),
          ),
          outputSchema: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "JSON Schema for the child's structured result; requires collect=true.",
            }),
          ),
          fastMode: Type.Optional(
            Type.Union([Type.Boolean(), Type.Literal("auto"), Type.Literal("ultrafast")]),
          ),
          groupId: Type.Optional(
            Type.String({
              description: "Groups parallel collector children; requires collect=true.",
            }),
          ),
        }
      : {}),
    ...SESSIONS_SPAWN_SESSION_SCHEMA,

    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: optionalStringEnum(["utf8", "base64"] as const),
          mimeType: Type.Optional(Type.String()),
        }),
        {
          maxItems: 50,
          description: "Inline snapshots; visible=true accepts only an empty array.",
        },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object(
        {
          mountPath: Type.Optional(Type.String()),
        },
        {
          description:
            "Attachment mount hint; visible=true accepts only an omitted or blank mountPath.",
        },
      ),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description: "ACP resume id already recorded for requester; ignored by subagent.",
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description: 'ACP only; "parent" streams turn to requester. Ignored by subagent.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
}

function resolveAcpUnavailableMessage(opts?: { sandboxed?: boolean; config?: OpenClawConfig }) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

export function createSessionsSpawnTool(
  opts?: SessionsSpawnToolOptions & { workerPlacement?: boolean },
): AnyAgentTool {
  const requesterThinkingExplicit =
    // SAFETY: The host forwards this optional runtime bit; public callers can omit it.
    (opts as (typeof opts & { requesterThinkingExplicit?: boolean }) | undefined)
      ?.requesterThinkingExplicit;
  const requestOwners = captureExecRequestOwners({
    runId: opts?.requesterTurnRunId,
    sessionId: opts?.expectedParentSessionId,
  });
  const effectiveConfig = opts?.config ?? getRuntimeConfig();
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: effectiveConfig,
    sandboxed: opts?.sandboxed,
  });
  const threadAvailability = resolveSessionsSpawnThreadAvailability({
    ...opts,
    config: effectiveConfig,
  });
  const threadAvailable = threadAvailability.subagent || threadAvailability.acp;
  const requesterAgentId =
    opts?.requesterAgentIdOverride ?? parseAgentSessionKey(opts?.agentSessionKey)?.agentId;
  const swarmConfig = resolveSwarmConfig(effectiveConfig, requesterAgentId);
  const sessionToolsVisibility = resolveEffectiveSessionToolsVisibility({
    cfg: effectiveConfig,
    sandboxed: opts?.sandboxed === true,
  });
  const { restrictToSpawned } = resolveSandboxedSessionToolContext({
    cfg: effectiveConfig,
    agentSessionKey: opts?.agentSessionKey,
    requesterAgentId,
    sandboxed: opts?.sandboxed,
  });
  const agentIdGuidance = describeSessionsSpawnAgentId({
    cfg: effectiveConfig,
    requesterAgentId,
    requesterIsSubagent: opts?.requesterIsSubagent ?? isSubagentSessionKey(opts?.agentSessionKey),
    acpAvailable,
    collectDefaultAgentId: swarmConfig.enabled ? swarmConfig.defaultAgentId : undefined,
    spawnContext: opts,
  });
  const parameters = opts?.workerPlacement
    ? PlacedSessionsSpawnSchema
    : createSessionsSpawnToolSchema({
        acpAvailable,
        threadAvailable,
        subagentThreadAvailable: threadAvailability.subagent,
        swarmEnabled: swarmConfig.enabled,
      });
  const tool: AnyAgentTool = {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: opts?.workerPlacement
      ? PLACED_SESSIONS_SPAWN_DESCRIPTION
      : describeSessionsSpawnTool({
          acpAvailable,
          threadAvailable,
          subagentThreadAvailable: threadAvailability.subagent,
          swarmEnabled: swarmConfig.enabled,
          sessionToolsVisibility,
          spawnRestricted: restrictToSpawned,
          agentIdGuidance,
        }),
    parameters,
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, args, signal) =>
      withToolEffectBoundary(async (onSpawnEffectsStart) => {
        const operatorSelection = resolveGatewayToolOperatorSelection();
        const executionSignal =
          signal && opts?.signal
            ? AbortSignal.any([signal, opts.signal])
            : (signal ?? opts?.signal);
        const assertSourceExecution = captureAgentToolSourceExecutionGuard(executionSignal);
        // A retained owner bit is rechecked per call: a requester who stopped being an
        // owner spawns as a non-owner, and one revoked mid-call refuses the commit.
        let senderIsOwner = opts?.senderIsOwner;
        let assertSenderOwner: (() => void) | undefined;
        if (senderIsOwner === true && opts?.assertSenderOwnerCurrent) {
          try {
            opts.assertSenderOwnerCurrent();
            assertSenderOwner = opts.assertSenderOwnerCurrent;
          } catch {
            senderIsOwner = false;
          }
        }
        const assertSourceActive = composeSessionSourceAssertion([
          assertSourceExecution,
          operatorSelection.assertCurrent,
          assertSenderOwner,
        ]);
        const params = args as Record<PropertyKey, unknown>;
        if (opts?.swarmCollector && params.collect !== true) {
          throw new ToolInputError(
            "sessions_spawn from a collector requires collect=true so approvals stay non-interactive.",
          );
        }
        const swarmParam = ["collect", "outputSchema", "fastMode", "groupId"].find((key) =>
          Object.hasOwn(params, key),
        );
        if (swarmParam && !swarmConfig.enabled) {
          throw new ToolInputError(
            `sessions_spawn parameter "${swarmParam}" requires tools.swarm.enabled=true.`,
          );
        }
        const hasCollectParam = Object.hasOwn(params, "collect");
        const collect = params.collect === true;
        const assertActive = collect
          ? captureCollectorSpawnGuard(tool, _toolCallId, assertSourceActive)
          : assertSourceActive;
        assertActive();
        if (params.outputSchema !== undefined && !collect) {
          throw new ToolInputError('sessions_spawn "outputSchema" requires collect=true.');
        }
        if (params.groupId !== undefined && !collect) {
          throw new ToolInputError('sessions_spawn "groupId" requires collect=true.');
        }
        if (
          collect &&
          (params.thread === true || params.visible === true || params.mode === "session")
        ) {
          throw new ToolInputError(
            "sessions_spawn collect=true does not support thread, visible, or session mode.",
          );
        }
        const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
          Object.hasOwn(params, key),
        );
        if (unsupportedParam) {
          throw new ToolInputError(
            `sessions_spawn does not support "${unsupportedParam}"; remove channel-delivery parameters.`,
          );
        }
        const unsupportedTimeoutParam = resolveSnakeCaseParamKey(params, "timeoutSeconds");
        if (unsupportedTimeoutParam) {
          throw new ToolInputError(
            `sessions_spawn does not support "${unsupportedTimeoutParam}". Use "runTimeoutSeconds" for a per-run timeout.`,
          );
        }
        const task =
          readToolStringParam(params, "task", {
            required: !opts?.independent,
            trim: !opts?.independent,
          }) ?? "";
        const runTimeoutSeconds = readNonNegativeIntegerParam(params, "runTimeoutSeconds");
        const taskNameResult = normalizeSubagentTaskName(params.taskName);
        if (taskNameResult.error) {
          return jsonResult({
            status: "error",
            error: taskNameResult.error,
          });
        }

        const label = readToolStringParam(params, "label") ?? "";
        const runtime = params.runtime === "acp" ? "acp" : "subagent";
        if (runtime === "subagent" && opts?.delegatedToolPolicyUnavailable) {
          throw new ToolInputError(
            "This mediated tool surface cannot preserve the active delegated execution grant. Start the helper from a Gateway-side native tool surface.",
          );
        }
        const completionTarget = params.completionTarget;
        if (completionTarget !== undefined && completionTarget !== "parent") {
          throw new ToolInputError('sessions_spawn completionTarget must be "parent" or omitted.');
        }
        if (completionTarget === "parent" && (runtime === "acp" || params.visible === true)) {
          throw new ToolInputError(
            'sessions_spawn completionTarget="parent" requires a hidden native subagent run.',
          );
        }
        if (collect && runtime === "acp") {
          throw new ToolInputError('sessions_spawn collect=true supports runtime="subagent" only.');
        }
        if (params.blind === true && (runtime === "acp" || params.visible === true)) {
          throw new ToolInputError('blind=true requires a hidden runtime="subagent" child.');
        }
        const allowMessaging = readAllowMessaging(params, runtime);
        const requestedAgentId = readToolStringParam(params, "agentId");
        const modelOverride = normalizeToolModelOverride(readToolStringParam(params, "model"));
        const requesterPolicyError = resolveSpawnRequesterRefusal({
          ...opts,
          requesterAgentId,
          targetAgentId: requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined,
          visible: params.visible === true,
          modelOverride,
          agentRuntime: runtime, // ACP does not enforce the rules
        });
        if (requesterPolicyError) {
          return jsonResult({ status: "forbidden", error: requesterPolicyError });
        }
        const resumeSessionId = readToolStringParam(params, "resumeSessionId");
        const thinkingOverrideRaw = readToolStringParam(params, "thinking");
        const cyberAccessProgram = readSessionsSpawnCyberAccessProgram(params, runtime);
        const cwd = readToolStringParam(params, "cwd");
        const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
        const cleanup = params.cleanup === "delete" ? "delete" : "keep";
        const expectsCompletionMessage = !collect && params.expectsCompletionMessage !== false;
        const sandbox = params.sandbox === "require" ? "require" : "inherit";
        const context =
          params.context === "fork" || params.context === "isolated" ? params.context : undefined;
        const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : undefined;
        const lightContext = params.lightContext === true;
        const spawnResult = <T extends { status: string }>(result: T) =>
          jsonResult(
            requestedAgentId && (result.status === "error" || result.status === "forbidden")
              ? { ...result, role: requestedAgentId }
              : result,
          );
        const expectedParentSessionKey = opts?.agentSessionKey?.trim();
        if (opts?.expectedParentSessionId && !expectedParentSessionKey) {
          throw new Error("Exact parent session access requires a session key");
        }
        const spawnVisible = async () => {
          const { maybeSpawnVisibleSession } = await loadVisibleSpawnModule();
          // Imports are shared; the original invocation must still own this call.
          assertActive();
          return maybeSpawnVisibleSession({
            raw: params,
            task,
            taskName: taskNameResult.taskName,
            label,
            runtime,
            requestedAgentId,
            runTimeoutSeconds,
            sandbox,
            expectsCompletionMessage,
            cyberAccessProgram,
            options: withExecRequestOwners(
              {
                ...opts,
                senderIsOwner,
                onSpawnEffectsStart,
                assertActive,
                signal: executionSignal,
              },
              requestOwners,
            ),
          });
        };
        const visibleResult =
          params.visible === true && opts?.expectedParentSessionId
            ? await runWithScopedSessionAccess({
                cfg: effectiveConfig,
                expectedSessionId: opts.expectedParentSessionId,
                ...(opts.signal ? { signal: opts.signal } : {}),
                targetSessionKey: expectedParentSessionKey!,
                run: spawnVisible,
              })
            : await spawnVisible();
        if (visibleResult) {
          recordAcceptedSessionSpawn(visibleResult, context ?? "isolated");
          return spawnResult(visibleResult as { status: string });
        }
        if (runtime === "acp" && !acpAvailable) {
          return spawnResult({
            status: "error",
            error: resolveSessionsSpawnAcpUnavailableMessage({
              config: effectiveConfig,
              sandboxed: opts?.sandboxed,
            }),
          });
        }
        const acpUnsupportedInheritedTool =
          runtime === "acp"
            ? findAcpUnsupportedInheritedToolDeny(opts?.inheritedToolDenylist)
            : undefined;
        if (acpUnsupportedInheritedTool) {
          return spawnResult({
            status: "forbidden",
            error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
          });
        }
        const acpUnsupportedInheritedAllow =
          runtime === "acp"
            ? findAcpUnsupportedInheritedToolAllow(opts?.inheritedToolAllowlist)
            : undefined;
        if (acpUnsupportedInheritedAllow) {
          return spawnResult({
            status: "forbidden",
            error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
          });
        }
        if (runtime === "acp" && lightContext) {
          throw new Error("lightContext is only supported for runtime='subagent'.");
        }
        if (runtime === "acp" && context === "fork") {
          throw new Error('context="fork" is only supported for runtime="subagent".');
        }
        const thread = params.thread === true;
        const attachments = Array.isArray(params.attachments)
          ? (params.attachments as SpawnSubagentParams["attachments"])
          : undefined;
        const parentExecutionIdentityToken = getGatewayToolCallerIdentity()?.executionIdentityToken;
        const spawnParams = {
          task,
          taskName: taskNameResult.taskName,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
          cwd,
          mode,
          thread,
          sandbox,
          cleanup,
          expectsCompletionMessage,
        } as const;
        const inheritedSpawnContext = () => ({
          assertActive,
          onSpawnEffectsStart,
          agentSessionKey: opts?.agentSessionKey,
          senderIsOwner,
          gitContributorProfileId: opts?.gitContributorProfileId,
          expectedParentSessionId: opts?.expectedParentSessionId,
          requesterTurnRunId: opts?.requesterTurnRunId,
          completionOwnerKey: opts?.completionOwnerKey,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          currentChannelId: opts?.currentChannelId,
          currentThreadTs: opts?.currentThreadTs,
          currentConversationOrigin: opts?.currentConversationOrigin,
          currentMessageId: opts?.currentMessageId,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          sandboxed: opts?.sandboxed,
          inheritedToolAllowlist: opts?.inheritedToolAllowlist,
          inheritedToolDenylist: opts?.inheritedToolDenylist,
          ...(runtime === "subagent"
            ? {
                delegatedToolDenyFloor: opts?.delegatedToolDenyFloor,
                requesterToolDenylist: opts?.requesterToolDenylist,
                readDelegationConfig: opts?.readDelegationConfig,
              }
            : {}),
          inheritedToolPolicySource: opts?.inheritedToolPolicySource,
          workspaceDir: opts?.workspaceDir,
          sessionPermissionPolicy: opts?.sessionPermissionPolicy,
        });

        if (runtime === "acp") {
          const { spawnAcpDirect } = await loadAcpSpawnModule();
          const acpAttachments = resolveAcpSessionsSpawnImageAttachments({
            config: opts?.config ?? getRuntimeConfig(),
            attachments,
          });
          if (acpAttachments?.status === "forbidden" || acpAttachments?.status === "error") {
            return spawnResult({
              status: acpAttachments.status,
              error: acpAttachments.error,
            });
          }
          const result = await spawnAcpDirect(
            {
              ...spawnParams,
              resumeSessionId,
              streamTo,
              attachments: acpAttachments?.attachments,
            },
            withParentExecutionIdentity(
              {
                ...inheritedSpawnContext(),
                currentMessagingTarget: opts?.currentMessagingTarget,
                agentGroupId: opts?.agentGroupId ?? undefined,
              },
              parentExecutionIdentityToken,
            ),
          );
          recordAcceptedSessionSpawn(result, "isolated");
          return spawnResult(result);
        }

        const { spawnSubagentDirect } = await loadSubagentSpawnModule();
        assertActive();
        const checkoutParams = params.worktree === true ? params : {};
        const result = await spawnSubagentDirect(
          {
            ...spawnParams,
            projectId: readToolStringParam(checkoutParams, "projectId"),
            worktree: params.worktree === true,
            worktreeName: readToolStringParam(checkoutParams, "worktreeName"),
            worktreeBaseRef: readToolStringParam(checkoutParams, "worktreeBaseRef"),
            collect: hasCollectParam ? collect : undefined,
            outputSchema:
              params.outputSchema && typeof params.outputSchema === "object"
                ? (params.outputSchema as Record<string, unknown>)
                : undefined,
            fastMode:
              params.fastMode === true ||
              params.fastMode === false ||
              params.fastMode === "auto" ||
              params.fastMode === "ultrafast"
                ? params.fastMode
                : undefined,
            cyberAccessProgram,
            groupId: readToolStringParam(params, "groupId"),
            swarmLaunchReplayKey:
              typeof params[SWARM_CODE_MODE_IDEMPOTENCY_KEY] === "string"
                ? params[SWARM_CODE_MODE_IDEMPOTENCY_KEY]
                : undefined,
            swarmLaunchRequestFingerprint:
              typeof params[SWARM_CODE_MODE_REQUEST_FINGERPRINT] === "string"
                ? params[SWARM_CODE_MODE_REQUEST_FINGERPRINT]
                : undefined,
            context,
            lightContext,
            ...(params.blind === true ? { blind: true } : {}),
            allowMessaging,
            completionTarget,
            attachments,
            attachMountPath:
              params.attachAs && typeof params.attachAs === "object"
                ? readToolStringParam(params.attachAs as Record<string, unknown>, "mountPath")
                : undefined,
          },
          withParentExecutionIdentity(
            withExecRequestOwners(
              {
                ...inheritedSpawnContext(),
                signal: executionSignal,
                requesterThinkingLevel: opts?.requesterThinkingLevel,
                ...(collect ? captureCollectorPluginContext(tool, _toolCallId) : {}),
                requesterThinkingExplicit,
                requesterModel: opts?.requesterModel,
                currentMessagingTarget: opts?.currentMessagingTarget ?? opts?.currentChannelId,
                agentGroupId: opts?.agentGroupId,
                agentGroupChannel: opts?.agentGroupChannel,
                requesterRunId: opts?.requesterRunId,
              },
              requestOwners,
            ),
            parentExecutionIdentityToken,
          ),
        );

        recordAcceptedSessionSpawn(result, result.context, collect);
        return spawnResult(result);
      }),
    ),
  };
  return opts?.workerPlacement
    ? tool
    : bindCollectorSpawnTool(tool, parameters.properties, opts?.signal);
}
