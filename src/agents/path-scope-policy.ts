/**
 * Path-scope policy resolver.
 *
 * Resolves the operator's per-model path visibility rules into one effective decision set for a run.
 * The rules live beside the tool policy (`tools.pathScopes`), so a second policy world never appears:
 * this module only reads config, canonicalizes both sides of the comparison, and answers whether a
 * resolved path is covered. Enforcement belongs to the owning filesystem guard.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PathScopeEntryConfig,
  PathScopeModeConfig,
  PathScopesConfig,
} from "../config/types.tools.js";
import { normalizeMediaReferenceSource } from "../media/inbound-media-uri.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { normalizeToolProviderPolicyKey } from "./provider-tool-policy.js";
import { normalizeFileReferencePrefix } from "./sandbox-paths.js";

export type ResolvedPathScopeEntry = {
  /** Canonical absolute path; covers this path and its whole subtree. */
  path: string;
  mode: PathScopeModeConfig;
};

/**
 * Resolved rules for one run.
 *
 * The value is frozen at runtime; the type stays plain so it can cross the worker surface, which is
 * described by the protocol schema in mutable JSON terms.
 */
export type ResolvedPathScopePolicy = {
  entries: ResolvedPathScopeEntry[];
  /** Keep exec/process callable while entries exist (default: false). */
  allowExecWithEntries: boolean;
  /**
   * True when a rule could not be tied to a resolved model ref. Callers treat this as fail-closed:
   * the provider-level rules still apply, and nothing is silently dropped.
   */
  unresolvedModel: boolean;
};

/** Refuse-and-hide wins over refuse-only when both modes cover the same path. */
const MODE_PRECEDENCE: PathScopeModeConfig = "deny+conceal";

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/**
 * Expand a `file://` URL to its path, as the filesystem tools do.
 *
 * The tools accept a file URL and read it through the same resolver they use for a plain path, so a
 * guard that only understood plain paths would miss `file:///…/secret` entirely.
 */
