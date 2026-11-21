import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { filterLocalModelLeanTools } from "./local-model-lean.js";
import { resolveNativeWebSearchRoute } from "./native-web-search.js";
import { resolvePathScopePolicy } from "./path-scope-policy.js";
import { applyResolvedPathScopeToTools } from "./path-scope-tool-policy.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { WebSearchToolPolicyParams } from "./web-search-tool-policy.js";

export function applyModelProviderToolPolicy(
  toolsInput: AnyAgentTool[],
  params?: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelApi?: string;
    modelBaseUrl?: string;
    modelId?: string;
    agentId?: string;
    sessionKey?: string;
    agentDir?: string;
    preparedModelRuntime?: Pick<PreparedModelRuntimeSnapshot, "metadataSnapshot">;
    modelCompat?: ModelCompatConfig;
    suppressManagedWebSearch?: boolean;
    runtimeToolAllowlist?: string[];
    preparedRequesterPolicy?: WebSearchToolPolicyParams["preparedRequesterPolicy"];
    localModelLeanPreserveToolNames?: string[];
    /** Run workspace; resolves a relative path for the tools guarded here. */
    workspaceDir?: string;
    /** Sandbox bridge, so a container path is matched against the host rules. */
    sandboxBridge?: SandboxFsBridge;
  },
): AnyAgentTool[] {
  const tools = filterLocalModelLeanTools({
    tools: toolsInput,
    config: params?.config,
    agentId: params?.agentId,
    sessionKey: params?.sessionKey,
    preserveToolNames: params?.localModelLeanPreserveToolNames ?? params?.runtimeToolAllowlist,
  });

  if (
    params?.suppressManagedWebSearch !== false &&
    resolveNativeWebSearchRoute({
      config: params?.config,
      modelProvider: params?.modelProvider,
      modelApi: params?.modelApi,
      modelBaseUrl: params?.modelBaseUrl,
      modelId: params?.modelId,
      agentId: params?.agentId,
      sessionKey: params?.sessionKey,
      agentDir: params?.agentDir,
      runtimeToolAllowlist: params?.runtimeToolAllowlist,
      preparedRequesterPolicy: params?.preparedRequesterPolicy,
      pluginMetadataSnapshot: params?.preparedModelRuntime?.metadataSnapshot,
    }).kind === "native"
  ) {
    return filterShellToolsForPathScope(
      tools.filter((tool) => tool.name !== "web_search"),
      params,
    );
  }
  return filterShellToolsForPathScope(tools, params);
}
/**
 * Remove exec/process while path rules are active, and guard path-taking tools built elsewhere.
 *
 * Command text is not path-checked, so an open shell can reach a concealed path through a glob, a
 * base64 payload or a script. The operator can keep the shell with an explicit
 * `allowExecWithEntries`, which is then a documented best-effort boundary rather than a promise.
 *
 * The same policy covers the image and PDF tools, which their own factory registers and which would
 * otherwise be a second way to a concealed path.
 */
function filterShellToolsForPathScope(
  tools: AnyAgentTool[],
  params?: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelId?: string;
    agentId?: string;
    workspaceDir?: string;
    /** Sandbox bridge, so a container path is matched against the host rules. */
    sandboxBridge?: SandboxFsBridge;
  },
): AnyAgentTool[] {
  const policy = resolvePathScopePolicy({
    cfg: params?.config,
    agentId: params?.agentId,
    modelProvider: params?.modelProvider,
    modelId: params?.modelId,
  });
  if (!policy) {
    return tools;
  }
  const pathGuarded = applyResolvedPathScopeToTools(tools, {
    pathScopePolicy: policy,
    resolutionCwd: params?.workspaceDir,
    ...(params?.sandboxBridge ? { bridge: params.sandboxBridge } : {}),
  });
  if (policy.entries.length === 0 || policy.allowExecWithEntries) {
    return pathGuarded;
  }
  return pathGuarded.filter((tool) => tool.name !== "exec" && tool.name !== "process");
}
