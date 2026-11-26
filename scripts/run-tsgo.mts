// Runs the type checker (tsrs; tsgo where tsrs ships no binary) through local resource
// policy and sparse-checkout guards.
import { spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { ensureKyselyTypes } from "./generate-kysely-types.mts";
import { readFlagValue } from "./lib/arg-utils.mts";
import { parseStaticDiagnostics } from "./lib/ci-static-check-evidence.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  reportLocalCheckMemoryUnavailable,
  resolveLocalCheckHostMemoryCapacityBytes,
  resolveLocalCheckMemoryLimit,
} from "./lib/local-check-memory-limit.mts";
import {
  applyLocalTsgoPolicy,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
  resolveTypeCheckTool,
} from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { readPositiveEnvInt } from "./lib/numeric-options.mjs";
import { findRepoRoot } from "./lib/repo-root.mjs";
import {
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "./lib/tsgo-sparse-guard.mts";

// Declared locally, as sibling scripts do, rather than imported from packages/:
// a static import there resolves before the sparse-checkout guard can report a
// missing project, turning a clean skip into ERR_MODULE_NOT_FOUND. Mirrors
// normalization-core's MAX_TIMER_TIMEOUT_MS.
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

/**
 * Payload of the throwaway enforcement probe scope.
 *
 * It runs inside the scope the probe created and fails unless the kernel's own
 * files report the limits that scope requested: `memory.max` bounded at the probe
 * value, `memory.swap.max` zero, and `memory.oom.group` set. Reading the effective
 * kernel state (not the accepted properties) is what separates "the manager took
 * the request" from "the host enforces it".
 */
const LOCAL_TSGO_CAP_PROBE_PAYLOAD = [
  'const fs = require("node:fs");',
  "const [maxArg] = process.argv.slice(1);",
  "const wantMax = Number(maxArg);",
  'const record = fs.readFileSync("/proc/self/cgroup", "utf8").split("\\n").find((line) => line.startsWith("0::"));',
  "if (!record) process.exit(1);",
  'const rel = record.slice(3).trim().replace(/^\\//, "");',
  'const dir = require("node:path").join("/sys/fs/cgroup", rel);',
  'const read = (name) => { try { return fs.readFileSync(require("node:path").join(dir, name), "utf8").trim(); } catch { return null; } };',
  'const max = read("memory.max");',
  'const swap = read("memory.swap.max");',
  'const oomGroup = read("memory.oom.group");',
  'const ok = max !== null && Number(max) > 0 && Number(max) <= wantMax && swap === "0" && oomGroup === "1";',
  "process.exit(ok ? 0 : 1);",
].join("\n");

export function resolveTsgoTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  if (!env.OPENCLAW_TSGO_TIMEOUT_MS?.trim()) {
    return undefined;
  }
  return Math.min(
    readPositiveEnvInt("OPENCLAW_TSGO_TIMEOUT_MS", env, MAX_TIMER_TIMEOUT_MS),
    MAX_TIMER_TIMEOUT_MS,
  );
}