function expandFileUrl(value: string): string {
  if (!value.startsWith("file://")) {
    // A `file://` URL may arrive behind the media/tool reference prefixes (`@file://…`,
    // `MEDIA:file://…`), so strip those first and fall through to the plain-spelling path.
    const stripped = stripReferencePrefixes(value);
    return stripped.startsWith("file://") ? expandFileUrl(stripped) : value;
  }
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

/**
 * Remove the reference prefixes the tools themselves accept.
 *
 * The filesystem and media tools strip `@` and `MEDIA:` before resolving, so a guard that did not
 * would compare `<cwd>/@/abs` against a rule for `/abs` and miss it entirely. This mirrors the
 * tool-side normalizers rather than inventing a second grammar.
 */
function stripReferencePrefixes(value: string): string {
  let candidate = value;
  for (;;) {
    const previous = candidate;
    candidate = normalizeFileReferencePrefix(candidate);
    candidate = normalizeMediaReferenceSource(candidate) ?? candidate;
    if (candidate === previous) {
      return candidate;
    }
  }
}

/**
 * Canonicalize a configured entry or a candidate request path.
 *
 * Symlinks resolve through the deepest existing ancestor, so a rule written for a path whose leaf
 * does not exist yet still matches the location a later write would use.
 */
export function canonicalizeScopePath(value: string, cwd?: string): string {
  const expanded = expandHome(expandFileUrl(stripReferencePrefixes(value.trim())));
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(cwd ?? process.cwd(), expanded);
  const normalized = path.normalize(absolute);
  const resolved = resolveThroughExistingAncestor(normalized);
  // Case-insensitive filesystems make two spellings one location; compare on the folded form there.
  return isCaseInsensitiveFilesystem(resolved) ? resolved.toLowerCase() : resolved;
}

function resolveThroughExistingAncestor(absolutePath: string): string {
  let current = absolutePath;
  const trailing: string[] = [];
  for (;;) {
    try {
      const canonical = fs.realpathSync.native(current);
      return trailing.length === 0 ? canonical : path.join(canonical, ...trailing.toReversed());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolutePath;
      }
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

const caseInsensitiveCache = new Map<string, boolean>();

function isCaseInsensitiveFilesystem(absolutePath: string): boolean {
  // Probe the nearest existing ancestor: comparing the folded spelling of one directory answers
  // whether two spellings could name the same file on this filesystem.
  let probe = absolutePath;
  for (;;) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      return process.platform === "win32" || process.platform === "darwin";
    }
    probe = parent;
    if (fs.existsSync(probe)) {
      break;
    }
  }
  const cached = caseInsensitiveCache.get(probe);
  if (cached !== undefined) {
    return cached;
  }
  let insensitive: boolean;
  try {
    insensitive = fs.existsSync(probe.toUpperCase()) && probe !== probe.toUpperCase();
  } catch {
    insensitive = process.platform === "win32" || process.platform === "darwin";
  }
  caseInsensitiveCache.set(probe, insensitive);
  return insensitive;
}

/** True when `candidate` is the rule path itself or sits below it. Equal-prefix siblings do not match. */
export function isPathCoveredByEntry(candidate: string, entryPath: string): boolean {
  if (candidate === entryPath) {
    return true;
  }
  const withSeparator = entryPath.endsWith(path.sep) ? entryPath : entryPath + path.sep;
  return candidate.startsWith(withSeparator);
}

function collectEntries(
  scopes: PathScopesConfig | undefined,
  modelProvider: string | undefined,
  modelId: string | undefined,
  cwd: string | undefined,
  acc: ResolvedPathScopeEntry[],
): void {
  const byModel = scopes?.byModel;
  if (!byModel) {
    return;
  }
  // A model-level key unions with a provider-level key: deny lists add up, never replace.
  const keys = matchedScopeKeys(byModel, modelProvider, modelId);
  for (const key of keys) {
    for (const entry of byModel[key]?.entries ?? []) {
      acc.push(toResolvedEntry(entry, cwd));
    }
  }
}

function matchedScopeKeys(
  byModel: NonNullable<PathScopesConfig["byModel"]>,
  modelProvider: string | undefined,
  modelId: string | undefined,
): string[] {
  const provider = modelProvider?.trim();
  if (!provider) {
    return [];
  }
  const normalizedProvider = normalizeToolProviderPolicyKey(provider);
  const rawModelId = modelId?.trim().toLowerCase();
  const normalizedModel =
    rawModelId !== undefined && rawModelId !== ""
      ? normalizeToolProviderPolicyKey(`${normalizedProvider}/${rawModelId}`)
      : undefined;
  const keys: string[] = [];
  for (const key of Object.keys(byModel)) {
    const normalizedKey = normalizeToolProviderPolicyKey(key);
    if (!normalizedKey) {
      continue;
    }
    const isModelKey = normalizedKey.includes("/");
    if (isModelKey ? normalizedKey === normalizedModel : normalizedKey === normalizedProvider) {
      keys.push(key);
    }
  }
  return keys;
}

function toResolvedEntry(
  entry: PathScopeEntryConfig,
  cwd: string | undefined,
): ResolvedPathScopeEntry {
  return Object.freeze({
    path: canonicalizeScopePath(entry.path, cwd),
    mode: entry.mode ?? MODE_PRECEDENCE,
  });
}

/**
 * Collapse duplicate rules and order the rest most-specific-first.
 *
 * Nesting is deliberately not flattened: a narrower `deny+conceal` inside a broader `deny` must keep
 * its stronger mode for its own subtree, so both rules survive and the shorter path is consulted
 * last. Only an exact same-path duplicate merges, and there the stronger mode wins.
 */
function mergeEntries(entries: readonly ResolvedPathScopeEntry[]): ResolvedPathScopeEntry[] {
  const byPath = new Map<string, ResolvedPathScopeEntry>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (!existing) {
      byPath.set(entry.path, entry);
      continue;
    }
    if (existing.mode !== MODE_PRECEDENCE && entry.mode === MODE_PRECEDENCE) {
      byPath.set(entry.path, Object.freeze({ path: entry.path, mode: MODE_PRECEDENCE }));
    }
  }
  return Array.from(byPath.values()).toSorted(
    (left, right) => right.path.length - left.path.length,
  );
}

