// Integration proof that the local tsgo memory cap really binds a compiler run.
//
// Unit tests prove the policy and the wiring; only a kernel-verified scope proves
// the cap is enforced, the payload ran once, and no descendant survived. Gated on
// the same backend detection as `managed-memory.integration.test.ts`, so hosts
// without a cgroup-v2 systemd user manager skip instead of failing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { signalExitCode } from "../../scripts/lib/managed-child-process.mts";
import { prepareTsgoCommand, runPreparedTsgoCommand } from "../../scripts/run-tsgo.mts";
import { isProcessAlive } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  hasSemanticTestBackend,
  overrideNativeFixtureExecutable,
} from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const available = process.platform === "linux" && hasSemanticTestBackend();

// A payload that records its single run, leaves a descendant behind, and then
// allocates well past the cap so the kernel has to end the whole cgroup.
function cappedAllocatorSource() {
  return [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'fs.appendFileSync(process.env.S16_RUN_MARKER, "run\\n");',
    'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
    '  stdio: "ignore",',
    "});",
    "fs.writeFileSync(process.env.S16_DESCENDANT_PID, String(descendant.pid));",
    "const held = [];",
    "for (let i = 0; i < 64; i += 1) held.push(Buffer.alloc(8 * 1024 ** 2, 1));",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
}

function createCappedRunnerFixture() {
  const root = fs.realpathSync(roots.make("openclaw-tsgo-cap-integration-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"private":true,"type":"module"}\n');
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  fs.writeFileSync(path.join(root, "tsconfig.extensions.json"), "{}\n");
  const fakeTsgo = path.join(root, "node_modules", ".bin", "tsgo");
  fs.mkdirSync(path.dirname(fakeTsgo), { recursive: true });
  fs.writeFileSync(fakeTsgo, cappedAllocatorSource(), "utf8");
  fs.chmodSync(fakeTsgo, 0o755);
  // Route the repository's own tool resolver at this fixture binary; the real
  // containment path below is never mocked.
  overrideNativeFixtureExecutable(root, fakeTsgo);
  const runMarker = path.join(root, "runs.log");
  const descendantPidPath = path.join(root, "descendant.pid");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: undefined,
    GITHUB_ACTIONS: undefined,
    OPENCLAW_LOCAL_CHECK: "1",
    // A small, explicit cap: the run must die fast, and the override path is the
    // one an operator would use to shrink an existing host cap.
    OPENCLAW_LOCAL_CHECK_MEMORY_LIMIT_MB: "256",
    S16_RUN_MARKER: runMarker,
    S16_DESCENDANT_PID: descendantPidPath,
  };
  return { root, env, runMarker, descendantPidPath };
}

function readDescendantPid(file: string) {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

it.runIf(available)(
  "caps a locally started compiler run and joins it without a second attempt",
  async ({ signal }) => {
    const { root, env, runMarker, descendantPidPath } = createCappedRunnerFixture();
    let memoryScope = "";
    const prepared = prepareTsgoCommand(["-p", "tsconfig.extensions.json"], env, root);
    expect(prepared).not.toBeNull();
    // The scope name is the only handle on the kernel object the cap created.
    const command = {
      ...prepared!,
      onMemoryScope: (unit: string) => {
        memoryScope = unit;
      },
    };
    const code = await runPreparedTsgoCommand(command);

    // systemd may deliver SIGTERM before the kernel's group SIGKILL.
    expect([signalExitCode("SIGKILL"), signalExitCode("SIGTERM")]).toContain(code);
    // The payload ran exactly once: a capped run is never retried uncapped.
    expect(fs.readFileSync(runMarker, "utf8").trim().split("\n")).toEqual(["run"]);
    // A surviving descendant would mean the cgroup did not join the whole tree.
    const descendantPid = readDescendantPid(descendantPidPath);
    expect(descendantPid).toBeDefined();
    expect(isProcessAlive(descendantPid!)).toBe(false);
    // The scope is gone, not merely stopped: admission must not be stranded.
    expect(memoryScope).not.toBe("");
    const state = spawnSync("systemctl", ["--user", "show", "--property=LoadState", memoryScope], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(state.stdout).toContain("LoadState=not-found");
    void signal;
  },
  40_000,
);
