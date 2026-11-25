#!/usr/bin/env node

// Lints only the files a pull request changes, for the fork's self-hosted gate.
//
// Why this exists: the fork CI gate (`ci-fork.yml`) must surface new lint
// problems in a PR without being blocked by pre-existing repo lint debt (for
// example the known extension-lint baseline: 19 errors at prod d3fbe4fc07c).
// Full-scope lint stays with the upstream workflows; this helper narrows the
// gate to the PR's own diff.
//
// Scope source: when the checkout is the PR merge commit (GitHub's
// `refs/pull/<n>/merge`, which `ci-fork.yml` checks out with `fetch-depth: 2`),
// the first parent is the exact target tree for the run, so the merge commit
// against its first parent is the PR's change set. That comparison needs only
// the two commits already in the checkout; no base ref and no network access
// are required here. A checkout with no merge commit (for example a manual
// `workflow_dispatch` run) skips with a note instead of failing.
//
// Files are routed to the lint owners' documented tsconfig groups (the same
// root-to-tsconfig mapping `scripts/run-oxlint-shards.mts` uses, plus the
// root-test config from `scripts/check-changed.mts`) and linted through
// `scripts/run-oxlint.mjs`, never by copying lint policy into CI.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const USAGE = "Usage: node scripts/ci-fork-lint-changed.mjs [--base <ref>] [--head <ref>]";

// Root-to-tsconfig routing mirrors run-oxlint-shards.mts (core, extensions,
// scripts shards) and the root-test config used by check-changed.mts.
const LINT_GROUPS = [
  { name: "core", tsconfig: "config/tsconfig/oxlint.core.json", root: /^(?:src|ui|packages)\//u },
  { name: "extensions", tsconfig: "extensions/tsconfig.json", root: /^extensions\//u },
  { name: "scripts", tsconfig: "config/tsconfig/oxlint.scripts.json", root: /^scripts\//u },
  { name: "root tests", tsconfig: "test/tsconfig/tsconfig.test.root.json", root: /^test\//u },
];

// Same source-file predicate family as run-oxlint-shards.mts / check-changed.mts.
const LINTABLE_FILE = /\.[cm]?[jt]sx?$/u;
const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

function runGit(args) {
  return spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function parseArgs(argv) {
  const parsed = { base: undefined, head: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base" || arg === "--head") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value. ${USAGE}`);
      }
      parsed[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exitCode = 0;
      return undefined;
    }
    throw new Error(`Unknown argument: ${arg}. ${USAGE}`);
  }
  return parsed;
}

function resolveCommit(ref) {
  const result = runGit(["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Resolves the base commit for the changed-file diff.
 * Preference: explicit `--base`, then the merge commit's first parent, then a
 * concrete `GITHUB_BASE_SHA` that is present in the checkout.
 */
function resolveBase(headSha, explicitBase) {
  if (explicitBase !== undefined) {
    const resolved = resolveCommit(explicitBase);
    if (resolved === undefined) {
      throw new Error(`--base ${explicitBase} does not resolve to a commit in this checkout`);
    }
    return { sha: resolved, source: `explicit --base ${explicitBase}` };
  }
  const parents = runGit(["rev-list", "--parents", "-n", "1", headSha]);
  const fields = parents.status === 0 ? parents.stdout.trim().split(/\s+/u) : [];
  if (fields.length === 3) {
    return { sha: fields[1], source: "PR merge commit first parent" };
  }
  const eventBase = process.env.GITHUB_BASE_SHA?.trim();
  if (eventBase) {
    const resolved = resolveCommit(eventBase);
    if (resolved !== undefined) {
      return { sha: resolved, source: "GITHUB_BASE_SHA" };
    }
  }
  return undefined;
}

function listChangedFiles(baseSha, headSha) {
  const result = runGit(["diff", "--name-only", "-z", "--diff-filter=ACMR", baseSha, headSha]);
  if (result.status !== 0) {
    throw new Error(`git diff failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === undefined) {
    return;
  }
  const headSha = resolveCommit(args.head ?? "HEAD");
  if (headSha === undefined) {
    console.error("[ci-fork-gate] HEAD does not resolve to a commit; skipping changed lint");
    return;
  }
  const base = resolveBase(headSha, args.base);
  if (base === undefined) {
    console.error(
      "[ci-fork-gate] no PR merge base found (not a merge checkout and no usable base SHA); " +
        "skipping changed lint",
    );
    return;
  }

  const changedFiles = listChangedFiles(base.sha, headSha);
  console.error(
    `[ci-fork-gate] changed lint base: ${base.source} ${base.sha.slice(0, 12)} -> ${headSha.slice(0, 12)}`,
  );
  console.error(`[ci-fork-gate] changed files: ${changedFiles.length}`);
  const lintable = [];
  for (const file of changedFiles) {
    const isLintable =
      LINTABLE_FILE.test(file) && !DECLARATION_FILE.test(file) && fs.existsSync(file);
    console.error(`[ci-fork-gate]   ${isLintable ? "lint" : "skip"} ${file}`);
    if (isLintable) {
      lintable.push(file);
    }
  }
  if (lintable.length === 0) {
    console.error(
      "[ci-fork-gate] result: skipped, no lintable changed files (.ts/.tsx/.mjs family absent)",
    );
    return;
  }

  const groups = [];
  for (const group of LINT_GROUPS) {
    const files = lintable
      .filter((file) => group.root.test(file))
      .toSorted((left, right) => left.localeCompare(right));
    if (files.length > 0) {
      groups.push({
        name: group.name,
        root: group.root,
        tsconfig: group.tsconfig,
        files,
      });
    }
  }
  const routed = new Set(groups.flatMap((group) => group.files));
  const unrouted = lintable.filter((file) => !routed.has(file));
  if (unrouted.length > 0) {
    console.error(
      `[ci-fork-gate] not covered by an oxlint group (left to their own gates): ${unrouted.join(", ")}`,
    );
  }

  let failure = 0;
  for (const group of groups) {
    console.error(
      `[ci-fork-gate] lint ${group.name}: ${group.files.length} changed file(s) via ${group.tsconfig}`,
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/run-oxlint.mjs", "--tsconfig", group.tsconfig, ...group.files],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    if (result.status !== 0) {
      console.error(`[ci-fork-gate] lint ${group.name} failed (exit ${result.status})`);
      failure ||= result.status ?? 1;
    } else {
      console.error(`[ci-fork-gate] lint ${group.name} passed`);
    }
  }
  if (failure !== 0) {
    console.error(`[ci-fork-gate] result: failed (exit ${failure})`);
    process.exitCode = failure;
    return;
  }
  console.error(
    `[ci-fork-gate] result: passed, linted ${lintable.length} changed file(s) in ${groups.length} group(s)`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[ci-fork-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
