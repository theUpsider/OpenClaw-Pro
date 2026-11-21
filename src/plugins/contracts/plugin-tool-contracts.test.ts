// Plugin tool contract tests cover bundled plugin tool schemas and invocation contracts.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath,
} from "../../test-utils/repo-files.js";

type PluginManifestFile = {
  id?: unknown;
  contracts?: {
    tools?: unknown;
  };
  toolMetadata?: Record<string, { optional?: unknown }>;
};

function walkFiles(dir: string): string[] {
  const gitFiles = listGitFiles(dir);
  if (gitFiles) {
    return gitFiles;
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

function repoRelativePath(filePath: string): string {
  return toRepoRelativePath(process.cwd(), filePath);
}

function isSkippedRepoPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((part) => part === "node_modules" || part === "dist" || part.startsWith("."));
}

function listGitFiles(dir: string): string[] | null {
  const relativeDir = repoRelativePath(dir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => !isSkippedRepoPath(line))
    .map((line) => path.join(process.cwd(), ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function listGitPluginManifestPaths(extensionsDir: string): string[] | null {
  const relativeDir = repoRelativePath(extensionsDir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(line))
    .map((line) => path.join(process.cwd(), ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function listPluginManifestPaths(extensionsDir: string): string[] {
  const gitPaths = listGitPluginManifestPaths(extensionsDir);
  if (gitPaths) {
    return gitPaths;
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(extensionsDir, entry.name, "openclaw.plugin.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath));
}

function isProductionSource(filePath: string): boolean {
  if (!/\.(?:cjs|mjs|js|ts|tsx)$/.test(filePath)) {
    return false;
  }
  const normalized = toRepoPath(filePath);
  return !/(\.test\.|\.spec\.|\/__tests__\/|\/test-support\/)/.test(normalized);
}

/**
 * Text between a balanced delimiter pair, starting at its opening character.
 * Returns undefined when the delimiter never closes. `close` is the character
 * that ends the region at depth zero; nesting counts `(`/`{`/`[` in between.
 */
function readBalancedDelimiters(
  source: string,
  openIndex: number,
  close: ")" | "]" | "}",
): string | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (!char) {
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && char === close) {
        return source.slice(openIndex + 1, index);
      }
    }
  }
  return undefined;
}

function readBalancedCallArguments(source: string, openParenIndex: number): string | undefined {
  return readBalancedDelimiters(source, openParenIndex, ")");
}

function readBalancedArrayBody(source: string, openBracketIndex: number): string | undefined {
  return readBalancedDelimiters(source, openBracketIndex, "]");
}

function listRegisterToolCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /\bregisterTool\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const openParenIndex = source.indexOf("(", match.index);
    const args = readBalancedCallArguments(source, openParenIndex);
    if (args !== undefined) {
      calls.push(args);
    }
  }
  return calls;
}

function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (!char) {
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      const part = args.slice(start, index).trim();
      if (part.length > 0) {
        parts.push(part);
      }
      start = index + 1;
    }
  }
  const part = args.slice(start).trim();
  if (part.length > 0) {
    parts.push(part);
  }
  return parts;
}

/**
 * Const array bodies by identifier across the plugin's production modules, so a
 * `names: [...SOME_ARRAY]` spread resolves against the array's own literal entries.
 */
function collectConstArrayBodies(sources: readonly string[]): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const source of sources) {
    const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\[/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const identifier = match[1];
      if (!identifier || bodies.has(identifier)) {
        // First definition wins across the plugin's modules. Two modules declaring
        // the same identifier would silently resolve a spread against the wrong
        // array; no bundled plugin does that today.
        continue;
      }
      const openBracketIndex = match.index + match[0].length - 1;
      const body = readBalancedArrayBody(source, openBracketIndex);
      if (body !== undefined) {
        bodies.set(identifier, body);
      }
    }
  }
  return bodies;
}

