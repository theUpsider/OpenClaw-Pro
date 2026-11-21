import os from "node:os";
// Resolves the memory cap for one local check run.
//
// This policy is a sibling of `local-check-runtime.mts` rather than a member of it:
// that module is a runtime leaf that many fixtures copy standalone, and widening its
// imports silently breaks them. The shared helpers here are the repository's existing
// owners of the Boolean token language, the CI language, and host capacity.
import { parsePermissiveBooleanToken } from "./arg-utils.mts";
import { isLocalCheckEnabled, resolveCheckMemoryCapacityBytes } from "./local-check-runtime.mts";
import { isCiLikeEnv } from "./vitest-local-scheduling.mts";

const GIB = 1024 ** 3;
const MEMORY_MIB = 1024 ** 2;
const LOCAL_CHECK_MEMORY_LIMIT_ENV = "OPENCLAW_LOCAL_CHECK_MEMORY_LIMIT_MB";
const LOCAL_CHECK_NO_MEMORY_LIMIT_ENV = "OPENCLAW_LOCAL_CHECK_NO_MEMORY_LIMIT";
const MEMORY_LIMIT_OVERRIDE_PATTERN = /^[1-9]\d*$/u;
const UNAVAILABLE_REASON_MAX_LENGTH = 120;

/** The compiler ceiling chosen for one local run, and where that number came from. */
export type LocalCheckMemoryLimit = { limitBytes: number; source: "override" | "capacity" };

/** Host facts the cap is derived from; `memoryCapacityBytes` is null when unknown. */
export type LocalCheckMemoryHostResources = {
  logicalCpuCount: number;
  totalMemoryBytes: number;
  memoryCapacityBytes?: number | null;
};

// Fixed numbers instead of an adaptive formula: a cap that follows momentary host
// pressure is not auditable and can starve the legitimate run it should protect.
/** Headroom the host and Gateway keep outside one capped compiler run. */
export const LOCAL_CHECK_MEMORY_RESERVE_BYTES = 4 * GIB;
/** Below this a cap would kill legitimate runs instead of protecting the host. */
export const LOCAL_CHECK_MEMORY_MIN_BYTES = 8 * GIB;
/** Observed legitimate local peak is 15-18 GiB; one run is bounded near 1.3x that. */
export const LOCAL_CHECK_MEMORY_CEILING_BYTES = 24 * GIB;

/**
 * Report one run that proceeds without a cap. Every caller shares this wording so an
 * operator reads the same sentence whichever reason degraded the cap, and the
 * documented opt-out is discoverable from the message itself.
 */
export function reportLocalCheckMemoryUnavailable(reason: string) {
  const normalized = reason.replace(/\s+/gu, " ").trim().slice(0, UNAVAILABLE_REASON_MAX_LENGTH);
  console.error(
    `[tsgo] local memory cap unavailable on this host (${normalized || "unknown reason"}); running uncapped. Set ${LOCAL_CHECK_NO_MEMORY_LIMIT_ENV}=1 to run always uncapped.`,
  );
}

function isLocalCheckMemoryLimitDisabled(env: NodeJS.ProcessEnv) {
  return parsePermissiveBooleanToken(env[LOCAL_CHECK_NO_MEMORY_LIMIT_ENV]) === true;
}

function parseLocalCheckMemoryLimitOverride(raw: string) {
  const mebibytes = MEMORY_LIMIT_OVERRIDE_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  const limitBytes = mebibytes * MEMORY_MIB;
  // A rejected override is a configuration error, never a silent fallback to the
  // hardware-derived cap: the operator asked for one specific number.
  if (!Number.isSafeInteger(mebibytes) || !Number.isSafeInteger(limitBytes)) {
    throw new Error(
      `${LOCAL_CHECK_MEMORY_LIMIT_ENV} must be a positive whole number of mebibytes with no sign, leading zero, exponent, or decimal point (for example 12288); got ${JSON.stringify(raw)}. Unset to fall back to the automatic host cap, or set ${LOCAL_CHECK_NO_MEMORY_LIMIT_ENV}=1 to run uncapped.`,
    );
  }
  return limitBytes;
}

/**
 * Read this host's usable memory ceiling without loading source-tree modules.
 *
 * This runs on the compiler start path, and that path must not resolve a
 * `packages/**` dependency before the sparse-checkout guard can report a missing
 * project (see the note in `run-tsgo.mts`). `process.constrainedMemory()` reports
 * the effective cgroup/rlimit ceiling — measured equal to
 * `readProcessMemoryCapacity({}).capacityBytes` on this host — while `os.totalmem()`
 * is the physical total; null means neither is known, which the policy degrades
 * instead of guessing.
 */
export function resolveLocalCheckHostMemoryCapacityBytes(): number | null {
  const totalMemoryBytes = os.totalmem();
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return null;
  }
  const constrainedBytes = process.constrainedMemory();
  return Number.isFinite(constrainedBytes) && constrainedBytes > 0
    ? Math.min(totalMemoryBytes, constrainedBytes)
    : totalMemoryBytes;
}

/**
 * Resolve the memory cap for one local check run, or null when the run stays uncapped.
 * Precedence is fixed and first match wins, so an explicit local/CI/opt-out decision
 * always outranks a stale override and an unknown capacity degrades instead of guessing.
 */
export function resolveLocalCheckMemoryLimit(
  hostResources: LocalCheckMemoryHostResources,
  env: NodeJS.ProcessEnv = process.env,
): LocalCheckMemoryLimit | null {
  if (!isLocalCheckEnabled(env)) {
    return null;
  }
  if (isCiLikeEnv(env)) {
    return null;
  }
  if (isLocalCheckMemoryLimitDisabled(env)) {
    return null;
  }
  const overrideMebibytes = env[LOCAL_CHECK_MEMORY_LIMIT_ENV]?.trim();
  if (overrideMebibytes) {
    return {
      limitBytes: parseLocalCheckMemoryLimitOverride(overrideMebibytes),
      source: "override",
    };
  }
  // An explicit null means capacity discovery failed, while a numeric zero is a
  // known (if useless) budget. Collapsing the two would either guess from an
  // unreadable host or refuse a cap the operator can still enforce.
  if (hostResources.memoryCapacityBytes === null) {
    reportLocalCheckMemoryUnavailable("host memory capacity unknown");
    return null;
  }
  const capacityBytes = resolveCheckMemoryCapacityBytes(hostResources);
  if (!Number.isFinite(capacityBytes)) {
    reportLocalCheckMemoryUnavailable("host memory capacity unreadable");
    return null;
  }
  // A capacity of zero still clamps up to the floor instead of reporting unknown.
  return {
    limitBytes: Math.max(
      LOCAL_CHECK_MEMORY_MIN_BYTES,
      Math.min(LOCAL_CHECK_MEMORY_CEILING_BYTES, capacityBytes - LOCAL_CHECK_MEMORY_RESERVE_BYTES),
    ),
    source: "capacity",
  };
}
