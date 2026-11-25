// Workboard test API exposes only the plugin's real entry points to core-level suites,
// which must not reach into extensions/<id>/src.
export { resolveAgentWorkboardWorkspaceRuntime } from "./src/workspace-access.js";