/**
 * Resolves a `names: [...]` array body to its literal entries, following
 * `...IDENT` spreads into the plugin's own const arrays. `resolved` is false as
 * soon as one entry cannot be read as a literal, so callers can stay silent
 * instead of guessing about a dynamic name source.
 */
function resolveNamesArrayEntries(
  body: string,
  arrays: ReadonlyMap<string, string>,
  seen: ReadonlySet<string>,
): { names: string[]; resolved: boolean } {
  const names: string[] = [];
  let resolved = true;
  for (const entry of splitTopLevelArgs(body)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const literal = /^["']([^"']+)["']$/.exec(trimmed);
    if (literal?.[1]) {
      names.push(literal[1]);
      continue;
    }
    const spread = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(trimmed);
    const spreadIdentifier = spread?.[1];
    if (spreadIdentifier && !seen.has(spreadIdentifier)) {
      const nested = arrays.get(spreadIdentifier);
      if (nested !== undefined) {
        const nextSeen = new Set(seen);
        nextSeen.add(spreadIdentifier);
        const nestedResult = resolveNamesArrayEntries(nested, arrays, nextSeen);
        for (const name of nestedResult.names) {
          names.push(name);
        }
        if (!nestedResult.resolved) {
          resolved = false;
        }
        continue;
      }
    }
    resolved = false;
  }
  return { names, resolved };
}

function extractRegisteredToolNamesFromObject(
  source: string,
  arrays: ReadonlyMap<string, string>,
): { names: string[]; resolved: boolean; sawEvidence: boolean; optional: boolean } {
  const names: string[] = [];
  let resolved = true;
  let sawEvidence = false;
  for (const match of source.matchAll(/\bnames\s*:\s*/g)) {
    sawEvidence = true;
    const matchIndex = match.index ?? 0;
    const rest = source.slice(matchIndex + match[0].length);
    const trimmed = rest.trimStart();
    if (!trimmed.startsWith("[")) {
      resolved = false;
      continue;
    }
    const openBracketIndex = matchIndex + match[0].length + (rest.length - trimmed.length);
    const body = readBalancedArrayBody(source, openBracketIndex);
    if (body === undefined) {
      resolved = false;
      continue;
    }
    const candidates = resolveNamesArrayEntries(body, arrays, new Set());
    for (const name of candidates.names) {
      names.push(name);
    }
    if (!candidates.resolved) {
      resolved = false;
    }
  }
  for (const match of source.matchAll(/\bname\s*:\s*/g)) {
    sawEvidence = true;
    const literal = /^["']([^"']+)["']/.exec(source.slice((match.index ?? 0) + match[0].length));
    if (literal?.[1]) {
      names.push(literal[1]);
    } else {
      resolved = false;
    }
  }
  return {
    names,
    resolved: sawEvidence && resolved,
    sawEvidence,
    optional: /\boptional\s*:\s*true/.test(source),
  };
}

/**
 * Registered names for one call plus whether the call's name source was fully
 * static. A call counts as resolved when it has at least one object argument
 * that names tools and no object argument with an unreadable name source.
 */
function extractRegisteredToolNames(
  callArgs: string,
  arrays: ReadonlyMap<string, string>,
): { names: string[]; resolved: boolean; optionalNames: string[] } {
  const names: string[] = [];
  const optionalNames: string[] = [];
  let everyEvidenceResolved = true;
  let sawEvidence = false;
  for (const arg of splitTopLevelArgs(callArgs)) {
    const trimmed = arg.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    const extracted = extractRegisteredToolNamesFromObject(trimmed, arrays);
    for (const name of extracted.names) {
      names.push(name);
    }
    if (extracted.optional) {
      optionalNames.push(...extracted.names);
    }
    if (extracted.sawEvidence) {
      sawEvidence = true;
      // Every evidence-bearing argument is still parsed: an unreadable earlier
      // argument must not discard the names or the optional flag a later argument
      // contributes, it only marks the call unresolved.
      everyEvidenceResolved = everyEvidenceResolved && extracted.resolved;
    }
  }
  return { names, resolved: sawEvidence && everyEvidenceResolved, optionalNames };
}

