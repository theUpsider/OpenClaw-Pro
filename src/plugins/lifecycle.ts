import type { ConfigReplaceResult } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  formatBundledPluginDevReloadWarning,
  resolveBundledPluginDevReloadMode,
} from "./bundled-plugin-dev-reload.js";
import { inspectPluginGenerationSources } from "./plugin-generation-source-inspection.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { getPluginRuntimeEntrySource } from "./plugin-runtime-artifact-binding.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistryVersion } from "./runtime.js";

export const getPluginRuntimeGeneration = getActivePluginRegistryVersion;

/** Carries the install persistence owner’s durable-commit fact, including across RPC. */
export class PluginInstallPersistedError extends Error {
  constructor(
    readonly pluginId: string,
    cause: unknown,
  ) {
    super(
      `${formatErrorMessage(cause)}
Plugin "${pluginId}" installation is saved. Fix the reported issue, then run \`openclaw plugins reload ${pluginId}\`.`,
      { cause },
    );
    this.name = "PluginInstallPersistedError";
  }
}

export class PluginRuntimeApplicationError extends Error {
  constructor(
    message: string,
    readonly details: {
      operationId: string;
      generation: number;
      pluginIds: string[];
      phase: "prepare" | "drain" | "activate" | "dispose";
      committed: boolean;
      /** The failed replacement also could not restore model/reply publication. */
      runtimeRestorationFailed?: true;
    },
    options?: ErrorOptions,
  ) {
    super(
      `${message}\nGateway generation ${details.generation}: replacement ${details.committed ? "applied" : "not applied"}.`,
      options,
    );
    this.name = "PluginRuntimeApplicationError";
  }
}

/** A receipt describes the published runtime, never authority to invoke it. */
export type PluginRuntimeApplication = {
  operationId: string;
  generation: number;
  pluginIds: string[];
  sourceDigests?: Record<string, string>;
  selectedEntries?: Record<string, string>;
  /** Registration applied, but process-shared code needs a Gateway restart. */
  restartRequired?: boolean;
  warnings?: string[];
};

export type PluginLifecycleReason =
  | "install"
  | "enable"
  | "disable"
  | "uninstall"
  | "reload"
  | "metadata";

/** Honest restart notice for a non-bundled plugin whose live code is no longer the
 *  current source on disk. Unlike bundled code this is rare: an explicit reload
 *  re-evaluates config/path plugins, so the live generation normally already runs
 *  the current bytes. It only happens when the running owner was retained (for
 *  example a recovered generation) while the file changed underneath it. */
const CONFIG_PLUGIN_CODE_RELOAD_WARNING =
  "Reloaded plugin code is not the current source on disk. New dispatches after the next Gateway restart will load the edited code; calls already accepted before the reload keep their previous generation's code until they finish.";

/**
 * True when a non-bundled plugin's captured live code no longer matches the source on
 * disk. Mirrors the bundled shared-code identity check for the generation-replacement
 * path, so a config/path plugin that retained code can report restartRequired honestly
 * instead of implying the swap reached every call.
 */
function configPluginCodeIsStale(record: PluginRecord, instance: { sourceDigest?: string }) {
  const live = instance.sourceDigest;
  if (!live || !record.rootDir) {
    return !live;
  }
  try {
    const byEntry = inspectPluginGenerationSources([
      { pluginId: record.id, rootDir: record.rootDir, entryFile: record.source },
    ]).sourceDigests[record.id];
    const byRoot = inspectPluginGenerationSources([
      { pluginId: record.id, rootDir: record.rootDir },
    ]).sourceDigests[record.id];
    // Match the loader's own capture policy either way; only a digest that is neither
    // available form proves the running code is not the current disk bytes.
    if (!byEntry && !byRoot) {
      return true;
    }
    return live !== byEntry && live !== byRoot;
  } catch {
    // Files unreadable or changed mid-capture: report honestly rather than claim success.
    return true;
  }
}

