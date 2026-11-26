import type { WorkboardWorkspace, WorkboardWorkspaceAccess } from "@openclaw/workboard-contract";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
// Workboard workspace access follows the caller's canonical filesystem boundary.
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId, normalizeAgentIdStrict } from "openclaw/plugin-sdk/routing";
import { asOptionalRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";

export type { WorkboardWorkspaceAccess } from "@openclaw/workboard-contract";

type WorkboardConfig = NonNullable<OpenClawPluginToolContext["config"]>;
type ResolveSandboxWorkspaceAuthority =
  OpenClawPluginApi["runtime"]["sandbox"]["resolveWorkspaceAuthority"];
type PrepareSandboxWorkspaceAuthority =
  OpenClawPluginApi["runtime"]["sandbox"]["prepareWorkspaceAuthority"];

export const WORKBOARD_SESSIONS_BOARD_TOOL_NAMES = [
  "workboard_sessions_board_read",
  "workboard_sessions_board_update",
  "workboard_sessions_board_move",
] as const;

/** Card tools stay optional; sessions-board tools register separately as default-on. */
export const WORKBOARD_CARD_TOOL_NAMES = [
  "workboard_list",
  "workboard_create",
  "workboard_link",
  "workboard_read",
  "workboard_claim",
  "workboard_heartbeat",
  "workboard_complete",
  "workboard_attachment_add",
  "workboard_attachment_read",
  "workboard_attachment_delete",
  "workboard_block",
  "workboard_boards",
  "workboard_board_create",
  "workboard_board_archive",
  "workboard_board_delete",
  "workboard_stats",
  "workboard_runs",
  "workboard_specify",
  "workboard_decompose",
  "workboard_notify_subscribe",
  "workboard_notify_list",
  "workboard_notify_events",
  "workboard_notify_advance",
  "workboard_notify_unsubscribe",
  "workboard_promote",
  "workboard_reassign",
  "workboard_reclaim",
  "workboard_dispatch",
  "workboard_release",
  "workboard_comment",
  "workboard_proof",
  "workboard_verify",
  "workboard_worker_log",
  "workboard_protocol_violation",
  "workboard_unblock",
  "workboard_move",
  "workboard_set_parallelism",
  "workboard_set_dispatch_mode",
  "workboard_update",
] as const;

const WORKBOARD_TOOL_NAMES = [
  ...WORKBOARD_CARD_TOOL_NAMES,
  ...WORKBOARD_SESSIONS_BOARD_TOOL_NAMES,
] as const;

export const WORKBOARD_REQUIRED_WORKER_TOOLS = [
  "workboard_heartbeat",
  "workboard_complete",
  "workboard_block",
] as const;

export function resolveWorkboardAgentWorkspace(config: WorkboardConfig, agentId?: string): string {
  return resolveAgentWorkspaceDir(config, agentId ?? resolveDefaultAgentId(config));
}

export function resolveConfiguredWorkboardWorkspaceAccess(params: {
  config: WorkboardConfig;
  unrestricted: boolean;
}): WorkboardWorkspaceAccess {
  if (params.unrestricted) {
    return { unrestricted: true };
  }
  return {
    unrestricted: false,
    writable: true,
    roots: listAgentIds(params.config).map((agentId) =>
      resolveAgentWorkspaceDir(params.config, agentId),
    ),
  };
}

export type WorkboardTargetWorkspaceRuntime = {
  sandboxed: boolean;
  workspaceAccess: WorkboardWorkspaceAccess;
  confinementError?: string;
};

export async function resolveAgentWorkboardWorkspaceRuntime(params: {
  config: WorkboardConfig;
  agentId?: string;
  sessionKey: string;
  workspaceDir: string;
  modelProvider?: string;
  modelId?: string;
  prepareSandboxWorkspaceAuthority: PrepareSandboxWorkspaceAuthority;
}): Promise<WorkboardTargetWorkspaceRuntime> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const sandboxRuntime = await params.prepareSandboxWorkspaceAuthority({
    config: params.config,
    agentId,
    confinedToolNames: WORKBOARD_TOOL_NAMES,
    requiredToolNames: WORKBOARD_REQUIRED_WORKER_TOOLS,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  return {
    sandboxed: sandboxRuntime.sandboxed,
    workspaceAccess: sandboxRuntime.sandboxed
      ? {
          unrestricted: false,
          roots: [resolveAgentWorkspaceDir(params.config, agentId)],
          writable: sandboxRuntime.workspaceAccess === "rw",
        }
      : { unrestricted: true },
    ...(sandboxRuntime.confinementError
      ? { confinementError: sandboxRuntime.confinementError }
      : {}),
  };
}

export function resolveCommandWorkboardWorkspaceAccess(params: {
  config: WorkboardConfig;
  agentId?: string;
  sessionKey?: string;
  gatewayClientScopes?: readonly string[];
  resolveSandboxWorkspaceAuthority?: ResolveSandboxWorkspaceAuthority;
}): WorkboardWorkspaceAccess {
  if (params.gatewayClientScopes) {
    return resolveConfiguredWorkboardWorkspaceAccess({
      config: params.config,
      unrestricted: params.gatewayClientScopes.includes("operator.admin"),
    });
  }
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const sandboxRuntime =
    params.sessionKey && params.resolveSandboxWorkspaceAuthority
      ? params.resolveSandboxWorkspaceAuthority({
          config: params.config,
          agentId,
          sessionKey: params.sessionKey,
        })
      : undefined;
  if (sandboxRuntime?.sandboxed) {
    return {
      unrestricted: false,
      roots: [resolveAgentWorkspaceDir(params.config, agentId)],
      writable: sandboxRuntime.workspaceAccess === "rw",
    };
  }
  const workspaceOnly =
    resolveAgentConfig(params.config, agentId)?.tools?.fs?.workspaceOnly ??
    params.config.tools?.fs?.workspaceOnly;
  return workspaceOnly === true
    ? {
        unrestricted: false,
        roots: [resolveAgentWorkspaceDir(params.config, agentId)],
        writable: true,
      }
    : { unrestricted: true };
}

function resolveToolWorkboardWorkspaceAccess(
  context: OpenClawPluginToolContext | undefined,
  resolveSandboxWorkspaceAuthority?: ResolveSandboxWorkspaceAuthority,
): WorkboardWorkspaceAccess {
  if (!context?.sandboxed && context?.fsPolicy?.workspaceOnly !== true) {
    return { unrestricted: true };
  }
  const config = context.runtimeConfig ?? context.getRuntimeConfig?.() ?? context.config;
  const sandboxRuntime =
    context.sandboxed && config && context.sessionKey && resolveSandboxWorkspaceAuthority
      ? resolveSandboxWorkspaceAuthority({
          config,
          agentId: context.agentId,
          sessionKey: context.sessionKey,
        })
      : undefined;
  return {
    unrestricted: false,
    roots: context.workspaceDir ? [context.workspaceDir] : [],
    writable: sandboxRuntime ? sandboxRuntime.workspaceAccess === "rw" : !context.sandboxed,
  };
}

export async function canonicalizeWorkboardWorkspaceAccess(
  access: WorkboardWorkspaceAccess,
): Promise<WorkboardWorkspaceAccess> {
  if (access.unrestricted) {
    return access;
  }
  const roots = Array.from(
    new Set(
      await Promise.all(
        access.roots.map(async (root) => await canonicalPathFromExistingAncestor(root)),
      ),
    ),
  );
  if (roots.length === 0) {
    throw new Error("restricted workspace access has no allowed roots.");
  }
  return { unrestricted: false, roots, writable: access.writable };
}

export function intersectWorkboardWorkspaceAccess(
  left: WorkboardWorkspaceAccess,
  right: WorkboardWorkspaceAccess,
): WorkboardWorkspaceAccess {
  if (left.unrestricted) {
    return right;
  }
  if (right.unrestricted) {
    return left;
  }
  const roots = new Set<string>();
  for (const leftRoot of left.roots) {
    for (const rightRoot of right.roots) {
      if (leftRoot === rightRoot || isPathInside(leftRoot, rightRoot)) {
        roots.add(rightRoot);
      } else if (isPathInside(rightRoot, leftRoot)) {
        roots.add(leftRoot);
      }
    }
  }
  if (roots.size === 0) {
    throw new Error("workspace access does not overlap the card's persisted authority.");
  }
  return {
    unrestricted: false,
    roots: Array.from(roots),
    writable: left.writable && right.writable,
  };
}

export class WorkboardWorkspaceOutsideRootsError extends Error {
  constructor() {
    super("workspace path is outside the caller's allowed workspaces.");
    this.name = "WorkboardWorkspaceOutsideRootsError";
  }
}

async function assertCanonicalWorkboardPathAccess(
  candidate: string,
  access: WorkboardWorkspaceAccess,
  exactRoot = false,
): Promise<string> {
  if (access.unrestricted) {
    return candidate;
  }
  for (const root of access.roots) {
    const canonicalRoot = await canonicalPathFromExistingAncestor(root);
    if (exactRoot ? canonicalRoot === candidate : isPathInside(canonicalRoot, candidate)) {
      return candidate;
    }
  }
  if (exactRoot) {
    throw new Error("workspace path must equal one of the caller's allowed workspace roots.");
  }
  throw new WorkboardWorkspaceOutsideRootsError();
}

export function assertCanonicalWorkboardRootAccess(
  candidate: string,
  access: WorkboardWorkspaceAccess,
): Promise<string> {
  return assertCanonicalWorkboardPathAccess(candidate, access, true);
}

async function assertPathAllowed(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const candidate = await canonicalPathFromExistingAncestor(value.trim());
  return await assertCanonicalWorkboardPathAccess(candidate, access);
}

async function assertWorkspaceAllowed(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Promise<void> {
  const workspace = asOptionalRecord(value);
  if (!workspace) {
    return;
  }
  await assertPathAllowed(workspace.path, access);
  await assertPathAllowed(workspace.sourcePath, access);
}

function* workspaceMutationRecords(value: unknown): Generator<Record<string, unknown>> {
  const record = asOptionalRecord(value);
  if (!record) {
    return;
  }
  yield record;
  yield* workspaceMutationRecords(record.patch);
  yield* workspaceMutationRecords(asOptionalRecord(record.metadata)?.automation);
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      yield* workspaceMutationRecords(child);
    }
  }
}

export function containsWorkboardWorkspaceMutation(value: unknown): boolean {
  for (const record of workspaceMutationRecords(value)) {
    if (Object.hasOwn(record, "workspace") || Object.hasOwn(record, "defaultWorkspace")) {
      return true;
    }
  }
  return false;
}

export function withWorkboardWorkspaceAccess(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Record<string, unknown> {
  return { ...withoutWorkboardWorkspaceAccess(value), workspaceAccess: access };
}

export function withoutWorkboardWorkspaceAccess(value: unknown): Record<string, unknown> {
  const record = asOptionalRecord(value) ?? {};
  const { workspaceAccess: _untrustedWorkspaceAccess, ...rest } = record;
  return rest;
}

export function withWorkboardDecomposeWorkspaceAccess(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Record<string, unknown> {
  const record = withoutWorkboardWorkspaceAccess(value);
  return {
    ...record,
    ...(Array.isArray(record.children)
      ? {
          children: record.children.map((child) => withWorkboardWorkspaceAccess(child, access)),
        }
      : {}),
  };
}

export async function assertWorkboardWorkspaceMutationAccess(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Promise<void> {
  if (access.unrestricted) {
    return;
  }
  // Card creation and decomposition persist only explicit workspace fields;
  // board defaults and parent workspaces are metadata, not inherited inputs.
  for (const record of workspaceMutationRecords(value)) {
    await assertWorkspaceAllowed(record.workspace, access);
    await assertWorkspaceAllowed(record.defaultWorkspace, access);
  }
}

export async function assertWorkboardWorkspaceSourceAccess(
  workspace: WorkboardWorkspace | undefined,
  access: WorkboardWorkspaceAccess,
): Promise<string | undefined> {
  const record = asOptionalRecord(workspace);
  return await assertPathAllowed(record?.sourcePath ?? record?.path, access);
}

/** The agent a card write assigns, or undefined when the write keeps the caller's own boundary. */
function readWorkboardTargetAgentId(value: unknown): string | undefined {
  const agentId = readStringValue(asOptionalRecord(value)?.agentId);
  if (!agentId?.trim()) {
    return undefined;
  }
  const normalized = normalizeAgentIdStrict(agentId);
  if (!normalized.ok) {
    // An explicit id the runtime cannot represent names no real agent, but dropping it
    // would keep the caller's boundary while the write still stores the raw id, and
    // `workboardSessionKeyForCard` would then launch it as the sanitized `agent` lane.
    // Fail closed on the unrepresentable assignment instead of silently ignoring it.
    throw new Error(
      `workboard card target agent "${agentId}" is not a valid agent id; assign a configured agent id.`,
    );
  }
  return normalized.value;
}

/**
 * True when the caller's own subagent delegation policy admits this card target.
 * Mirrors `resolveSubagentTargetPolicy`'s allowlist rule
 * (`src/agents/subagents/spawn/subagent-target-policy.ts`), which is not exposed
 * on a plugin-SDK surface; the roster intersection is already covered by the
 * configured-agent check in `resolveWorkboardTargetAgentAccess`, so only the
 * authored allowlist rule is repeated here. Without an allowlist the shipped
 * default keeps a requester self-only.
 */
function workboardCallerAdmitsDelegatedTarget(params: {
  config: WorkboardConfig;
  callerAgentId: string;
  targetAgentId: string;
}): boolean {
  const allowAgents =
    resolveAgentConfig(params.config, params.callerAgentId)?.subagents?.allowAgents ??
    params.config.agents?.defaults?.subagents?.allowAgents;
  if (!Array.isArray(allowAgents)) {
    return false;
  }
  return allowAgents.some((value) => {
    const allow = value?.trim();
    return Boolean(allow) && (allow === "*" || normalizeAgentId(allow) === params.targetAgentId);
  });
}

/**
 * The authority an assigned card records, or undefined when the write keeps the
 * caller's own boundary (no target, target is the caller, or no target config).
 * A card assigned to another agent runs as THAT agent, so it records the target's
 * runtime authority: the dispatcher resolves a sandboxed target to its own
 * workspace root and every other target to unrestricted access
 * (`resolveAgentWorkboardWorkspaceRuntime`). Stamping the creating caller's
 * boundary instead left cross-agent cards unstartable, because a non-sandboxed
 * target can never satisfy a restricted card's exact workspace root.
 * This validation layer never replaces that authority: it refuses a target with no
 * configured agent entry, and refuses a confined caller widening to a less-confined
 * target its own delegation policy does not admit.
 */
function resolveWorkboardTargetAgentAccess(params: {
  config: WorkboardConfig | undefined;
  callerAgentId: string | undefined;
  callerAccess: WorkboardWorkspaceAccess;
  targetAgentId: string | undefined;
}): WorkboardWorkspaceAccess | undefined {
  const targetAgentId = params.targetAgentId ? normalizeAgentId(params.targetAgentId) : undefined;
  const callerAgentId = params.callerAgentId?.trim()
    ? normalizeAgentId(params.callerAgentId)
    : undefined;
  // Without the target's effective configuration the caller's own boundary stays
  // in force; card-time authority never guesses.
  if (!targetAgentId || targetAgentId === callerAgentId || !params.config) {
    return undefined;
  }
  // An id with no configured agent entry names no real worker target. The sandbox
  // fallback below would read it as "not sandboxed" and hand over unrestricted
  // authority, so refuse it instead of guessing a boundary for it.
  if (!listAgentIds(params.config).includes(targetAgentId)) {
    throw new Error(
      `workboard card target agent "${targetAgentId}" is not a configured agent; assign a configured agent id.`,
    );
  }
  const targetAccess: WorkboardWorkspaceAccess = workboardTargetAgentIsSandboxed(
    params.config,
    targetAgentId,
  )
    ? {
        unrestricted: false,
        roots: [resolveAgentWorkspaceDir(params.config, targetAgentId)],
        writable: true,
      }
    : { unrestricted: true };
  // A confined caller handing a card to a less-confined target needs its own
  // delegation policy to admit that target; otherwise the assigned card would be an
  // escape from the caller's filesystem boundary. An unconfined caller cannot widen
  // this way, so its existing assignments keep working unchanged.
  if (
    !params.callerAccess.unrestricted &&
    targetAccess.unrestricted &&
    (!callerAgentId ||
      !workboardCallerAdmitsDelegatedTarget({
        config: params.config,
        callerAgentId,
        targetAgentId,
      }))
  ) {
    throw new Error(
      `workboard card target agent "${targetAgentId}" is not admitted by ${callerAgentId ?? "the confined caller"}'s subagents.allowAgents policy.`,
    );
  }
  return targetAccess;
}

/**
 * Effective sandbox state for another agent, with `resolveSandboxConfigForAgent`
 * precedence: `agents.entries.<id>.sandbox` over `agents.defaults.sandbox`.
 * Session-level sandbox overrides cannot exist before the card's worker session
 * does; dispatch re-validates the real target runtime either way.
 */
function workboardTargetAgentIsSandboxed(config: WorkboardConfig, agentId: string): boolean {
  const mode =
    resolveAgentConfig(config, agentId)?.sandbox?.mode ??
    config.agents?.defaults?.sandbox?.mode ??
    "off";
  return mode !== "off";
}

/**
 * An assigned target's explicit workspace must pass the dispatcher's own
 * workspace-bound check, which requires the exact target workspace root for a
 * restricted card; refuse it here with the same helpers instead of failing at start.
 */
async function assertWorkboardTargetWorkspaceMutationAccess(
  value: unknown,
  access: WorkboardWorkspaceAccess,
): Promise<void> {
  if (access.unrestricted) {
    return;
  }
  for (const record of workspaceMutationRecords(value)) {
    for (const workspace of [record.workspace, record.defaultWorkspace]) {
      const candidate = asOptionalRecord(workspace);
      const canonical = await assertPathAllowed(candidate?.sourcePath ?? candidate?.path, access);
      if (canonical) {
        await assertCanonicalWorkboardRootAccess(canonical, access);
      }
    }
  }
}

export function guardWorkboardToolsForWorkspaceAccess(
  tools: AnyAgentTool[],
  context: OpenClawPluginToolContext | undefined,
  resolveSandboxWorkspaceAuthority?: ResolveSandboxWorkspaceAuthority,
): AnyAgentTool[] {
  const workspaceAccess = resolveToolWorkboardWorkspaceAccess(
    context,
    resolveSandboxWorkspaceAuthority,
  );
  const config = context?.runtimeConfig ?? context?.getRuntimeConfig?.() ?? context?.config;
  const constrainCardWrite = async (
    toolName: string,
    params: Record<string, unknown>,
    canonicalAccess: WorkboardWorkspaceAccess,
  ): Promise<Record<string, unknown>> => {
    // Assignment validation only: no authority is stamped, but an unknown target or a
    // confined caller widening to a less-confined one is refused. Reassignment and
    // agentId-only specification otherwise change a card's lane without any check.
    const validateAssignedTarget = (value: Record<string, unknown>): void => {
      resolveWorkboardTargetAgentAccess({
        config,
        callerAgentId: context?.agentId,
        callerAccess: canonicalAccess,
        targetAgentId: readWorkboardTargetAgentId(value),
      });
    };
    // Records another agent's runtime authority, or undefined when this write keeps the
    // caller's own boundary (no target named, target is the caller, or no target config).
    // `resolveWorkboardTargetAgentAccess` performs the roster and widening checks, so the
    // assignment validation above is a strict subset of what this path already runs.
    const stampOtherAgentTarget = async (
      value: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> => {
      const targetAccess = resolveWorkboardTargetAgentAccess({
        config,
        callerAgentId: context?.agentId,
        callerAccess: canonicalAccess,
        targetAgentId: readWorkboardTargetAgentId(value),
      });
      if (!targetAccess) {
        return undefined;
      }
      const canonicalTargetAccess = await canonicalizeWorkboardWorkspaceAccess(targetAccess);
      await assertWorkboardTargetWorkspaceMutationAccess(value, canonicalTargetAccess);
      return withWorkboardWorkspaceAccess(value, canonicalTargetAccess);
    };
    const writeTarget = async (value: Record<string, unknown>): Promise<Record<string, unknown>> =>
      // The unchanged path keeps the exact access object the guard has always stamped.
      (await stampOtherAgentTarget(value)) ?? withWorkboardWorkspaceAccess(value, canonicalAccess);
    if (toolName === "workboard_create") {
      return await writeTarget(params);
    }
    if (toolName === "workboard_decompose" && Array.isArray(params.children)) {
      return {
        ...params,
        children: await Promise.all(
          params.children.map((child) => writeTarget(asOptionalRecord(child) ?? {})),
        ),
      };
    }
    if (toolName === "workboard_specify") {
      // A specify that carries a workspace mutation keeps the caller's boundary exactly as
      // before; one that only re-assigns the card records the new target's authority,
      // because the assignment is what the dispatcher resolves the worker against. Leaving
      // the previous owner's authority in place would dispatch this target against roots
      // that were never its own.
      return containsWorkboardWorkspaceMutation(params)
        ? await writeTarget(params)
        : ((await stampOtherAgentTarget(params)) ?? params);
    }
    if (toolName === "workboard_reassign") {
      validateAssignedTarget(params);
      return params;
    }
    return params;
  };
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      const canonicalAccess = await canonicalizeWorkboardWorkspaceAccess(workspaceAccess);
      await assertWorkboardWorkspaceMutationAccess(rawParams, canonicalAccess);
      const sanitizedParams = withoutWorkboardWorkspaceAccess(rawParams);
      return await tool.execute(
        toolCallId,
        await constrainCardWrite(tool.name, sanitizedParams, canonicalAccess),
        signal,
        onUpdate,
      );
    },
  }));
}
