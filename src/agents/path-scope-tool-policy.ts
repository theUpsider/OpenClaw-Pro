/**
 * Per-model path rules for the tools that are not built by the coding-tool factory.
 *
 * The coding tools meet the rules through their own guard. Image, PDF and `view_image` are registered
 * elsewhere and still accept paths, so they need the same treatment; without it they would be a
 * second way to a concealed path.
 *
 * This module is deliberately free of coding-tool imports: reaching into `agent-tools.read` from the
 * model-provider policy created an import cycle, and a small owner with one job is the cheaper fix.
 */
import type { AnyAgentTool } from "./agent-tools.types.js";
import { resolvePathScopePolicy, type ResolvedPathScopePolicy } from "./path-scope-policy.js";
import { wrapToolWithPathScopeGuard } from "./path-scope-tool-guard.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

/**
 * Tools that accept file paths and are built outside the coding-tool factory.
 *
 * The list is explicit on purpose: a new path-taking tool must be added here, which the coverage test
 * asserts, instead of quietly bypassing the per-model path rules.
 */
const PATH_SCOPE_PATH_PARAMS: Record<string, readonly string[]> = {
  view_image: ["path", "paths"],
  pdf: ["pdf", "pdfs"],
};

/** Names of the tools this module guards; exported for the coverage test. */
export function listPathScopeGuardedToolNames(): readonly string[] {
  return Object.keys(PATH_SCOPE_PATH_PARAMS).toSorted();
}

/** Apply an already-resolved policy to whichever tools in a list accept paths. */
export function applyResolvedPathScopeToTools(
  tools: readonly AnyAgentTool[],
  params: {
    pathScopePolicy?: ResolvedPathScopePolicy;
    resolutionCwd?: string;
    /** Sandbox bridge, so a container path maps to the host path the rules name. */
    bridge?: SandboxFsBridge;
  },
): AnyAgentTool[] {
  const policy = params.pathScopePolicy;
  if (!policy || policy.entries.length === 0) {
    return [...tools];
  }
  return tools.map((tool) => {
    const pathParamKeys = PATH_SCOPE_PATH_PARAMS[tool.name];
    return pathParamKeys
      ? wrapToolWithPathScopeGuard(tool, {
          pathScopePolicy: policy,
          resolutionCwd: params.resolutionCwd,
          pathParamKeys,
          ...(params.bridge ? { bridge: params.bridge } : {}),
        })
      : tool;
  });
}

/** Resolve the run's policy and apply it to the path-taking tools in a finished list. */
export function applyPathScopeToPathTakingTools(
  tools: readonly AnyAgentTool[],
  params: {
    cfg?: import("../config/types.openclaw.js").OpenClawConfig;
    agentId?: string;
    modelProvider?: string;
    modelId?: string;
    resolutionCwd?: string;
  },
): AnyAgentTool[] {
  return applyResolvedPathScopeToTools(tools, {
    pathScopePolicy: resolvePathScopePolicy({
      cfg: params.cfg,
      agentId: params.agentId,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
      cwd: params.resolutionCwd,
    }),
    resolutionCwd: params.resolutionCwd,
  });
}