/** Project the published registry's captured-code facts into its application receipt. */
export function createPluginRuntimeApplication(params: {
  operationId: string;
  generation: number;
  registry: PluginRegistry;
  pluginIds: ReadonlySet<string>;
  reloadPluginIds?: ReadonlySet<string>;
  warnings: readonly string[];
}): PluginRuntimeApplication {
  const sourceDigests = new Map<string, string>();
  const selectedEntries = new Map<string, string>();
  const restartWarnings = new Set<string>();
  const devReloadWarnings = new Set<string>();
  for (const record of params.registry.plugins) {
    if (!params.pluginIds.has(record.id)) {
      continue;
    }
    const instance = getPluginInstance(record);
    const entry = getPluginRuntimeEntrySource(record);
    if (instance && record.status === "loaded" && entry) {
      selectedEntries.set(record.id, entry);
    }
    if (instance?.sourceDigest) {
      sourceDigests.set(record.id, instance.sourceDigest);
    }
    if (
      params.reloadPluginIds?.has(record.id) &&
      record.enabled &&
      record.status === "loaded" &&
      instance &&
      record.origin === "bundled"
    ) {
      // Only a development reload's capture gives a bundled runtime instance a source digest.
      if (instance.sourceDigest) {
        devReloadWarnings.add(formatBundledPluginDevReloadWarning(record.id));
        continue;
      }
      restartWarnings.add(
        "Bundled plugin code is owned by the running Gateway. Restart the Gateway to load updated code; rebuild first when using compiled output.",
      );
      const ignored = resolveBundledPluginDevReloadMode().ignoredWarning;
      if (ignored) {
        restartWarnings.add(ignored);
      } else if (record.origin !== "bundled" && configPluginCodeIsStale(record, instance)) {
        restartWarnings.add(CONFIG_PLUGIN_CODE_RELOAD_WARNING);
      }
    }
  }
  const warnings = [...restartWarnings, ...devReloadWarnings, ...params.warnings];
  return {
    operationId: params.operationId,
    generation: params.generation,
    pluginIds: [...params.pluginIds].toSorted(),
    sourceDigests: Object.fromEntries(sourceDigests),
    selectedEntries: Object.fromEntries(selectedEntries),
    ...(restartWarnings.size ? { restartRequired: true } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export type PluginLifecycleRuntimeApply = (params: {
  config: OpenClawConfig;
  write?: Pick<ConfigReplaceResult, "persistedHash" | "persistedSourceConfig">;
  pluginIds: readonly string[];
  reason: PluginLifecycleReason;
  /** Explicit reload admission wait; cancellation never owns recovery or published cleanup. */
  waitForDrain?: boolean;
  drainSignal?: AbortSignal;
  expectedSourceDigests?: Readonly<Record<string, string>>;
  /** Private invoker authority; never part of the published runtime receipt. */
  assertInvokerOwned?: () => void;
}) => Promise<PluginRuntimeApplication>;

/** Capture publications independently of later management or authority failures. */
export function capturePluginRuntimeApplications(applyRuntime: PluginLifecycleRuntimeApply) {
  let application: PluginRuntimeApplication | undefined;
  return {
    get application() {
      return application;
    },
    applyRuntime: async (params: Parameters<PluginLifecycleRuntimeApply>[0]) => {
      const next = await applyRuntime(params);
      const warnings = [...new Set([...(application?.warnings ?? []), ...(next.warnings ?? [])])];
      // Later publications replace generation facts, not earlier cleanup outcomes.
      application = warnings.length ? { ...next, warnings } : next;
      return application;
    },
  };
}

export function projectPluginRuntimeFailure(
  error: unknown,
  application?: PluginRuntimeApplication,
) {
  const persisted = error instanceof PluginInstallPersistedError ? error : undefined;
  const cause = persisted ? persisted.cause : error;
  const attempt = cause instanceof PluginRuntimeApplicationError ? cause.details : undefined;
  // A later rejected replacement does not undo an earlier publication in this operation.
  const previous = application && !attempt?.committed ? application : undefined;
  return {
    message:
      formatErrorMessage(cause) +
      (previous
        ? `\nAn earlier runtime change from this operation was applied in Gateway generation ${previous.generation}.`
        : ""),
    runtime: previous ? { ...previous, committed: true } : attempt,
    ...(previous && attempt ? { runtimeAttempt: attempt } : {}),
    ...(persisted
      ? { persistence: { operation: "install" as const, pluginId: persisted.pluginId } }
      : {}),
  };
}
