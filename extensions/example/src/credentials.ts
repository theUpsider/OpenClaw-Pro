import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runtimeConfig, type RuntimeConfig } from "./config.js";

/**
 * Read this plugin's validated config from the host snapshot. The loopback
 * endpoint is unauthenticated, so no secret input is resolved.
 */
export function resolveRuntimeConfig(
  snapshot: ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>,
): RuntimeConfig {
  return runtimeConfig(snapshot.plugins?.entries?.example?.config);
}