/**
 * Effective path-scope policy for a run, or `undefined` when nothing is configured for this model.
 *
 * Global and per-agent blocks union; a mode conflict on the same path resolves to `deny+conceal`.
 * An unresolvable model ref keeps the provider-level rules and reports `unresolvedModel`, so the
 * caller can stay fail-closed instead of reading "no rule" into a lookup miss.
 */
export function resolvePathScopePolicy(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
  /** Base directory for relative entries; a run normally passes its coding root. */
  cwd?: string;
}): ResolvedPathScopePolicy | undefined {
  const cfg = params.cfg;
  const globalScopes = cfg?.tools?.pathScopes;
  const agentScopes =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.pathScopes : undefined;
  // Nothing configured anywhere: an unrestricted run keeps today's behavior exactly.
  if (hasNoScopeEntries(globalScopes) && hasNoScopeEntries(agentScopes)) {
    return undefined;
  }
  const collected: ResolvedPathScopeEntry[] = [];
  collectEntries(globalScopes, params.modelProvider, params.modelId, params.cwd, collected);
  collectEntries(agentScopes, params.modelProvider, params.modelId, params.cwd, collected);
  const entries = mergeEntries(collected);
  // Entries exist only at provider or model level; a resolved model ref is what selects them.
  // `unresolvedModel` means the effective model ref was missing, not that it simply matched nothing.
  // Conflating the two made a legitimately unrestricted run look fail-closed.
  const unresolvedModel = !params.modelProvider?.trim();
  const anyScopeConfigured = !hasNoScopeEntries(globalScopes) || !hasNoScopeEntries(agentScopes);
  if (entries.length === 0) {
    // A configured scope with no rule for this model leaves the run unrestricted; only an unknown
    // model ref is reported as unresolved, so a caller can fail closed on that alone.
    return anyScopeConfigured
      ? Object.freeze({ entries: [], allowExecWithEntries: true, unresolvedModel })
      : undefined;
  }
  return Object.freeze({
    entries,
    // The stricter explicit value wins: a per-agent `true` must not lift a global `false`, while an
    // unset level never overrides the other one's choice.
    allowExecWithEntries: resolveAllowExec(globalScopes, agentScopes),
    unresolvedModel,
  });
}

function resolveAllowExec(
  globalScopes: PathScopesConfig | undefined,
  agentScopes: PathScopesConfig | undefined,
): boolean {
  const values = [globalScopes?.allowExecWithEntries, agentScopes?.allowExecWithEntries];
  const chosen = new Set(values.filter((value): value is boolean => value !== undefined));
  if (chosen.has(false)) {
    return false;
  }
  return chosen.has(true);
}

function hasNoScopeEntries(scopes: PathScopesConfig | undefined): boolean {
  if (!scopes?.byModel) {
    return true;
  }
  return Object.values(scopes.byModel).every((entry) => (entry?.entries?.length ?? 0) === 0);
}

/** Resolve a request path against the policy; returns the covering rule or `undefined`. */
export function findCoveringScopeEntry(
  policy: ResolvedPathScopePolicy | undefined,
  candidatePath: string,
  cwd?: string,
): ResolvedPathScopeEntry | undefined {
  if (!policy || policy.entries.length === 0) {
    return undefined;
  }
  const canonical = canonicalizeScopePath(candidatePath, cwd);
  return policy.entries.find((entry) => isPathCoveredByEntry(canonical, entry.path));
}

/** True when this path must not be listed at all (`deny+conceal`). */
export function isPathConcealed(
  policy: ResolvedPathScopePolicy | undefined,
  candidatePath: string,
  cwd?: string,
): boolean {
  return findCoveringScopeEntry(policy, candidatePath, cwd)?.mode === MODE_PRECEDENCE;
}