/** Prepare one compiler invocation; the caller owns its process group and deadline. */
export function prepareTsgoCommand(
  args: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const hostResources = {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
  const { args: finalArgs, env } = applyLocalTsgoPolicy(
    args,
    resolveLocalCheckEnv(baseEnv),
    hostResources,
  );

  const sparseGuardError = getSparseTsgoGuardError(finalArgs, { cwd });
  if (sparseGuardError) {
    if (shouldSkipSparseTsgoGuardError(env)) {
      console.error(sparseGuardError);
      console.error("[tsgo] skipping sparse-missing project because OPENCLAW_TSGO_SPARSE_SKIP=1");
      return null;
    }
    throw new Error(sparseGuardError);
  }

  // The start path owns the cap, so every local tsgo invocation is bounded the same
  // way regardless of command spelling, scoped config, or caller. `env` here is
  // already the resolved local-check environment handed to the compiler.
  const memoryLimit = resolveLocalCheckMemoryLimit(
    { ...hostResources, memoryCapacityBytes: resolveLocalCheckHostMemoryCapacityBytes() },
    env,
  );

  // Subdirectories share checkout ownership, but another checkout's install never does.
  const compilerPath = resolveRepoToolBinPath(
    resolveTypeCheckTool(process.platform, process.arch, env, finalArgs),
    {
      cwd: findRepoRoot(cwd) ?? cwd,
    },
  );
  let timeoutMs: number | undefined;
  try {
    timeoutMs = resolveTsgoTimeoutMs(env);
  } catch {
    throw new Error(
      `[tsgo] OPENCLAW_TSGO_TIMEOUT_MS must be plain decimal digits with no leading zero, sign, exponent, or decimal point, between 1 and ${Number.MAX_SAFE_INTEGER}; got ${env.OPENCLAW_TSGO_TIMEOUT_MS}. Unset it to disable the watchdog.`,
    );
  }
  return {
    args: finalArgs,
    bin: compilerPath,
    cwd,
    env,
    memoryLimitBytes: memoryLimit?.limitBytes,
    shell: process.platform === "win32",
    timeoutMs,
  };
}

/**
 * Probe the containment backend before a capped run starts.
 *
 * The probe answers three separate questions, because accepting a property is
 * not the same as enforcing it:
 *   1. a throwaway scope name reports `LoadState=not-found` on a working
 *      cgroup-v2 user manager (the manager answers at all);
 *   2. one throwaway *bounded* scope starts (a `systemd-run` on PATH plus the
 *      permission to apply the properties);
 *   3. inside that scope, the kernel's own effective limits are read back —
 *      `memory.max` bounded, `memory.swap.max` zero, `memory.oom.group` set —
 *      so a host that silently drops the properties does not pass.
 * Anything else — a non-Linux platform, an unreachable user bus, a missing
 * `systemctl`/`systemd-run`, or a manager that cannot enforce the scope — means
 * the cap cannot be enforced here and the run must degrade instead of
 * hard-failing. Returns the reason the cap is unusable, or undefined when usable.
 */
export function probeLocalTsgoMemoryCap(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "linux") {
    return `unsupported platform ${process.platform}`;
  }
  const spawnOptions = {
    encoding: "utf8" as const,
    timeout: 5_000,
    killSignal: "SIGKILL" as const,
    env,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  const manager = spawnSync(
    "systemctl",
    ["--user", "show", "--property=LoadState", `openclaw-tsgo-cap-probe-${randomUUID()}.scope`],
    spawnOptions,
  );
  if (manager.error) {
    return `systemctl probe failed (${manager.error.code ?? manager.error.message})`;
  }
  if (!manager.stdout?.includes("LoadState=not-found")) {
    return "cgroup-v2 systemd user manager did not answer";
  }
  // The reachability answer above says nothing about enforcement: create one
  // throwaway bounded scope whose payload reads its own kernel limits back, so a
  // host that answers but cannot (or does not) apply the properties degrades here
  // instead of failing the real compiler launch.
  const probeLimitBytes = 16 * 1024 * 1024;
  const enforcement = spawnSync(
    "systemd-run",
    [
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      "--expand-environment=no",
      `--unit=openclaw-tsgo-cap-probe-${randomUUID()}.scope`,
      `--property=MemoryMax=${probeLimitBytes}`,
      "--property=MemorySwapMax=0",
      "--property=OOMPolicy=kill",
      "--",
      process.execPath,
      "-e",
      LOCAL_TSGO_CAP_PROBE_PAYLOAD,
      String(probeLimitBytes),
    ],
    spawnOptions,
  );
  if (enforcement.error) {
    return `systemd-run probe failed (${enforcement.error.code ?? enforcement.error.message})`;
  }
  if (enforcement.status !== 0) {
    return "cgroup-v2 systemd user manager cannot enforce a memory scope";
  }
  return undefined;
}

/**
 * Decide the cap for one local run immediately before it starts.
 *
 * This is a pre-start compatibility decision and never a retry: once the compiler
 * has been started its result — including an OOM kill — is final. The shared
 * containment primitive stays strict; only this local runner adapts to the host.
 */
export function resolveLocalTsgoRunMemoryLimit(command: {
  env?: NodeJS.ProcessEnv;
  memoryLimitBytes?: number;
}): number | undefined {
  if (command.memoryLimitBytes === undefined) {
    return undefined;
  }
  const unavailableReason = probeLocalTsgoMemoryCap(command.env ?? process.env);
  if (unavailableReason === undefined) {
    return command.memoryLimitBytes;
  }
  // Exactly one warning per run, and no second, uncapped attempt after this.
  reportLocalCheckMemoryUnavailable(unavailableReason);
  return undefined;
}

/**
 * Run one local tsgo command through the shared managed owner, applying the cap
 * only where the host can actually enforce it. The metrics path resolves the same
 * decision through `resolveLocalTsgoRunMemoryLimit` before its own managed call.
 */
export async function runLocalTsgoManagedCommand(
  command: Parameters<typeof runManagedCommand>[0],
): Promise<number> {
  return await runManagedCommand({
    ...command,
    memoryLimitBytes: resolveLocalTsgoRunMemoryLimit(command),
  });
}

/** The caller holds artifact ownership until this compiler and its output are joined. */
export async function runPreparedTsgoCommand(
  command: NonNullable<ReturnType<typeof prepareTsgoCommand>>,
  evidence: { evidenceId?: string; onEvidence?: () => void } = {},
): Promise<number> {
  try {
    await ensureKyselyTypes(findRepoRoot(command.cwd) ?? command.cwd);
    const tsBuildInfoFile = readFlagValue(command.args, "--tsBuildInfoFile");
    if (tsBuildInfoFile) {
      fs.mkdirSync(path.dirname(path.resolve(command.cwd, tsBuildInfoFile)), { recursive: true });
    }
    // Managed cleanup forwards SIGTERM before bounded SIGKILL escalation, then
    // joins the compiler group and output before reporting a timeout.
    const config = readFlagValue(command.args, "-p") ?? readFlagValue(command.args, "--project");
    const capture =
      command.env.OPENCLAW_CI_STATIC_EVIDENCE === "1" &&
      process.platform !== "win32" &&
      evidence.evidenceId !== undefined &&
      config !== undefined;
    const outputs: Buffer[][] = [[], []];
    const forwarding: Promise<void>[] = [];
    let capturedBytes = 0;
    let overflow = false;
    let interrupted = false;
    const managedCommand = {
      ...command,
      args: capture ? [...command.args, "--pretty", "false"] : command.args,
      requireProcessTreeExit: process.platform !== "win32",
      ...(capture
        ? {
            stdio: ["inherit", "pipe", "pipe"] satisfies StdioOptions,
            onSignal: () => {
              interrupted = true;
            },
            onReady: (child: ChildProcess) => {
              for (const [index, source] of [child.stdout, child.stderr].entries()) {
                if (!source) {
                  throw new Error("Missing compiler output pipe");
                }
                const target = index === 0 ? process.stdout : process.stderr;
                const output = new Writable({
                  write(chunk: Buffer, encoding, callback) {
                    capturedBytes += chunk.byteLength;
                    if (capturedBytes <= 1024 * 1024) {
                      outputs[index]!.push(chunk);
                    } else {
                      overflow = true;
                    }
                    target.write(chunk, encoding, callback);
                  },
                });
                const joined = finished(output);
                void joined.catch(() => {});
                forwarding.push(joined);
                source.pipe(output);
              }
            },
          }
        : {}),
    };
    const metricsDir = command.env.OPENCLAW_TSGO_METRICS_DIR?.trim();
    // Keep CI output capture and cleanup callbacks on the same managed invocation.
    const code = metricsDir
      ? await (
          await import("./lib/tsgo-performance.mts")
        ).runMeasuredTsgoCommand(
          {
            ...managedCommand,
            memoryLimitBytes: resolveLocalTsgoRunMemoryLimit(managedCommand),
          },
          metricsDir,
        )
      : await runLocalTsgoManagedCommand(managedCommand);
    await Promise.all(forwarding);
    const stdout = Buffer.concat(outputs[0]!).toString("utf8");
    const stderr = Buffer.concat(outputs[1]!).toString("utf8");
    const diagnostics = capture && !overflow && parseStaticDiagnostics(stdout, "tsgo");
    if (
      capture &&
      !interrupted &&
      !overflow &&
      stderr === "" &&
      ((code === 0 && stdout.trim() === "") ||
        (code === 2 && diagnostics && diagnostics.length > 0))
    ) {
      console.log(
        `[ci-static:tsgo:leaf] ${JSON.stringify({ version: 1, id: evidence.evidenceId, config, exitCode: code, stdout, stderr })}`,
      );
      evidence.onEvidence?.();
    }
    return code;
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code !== "ETIMEDOUT") {
      throw error;
    }
    console.error(
      `[tsgo] no completion after ${command.timeoutMs}ms; killed the tsgo process tree. Raise OPENCLAW_TSGO_TIMEOUT_MS for intentionally longer builds, or unset it to disable the watchdog.`,
    );
    // CI collectors stop admitting work for watchdog exit 124.
    return 124;
  }
}

async function main(): Promise<void> {
  let command: ReturnType<typeof prepareTsgoCommand>;
  try {
    command = prepareTsgoCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (!command) {
    return;
  }
  // Preflight must refuse or skip before installed bootstrap dependencies load.
  const { withDistArtifactOwnership } = await import("./lib/dist-artifact-ownership.mts");
  const id = randomUUID();
  const evidenceId = `${id}:0`;
  let verified = false;
  process.exitCode = await withDistArtifactOwnership(command.cwd, () =>
    runPreparedTsgoCommand(command, {
      evidenceId,
      onEvidence: () => {
        verified = true;
      },
    }),
  );
  if (verified) {
    console.log(
      `[ci-static:tsgo:completion] ${JSON.stringify({ version: 1, id, planned: 1, completed: 1, leaves: [evidenceId] })}`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
