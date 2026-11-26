/**
 * The path guard for tools that do not go through the coding-tool factory.
 *
 * Kept in its own module because the model-provider policy needs it while `agent-tools.read` already
 * imports that policy: importing the guard back from there would close a cycle.
 */
import { getToolParamsRecord, normalizeFileToolPathParam } from "./agent-tools.params.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { resolveSandboxPathMapping } from "./path-policy.js";
import {
  isPathDenied,
  pathScopeDeniedError,
  type ResolvedPathScopePolicy,
} from "./path-scope-policy.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

/** Normalize a path parameter that may be a single string or a list of strings. */
function collectPathParamValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/** Refuse a covered path with the missing-file shape, before any root admission can speak. */
export function refuseCoveredPath(
  policy: ResolvedPathScopePolicy | undefined,
  candidatePath: string,
  cwd?: string,
): void {
  if (isPathDenied(policy, candidatePath, cwd)) {
    throw pathScopeDeniedError(candidatePath);
  }
}

/**
 * Apply the per-model path rules to a tool that takes paths but is not built by the coding tools.
 *
 * Each named parameter may be a single path or a list; a batch cannot smuggle one covered path past
 * the others, because a refusal aborts the whole call.
 */
export function wrapToolWithPathScopeGuard(
  tool: AnyAgentTool,
  options: {
    pathScopePolicy?: ResolvedPathScopePolicy;
    resolutionCwd?: string;
    pathParamKeys?: readonly string[];
    /** Present for sandboxed tools: container paths map to the host paths the rules name. */
    bridge?: SandboxFsBridge;
  },
): AnyAgentTool {
  if (!options.pathScopePolicy || options.pathScopePolicy.entries.length === 0) {
    return tool;
  }
  const pathParamKeys =
    options.pathParamKeys && options.pathParamKeys.length > 0 ? options.pathParamKeys : ["path"];
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record = getToolParamsRecord(args);
      for (const key of pathParamKeys) {
        for (const rawFilePath of collectPathParamValues(record?.[key])) {
          const filePath = await normalizeFileToolPathParam(
            rawFilePath,
            options.resolutionCwd ?? process.cwd(),
            options.bridge,
          );
          refuseCoveredPath(
            options.pathScopePolicy,
            toHostScopePath(filePath, options),
            options.resolutionCwd,
          );
        }
      }
      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

/** Map a sandbox's container path onto the host location the rules are written against. */
export function toHostScopePath(
  value: string,
  options: { bridge?: SandboxFsBridge; resolutionCwd?: string },
): string {
  const bridge = options.bridge;
  if (!bridge) {
    return value;
  }
  // A remote sandbox reports no host path at all, but it still declares its mount table; projecting
  // through that table is what lets the rules match there instead of comparing container to host.
  const mapped = resolveSandboxPathMapping(bridge.pathMappings ?? [], value);
  if (mapped) {
    return mapped.hostPath;
  }
  try {
    return bridge.resolvePath({ filePath: value, cwd: options.resolutionCwd }).hostPath || value;
  } catch {
    return value;
  }
}