/**
 * Namespace-scoped `name:` literals across the plugin's production modules:
 * the tool names its factories actually return. Scoping to the plugin's own
 * namespace keeps the check off unrelated `name:` properties; measured across
 * all manifested plugins it flags only the drifted Workboard manifest entry.
 */
function collectPluginToolNameLiterals(sources: readonly string[], pluginId: string): string[] {
  // Only names carrying the plugin's own namespace are attributed to it. A tool
  // named otherwise (an exact-id name such as `lobster`, or another prefix such as
  // `memory_*`) is outside this scan's reach, so it is not compared here; that
  // limit is the reason this half of the rule complements the spread check rather
  // than replacing it.
  const prefixes = [`${pluginId}_`, `${pluginId.replaceAll("-", "_")}_`];
  const names = new Set<string>();
  for (const source of sources) {
    const pattern = /\bname\s*:\s*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const name = match[1];
      if (name && prefixes.some((prefix) => name.startsWith(prefix))) {
        names.add(name);
      }
    }
  }
  return [...names].toSorted();
}

function readManifest(manifestPath: string): PluginManifestFile {
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PluginManifestFile;
}

function normalizeManifestTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

describe("bundled plugin tool manifest contracts", () => {
  let toolContractFailures: string[] = [];

  beforeAll(() => {
    listGitTrackedFiles({ pathspecs: "extensions" });
    toolContractFailures = collectToolContractFailures(path.join(process.cwd(), "extensions"));
  });

  it("lists plugin tool contract inputs from git without walking extension roots", () => {
    const extensionsDir = path.join(process.cwd(), "extensions");
    expectNoReaddirSyncDuring(() => {
      const manifestPaths = listPluginManifestPaths(extensionsDir);
      const sourceFiles = manifestPaths[0]
        ? walkFiles(path.dirname(manifestPaths[0])).filter(isProductionSource)
        : [];

      expect(manifestPaths.length).toBeGreaterThan(0);
      expect(sourceFiles.length).toBeGreaterThan(0);
    });
  });

  it("declares every production registerTool owner in contracts.tools", () => {
    expect(toolContractFailures).toStrictEqual([]);
  });
});