/** True when this path must be refused (both modes refuse; only `deny+conceal` also hides). */
export function isPathDenied(
  policy: ResolvedPathScopePolicy | undefined,
  candidatePath: string,
  cwd?: string,
): boolean {
  return findCoveringScopeEntry(policy, candidatePath, cwd) !== undefined;
}

/**
 * Refusal error for a covered path.
 *
 * The shape matches the filesystem tools' own not-found error, including the requested path: a real
 * miss says `File not found: <absolute>.`, so anything shorter would itself be a tell that the rule
 * fired. The requested path is the one the caller already supplied, so naming it reveals nothing;
 * what must stay hidden is the rule, the config key, and the fact that the location exists at all.
 */
export function pathScopeDeniedError(requestedPath?: string): Error & { code: "ENOENT" } {
  const detail = requestedPath?.trim() ? `: ${requestedPath.trim()}.` : ".";
  const error = new Error(`File not found${detail}`) as Error & { code: "ENOENT" };
  error.code = "ENOENT";
  return error;
}

/** Filter one directory listing; concealed entries disappear entirely, denied ones stay visible. */
export function filterConcealedDirectoryEntries<T extends { name: string }>(
  policy: ResolvedPathScopePolicy | undefined,
  directoryPath: string,
  entries: readonly T[],
): T[] {
  if (!policy || policy.entries.length === 0) {
    return [...entries];
  }
  return entries.filter((entry) => !isPathConcealed(policy, path.join(directoryPath, entry.name)));
}

/**
 * Refuse the first covered path in a list.
 *
 * Callers that admit several targets at once (a patch envelope) use this so the whole operation
 * fails instead of reporting the allowed half of the batch.
 */
export function refuseCoveredPaths(
  policy: ResolvedPathScopePolicy | undefined,
  paths: readonly string[],
  cwd?: string,
): void {
  for (const candidate of paths) {
    if (isPathDenied(policy, candidate, cwd)) {
      throw pathScopeDeniedError(candidate);
    }
  }
}

/**
 * Children inherit the requesting run's rules and add their own.
 *
 * A child that could drop the parent's rules would be a bypass: the parent could simply ask it to
 * read the concealed path. The union keeps the stronger mode on a shared path, and a child that
 * cannot honor the inherited set is refused instead of started unguarded.
 */
export function mergeInheritedPathScope(
  inherited: ResolvedPathScopePolicy | undefined,
  own: ResolvedPathScopePolicy | undefined,
): ResolvedPathScopePolicy | undefined {
  if (!inherited || inherited.entries.length === 0) {
    return own;
  }
  if (!own || own.entries.length === 0) {
    return inherited;
  }
  return Object.freeze({
    entries: mergeEntries([...inherited.entries, ...own.entries]),
    allowExecWithEntries: inherited.allowExecWithEntries && own.allowExecWithEntries,
    unresolvedModel: inherited.unresolvedModel || own.unresolvedModel,
  });
}

/**
 * Entries of `required` that `candidate` does not already cover at least as strongly.
 *
 * The spawn gate uses this instead of "the child has some rules": a child whose own provider lists
 * unrelated paths would look restricted while the parent's path stays readable for it. An empty
 * result means the child's rules subsume the parent's, so the inherited set adds nothing.
 */
export function uncoveredScopeEntries(
  required: ResolvedPathScopePolicy | undefined,
  candidate: ResolvedPathScopePolicy | undefined,
): readonly ResolvedPathScopeEntry[] {
  if (!required || required.entries.length === 0) {
    return [];
  }
  if (!candidate || candidate.entries.length === 0) {
    return required.entries;
  }
  return required.entries.filter((entry) => {
    const covering = candidate.entries.find((other) =>
      isPathCoveredByEntry(entry.path, other.path),
    );
    if (!covering) {
      return true;
    }
    // `deny` under a `deny+conceal` would let the child list what the parent hid.
    return entry.mode === MODE_PRECEDENCE && covering.mode !== MODE_PRECEDENCE;
  });
}
