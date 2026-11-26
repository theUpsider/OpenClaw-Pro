import { Type } from "typebox";

// A configured endpoint is a loopback origin only; it never grants access to
// arbitrary private hosts.
const LOCAL_BASE_URL_PATTERN =
  "^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]{1,5})?/?$";
const localBaseUrlPattern = new RegExp(LOCAL_BASE_URL_PATTERN);

export const ConfigSchema = Type.Object(
  {
    baseUrl: Type.Optional(Type.String({ maxLength: 128, pattern: LOCAL_BASE_URL_PATTERN })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 30000 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 65536, default: 4096 })),
  },
  { additionalProperties: false },
);

export type RuntimeConfig = { baseUrl?: string; timeoutMs: number; maxTokens: number };
export type ResolvedRuntimeConfig = { baseUrl: string; timeoutMs: number; maxTokens: number };

/** Normalize a configured loopback origin, rejecting paths, credentials, or ambiguity. */
export function localBaseUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed =
    typeof value === "string" && value === value.trim() && localBaseUrlPattern.test(value)
      ? URL.parse(value)
      : null;
  if (!parsed) {
    throw new Error(
      "Invalid Example baseUrl; use an http(s) loopback origin without a path, credentials, query, or fragment.",
    );
  }
  return parsed.origin;
}

/** Validate runtime settings; the endpoint is unauthenticated so no credential is read. */
export function runtimeConfig(config: Record<string, unknown> | undefined): RuntimeConfig {
  const baseUrl = localBaseUrl(config?.baseUrl);
  const timeoutMs = config?.timeoutMs ?? 30000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  ) {
    throw new Error("Invalid Example configuration; check plugin Settings.");
  }
  const maxTokens = config?.maxTokens ?? 4096;
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 256 ||
    maxTokens > 65536
  ) {
    throw new Error("Invalid Example configuration; check plugin Settings.");
  }
  return { baseUrl, timeoutMs, maxTokens };
}