// Each rule below owns a fixture case, so a rule that silently stopped matching
// would fail here instead of passing on the real tree staying green.
describe("plugin tool contract rules", () => {
  it("fails a spread tool that the manifest does not declare", () => {
    const failures = collectPluginToolContractFailures(
      "probe",
      { id: "probe", contracts: { tools: ["probe_keep", "probe_span"] } },
      [
        `const SPREAD = ["probe_keep", "probe_span", "probe_missing"] as const;`,
        `api.registerTool(factory, { names: [...SPREAD] });`,
      ],
    );
    expect(failures).toStrictEqual(["probe: missing contracts.tools for probe_missing"]);
  });

  it("fails an emitted factory name that no registerTool call reaches", () => {
    const failures = collectPluginToolContractFailures(
      "probe",
      { id: "probe", contracts: { tools: ["probe_reached", "probe_orphan"] } },
      [
        `const SPREAD = ["probe_reached"] as const;`,
        `api.registerTool(factory, { names: [...SPREAD] });`,
        `function mk() { return { name: "probe_orphan", execute() {} }; }`,
      ],
    );
    expect(failures).toStrictEqual([
      "probe: emits agent tool names missing from its registerTool declarations: probe_orphan",
    ]);
  });

  it("fails an optionally registered tool without toolMetadata.<tool>.optional", () => {
    const failures = collectPluginToolContractFailures(
      "probe",
      { id: "probe", contracts: { tools: ["probe_optional"] }, toolMetadata: {} },
      [`api.registerTool(factory, { names: ["probe_optional"], optional: true });`],
    );
    expect(failures).toStrictEqual([
      "probe: registers optional agent tools without toolMetadata.<tool>.optional: probe_optional",
    ]);
  });

  it("fails a toolMetadata key that contracts.tools does not declare", () => {
    const failures = collectPluginToolContractFailures(
      "probe",
      {
        id: "probe",
        contracts: { tools: ["probe_declared"] },
        toolMetadata: { probe_declared: { optional: true }, probe_ghost: { optional: true } },
      },
      [
        `api.registerTool(factory, { names: ["probe_declared"], optional: true });`,
        `function mk() { return { name: "probe_declared", execute() {} }; }`,
      ],
    );
    expect(failures).toStrictEqual([
      "probe: toolMetadata keys missing from contracts.tools: probe_ghost",
    ]);
  });

  it("keeps the name a later argument contributed when an earlier one is dynamic", () => {
    // The extractor must not return at the first unreadable argument. The first
    // argument here names its tool dynamically, so an early return would drop the
    // second argument's name. The name is deliberately outside the plugin's
    // namespace prefix, or the emitted-name scan would mask the loss.
    const failures = collectPluginToolContractFailures(
      "probe",
      { id: "probe", contracts: { tools: ["probe_declared"] } },
      [
        `api.registerTool({ contextVersion: 2, create: (c) => mk({ name: c.id }) }, { name: "outside_tool" });`,
      ],
    );
    expect(failures).toStrictEqual(["probe: missing contracts.tools for outside_tool"]);
  });

  it("keeps a later argument's optional flag when an earlier one is dynamic", () => {
    // Same early-return hazard on the optionalNames channel: the metadata rule only
    // sees this tool if the later argument is still parsed.
    const failures = collectPluginToolContractFailures(
      "probe",
      { id: "probe", contracts: { tools: ["probe_opt"] }, toolMetadata: {} },
      [
        `api.registerTool({ contextVersion: 2, create: (c) => mk({ name: c.id }) }, { names: ["probe_opt"], optional: true });`,
      ],
    );
    expect(failures).toStrictEqual([
      "probe: registers optional agent tools without toolMetadata.<tool>.optional: probe_opt",
    ]);
  });

  it("still reports a name from an emitted factory when a call is unresolved", () => {
    // The emitted-name union in the missing-names rule owns this path; without the
    // fixture, dropping that half of the union would leave every case green.
    const failures = collectPluginToolContractFailures(
      "probe",
      { id: "probe", contracts: { tools: ["probe_declared"] } },
      [
        `api.registerTool({ contextVersion: 2, create: (c) => mk({ name: c.id }) });`,
        `function mk() { return { name: "probe_undeclared", execute() {} }; }`,
      ],
    );
    expect(failures).toStrictEqual(["probe: missing contracts.tools for probe_undeclared"]);
  });

  it("passes a plugin whose spread, factories, and metadata all agree", () => {
    const failures = collectPluginToolContractFailures(
      "probe",
      {
        id: "probe",
        contracts: { tools: ["probe_alpha", "probe_beta"] },
        toolMetadata: { probe_alpha: { optional: true }, probe_beta: { optional: true } },
      },
      [
        `const SPREAD = ["probe_alpha", "probe_beta"] as const;`,
        `api.registerTool(factory, { names: [...SPREAD], optional: true });`,
        `function mk() { return [{ name: "probe_alpha", execute() {} }, { name: "probe_beta", execute() {} }]; }`,
      ],
    );
    expect(failures).toStrictEqual([]);
  });
});

function collectToolContractFailures(extensionsDir: string): string[] {
  const failures: string[] = [];

  for (const manifestPath of listPluginManifestPaths(extensionsDir)) {
    const pluginDir = path.dirname(manifestPath);
    const manifest = readManifest(manifestPath);
    const pluginId = typeof manifest.id === "string" ? manifest.id : path.basename(pluginDir);
    const pluginSources: string[] = [];

    for (const filePath of walkFiles(pluginDir).filter(isProductionSource)) {
      pluginSources.push(fs.readFileSync(filePath, "utf-8"));
    }

    failures.push(...collectPluginToolContractFailures(pluginId, manifest, pluginSources));
  }

  return failures;
}

/**
 * Tool-contract failures for one plugin's manifest and production sources. Split
 * out from the directory walk so the rules can be exercised against synthetic
 * plugin fixtures, which is how each rule proves it can go red.
 */
function collectPluginToolContractFailures(
  pluginId: string,
  manifest: PluginManifestFile,
  pluginSources: readonly string[],
): string[] {
  const failures: string[] = [];
  const declaredTools = new Set(normalizeManifestTools(manifest.contracts?.tools));
  const registeredNames = new Set<string>();
  const registerToolCalls = pluginSources.flatMap((source) => listRegisterToolCalls(source));

  if (registerToolCalls.length === 0) {
    return failures;
  }
  if (declaredTools.size === 0) {
    failures.push(`${pluginId}: registers agent tools but has no contracts.tools`);
    return failures;
  }

  const constArrayBodies = collectConstArrayBodies(pluginSources);
  let allRegisterCallsResolved = true;
  const optionalRegisteredNames = new Set<string>();
  for (const call of registerToolCalls) {
    const extracted = extractRegisteredToolNames(call, constArrayBodies);
    for (const name of extracted.names) {
      registeredNames.add(name);
    }
    for (const name of extracted.optionalNames) {
      optionalRegisteredNames.add(name);
    }
    if (!extracted.resolved) {
      allRegisterCallsResolved = false;
    }
  }

  // The emitted tool names live in the plugin's own factories, so a
  // `registerTool(factory, { names: [...SOME_ARRAY] })` registration is
  // covered even though the options object carries no name literals; the
  // options array resolves against the spread source's literal entries.
  const emittedNames = collectPluginToolNameLiterals(pluginSources, pluginId);

  const missing = [...new Set([...registeredNames, ...emittedNames])]
    .filter((name) => !declaredTools.has(name))
    .toSorted();
  if (missing.length > 0) {
    failures.push(`${pluginId}: missing contracts.tools for ${missing.join(", ")}`);
    return failures;
  }

  // Second gap: a registered tool name may be declared yet never reachable
  // through the plugin's own registration surface. Only judged when every
  // registerTool call named its tools statically, so dynamic registrations
  // stay out of scope instead of guessing.
  if (allRegisterCallsResolved) {
    const undeclared = emittedNames.filter((name) => !registeredNames.has(name)).toSorted();
    if (undeclared.length > 0) {
      failures.push(
        `${pluginId}: emits agent tool names missing from its registerTool declarations: ${undeclared.join(", ")}`,
      );
    }
  }

  // Third gap: `toolMetadata.<tool>.optional` must track
  // `api.registerTool(..., { optional: true })`, and metadata must only describe
  // declared tools. A tool registered as optional without the matching metadata
  // entry is read as default-on by the control plane, so the two surfaces
  // disagree about whether the tool loads unallowlisted.
  const metadata = manifest.toolMetadata ?? {};
  const missingMetadata = [...optionalRegisteredNames]
    .filter((name) => declaredTools.has(name) && metadata[name]?.optional !== true)
    .toSorted();
  if (missingMetadata.length > 0) {
    failures.push(
      `${pluginId}: registers optional agent tools without toolMetadata.<tool>.optional: ${missingMetadata.join(", ")}`,
    );
  }
  const undeclaredMetadata = Object.keys(metadata)
    .filter((name) => !declaredTools.has(name))
    .toSorted();
  if (undeclaredMetadata.length > 0) {
    failures.push(
      `${pluginId}: toolMetadata keys missing from contracts.tools: ${undeclaredMetadata.join(", ")}`,
    );
  }

  return failures;
}
