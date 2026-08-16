import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repository wiring gate.
 *
 * Unit coverage cannot tell a reachable module from an unreachable one: a module
 * that only its own test imports is exercised, green, and invisible to users. A
 * 2026-08-15 audit found 29 such modules, including the one
 * route module of 47 that `server.ts` never registered, whose endpoints answered
 * 404 on a booted host.
 *
 * Rule A: every server route module is registered in `server.ts`.
 * Rule B: no source module is reachable only from tests.
 * Rule C: every endpoint the server answers has a caller.
 * Rule D: no package module is used only by its own barrel.
 * Rule E: no module that exports runtime values is referenced only by type imports.
 *
 * Rule B recognizes real non-import entry points (HTML scripts, dynamic
 * `import()`, package `exports` subpaths, binaries) rather than listing them by
 * hand. Everything else needs an entry in {@link KNOWN_ISLANDS} with a reason,
 * which makes the remaining debt reviewable instead of silent.
 *
 * Rule D closes the blind spot Rules A–C left open. `packages/domain/src/index.ts`
 * re-exports every module in the package, and consumers import the barrel
 * specifier (`@octant/domain`) rather than a path, so path-based reachability
 * marks a module referenced the moment the barrel names it — whether or not
 * anything uses what it exports. A 2026-08-15 audit found five such modules,
 * including a complete Canvas sharing policy no server or renderer had ever
 * called. Rule D therefore asks a different question for barrel-only modules:
 * does any exported name appear anywhere else in non-test code? Matching by
 * name over-counts rather than under-counts — a coincidental match suppresses a
 * violation — which is the right bias for a gate that must not cry wolf.
 *
 * Rule E closes the blind spot Rule B leaves: a path-based edge is not a runtime
 * edge. `import { type CodeThreadProviderChoice } from "./CodeThreadCreateDialog"`
 * makes a React component look mounted when TypeScript erases that import
 * entirely and production never renders the component. A blanket "type imports
 * do not count" rule would be noise — a module that exports only types is
 * correctly referenced that way — so Rule E asks both questions together: does
 * the module export a runtime value, and is every non-test reference to it
 * type-only? Import and export kinds are classified conservatively, so any form
 * the classifier cannot read falls back to "runtime", which suppresses a
 * violation rather than inventing one.
 */

export interface ScannedFile {
  readonly path: string;
  readonly content: string;
}

export interface WiringViolation {
  readonly path: string;
  readonly reason: string;
}

const IGNORED_DIRECTORIES = new Set([
  // Local session state, including agent worktrees — each a full repo copy
  // whose package.json files would otherwise hijack the exports map and make
  // subpath-imported modules look unreferenced in the real tree.
  ".claude",
  ".git",
  ".octant",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

/**
 * Modules that are deliberately unreachable today. Every entry states why, so an
 * exemption is a reviewed decision rather than an oversight. Removing an entry
 * as its island is wired or deleted is the intended direction of travel.
 */
export const KNOWN_ISLANDS: ReadonlyMap<string, string> = new Map([
  // ── Remaining ──
  [
    "apps/server/src/remote/remoteExitEvidenceADriver.ts",
    "Browser-realm bundle entry built by remoteExitEvidenceA.smoke.test.ts via `bun build`; excluded from the server tsconfig on purpose.",
  ],
  [
    "apps/server/src/security/escapeSuite/evaluateEscapeSuite.ts",
    "Evaluator for the security escape suite, driven by escapeSuite.server.test.ts as its runner.",
  ],
  [
    "apps/server/src/context/externalContentTaintProjection.ts",
    "Security-relevant. Live enforcement runs through externalContentFraming and toolCallAuthorityService; removing a taint projection needs a security review.",
  ],
  // ── Rule D: re-exported by a package barrel, used by nobody ──
  [
    "packages/provider-sdk/src/childAgentConformance.ts",
    "Conformance kit for child-agent adapters, driven only by childAgentConformance.test.ts as its runner (like the other provider-sdk conformance kits).",
  ],
  [
    "packages/domain/src/cursorAcpRuntimePolicy.ts",
    "Cursor is deferred pending an ACP compatibility GO. Honest to keep until that provider lands.",
  ],
  [
    "packages/domain/src/cursorAcpSettingsPolicy.ts",
    "Cursor is deferred pending an ACP compatibility GO. Honest to keep until that provider lands.",
  ],
  [
    "packages/domain/src/canvasShareAccessLogPolicy.ts",
    "Canvas sharing is being wired now; remove this entry once the share surface records access through it.",
  ],
  [
    "packages/provider-sdk/src/contextFactsConformance.ts",
    "Conformance evidence a driver test runs against contextFacts; test scaffolding by intent, and reachable only from tests is its correct state.",
  ],
  // ── Rule E: imported, but only by statements the compiler erases ──
  [
    "apps/server/src/automation/automationDispatchPort.ts",
    "The `AutomationDispatchPort`/`AutomationDispatchOffer` types are a live seam between the A3 scheduler and the A4 dispatcher, but the module's only runtime export, `unavailableAutomationDispatchPort()`, has no reference anywhere — not even a test. Deleting that fallback clears this entry; it belongs to the in-flight automation dispatch work rather than a wiring pass.",
  ],
  [
    "apps/server/src/automation/automationModeDispatchPorts.ts",
    "`unavailableAutomationWorkDispatchPort()` is a test-only fallback: automationDispatchService, automationCodeDispatchPort, and automationWorkDispatchPort import this module for its types alone, and both callers of the function are tests. As with contextFactsConformance above, reachable only from tests may be its correct state — in which case the fallback belongs in test scaffolding. Owned by the in-flight automation dispatch work.",
  ],
]);

/** Route modules exempt from Rule A, with the reason they are not registered. */
export const KNOWN_UNREGISTERED_ROUTES: ReadonlyMap<string, string> = new Map();

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

function isTestPath(path: string): boolean {
  return /\.test\.(ts|tsx)$/.test(path);
}

/**
 * Files that are entry points or test scaffolding rather than product modules.
 * These are never candidates, because nothing is expected to import them.
 */
function isExemptByShape(path: string): boolean {
  if (isTestPath(path)) return true;
  if (path.endsWith(".d.ts")) return true;
  if (path.endsWith(".smoke.ts")) return true;
  // Test scaffolding: fixtures, fakes, helpers, and support models exist to be
  // imported by tests, so "reachable only from tests" is their correct state.
  if (/(^|\/)fixtures\//.test(path)) return true;
  if (/[Ff]ixtures?\.(ts|tsx)$/.test(path)) return true;
  if (/\.test-(support|fixtures|certs)\.(ts|tsx)$/.test(path)) return true;
  if (/[Tt]est(Fixtures|Helpers|Model|Support)\.(ts|tsx)$/.test(path)) return true;
  if (/(^|\/)fake[A-Z][^/]*\.(ts|tsx)$/.test(path)) return true;
  if (/(^|\/)testSetup\.(ts|tsx)$/.test(path)) return true;
  // Process entry points are launched by path or config, never imported.
  if (/(^|\/)(main|bin|index|preload)\.(ts|tsx)$/.test(path)) return true;
  if (path.endsWith("Cli.ts")) return true;
  // Platform variants are selected by the bundler from the base specifier.
  if (/\.(web|native|ios|android)\.(ts|tsx)$/.test(path)) return true;
  return false;
}

function isCandidate(path: string): boolean {
  if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) return false;
  if (!/^(apps|packages)\/[^/]+\/src\//.test(path)) return false;
  return !isExemptByShape(path);
}

// Side-effect imports (`import "./workFormatAdapters";`) register adapters
// without binding a name, so they must count as references like any other edge.
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

export function extractSpecifiers(content: string): ReadonlyArray<string> {
  return [...content.matchAll(SPECIFIER_PATTERN)].map((match) => match[1] as string);
}

/**
 * The binding clause of an `import ... from` or `export ... from` statement, so
 * its kind can be read. The clause charset admits only what a binding list can
 * contain, which stops a match at the first quote, semicolon, colon, or operator
 * and keeps the pattern from running away across a file. Dynamic `import()` and
 * `require()` have no clause and never match, which is correct: both load the
 * module at runtime.
 */
const IMPORT_CLAUSE_PATTERN =
  /\b(?:import|export)\s+([A-Za-z0-9_$*,{}\s]*?)\bfrom\s*["']([^"']+)["']/g;

/** Named bindings inside a `{ ... }` clause, with a trailing comma tolerated. */
function bindingsIn(clause: string): ReadonlyArray<string> {
  return clause
    .slice(1, -1)
    .split(",")
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0);
}

/**
 * True when TypeScript erases the whole statement, so it creates no runtime
 * edge: `import type { X } from "m"`, `export type { X } from "m"`, and a named
 * list whose every binding carries the inline `type` modifier. A mixed list
 * (`{ type A, B }`) keeps B at runtime and is therefore a runtime reference, as
 * is a default or namespace binding. `{ type }` and `{ type as T }` import a
 * value named `type` and stay runtime.
 */
export function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\b/.test(trimmed)) return true;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  const bindings = bindingsIn(trimmed);
  if (bindings.length === 0) return false;
  return bindings.every((binding) => /^type\s+(?!as\b)/.test(binding));
}

/**
 * The specifiers a module loads at runtime: every specifier {@link
 * extractSpecifiers} sees, minus the occurrences whose statement TypeScript
 * erases. Counting occurrences rather than filtering by specifier keeps a module
 * imported both ways — a type import in one statement and a value import in
 * another — a runtime reference. A statement the clause pattern cannot read
 * simply stays in the runtime set.
 */
export function extractRuntimeSpecifiers(content: string): ReadonlyArray<string> {
  const erased = new Map<string, number>();
  for (const match of content.matchAll(IMPORT_CLAUSE_PATTERN)) {
    if (!isTypeOnlyClause(match[1] as string)) continue;
    const specifier = match[2] as string;
    erased.set(specifier, (erased.get(specifier) ?? 0) + 1);
  }
  if (erased.size === 0) return extractSpecifiers(content);
  const runtime: string[] = [];
  for (const specifier of extractSpecifiers(content)) {
    const remaining = erased.get(specifier) ?? 0;
    if (remaining > 0) {
      erased.set(specifier, remaining - 1);
      continue;
    }
    runtime.push(specifier);
  }
  return runtime;
}

const RUNTIME_EXPORT_PATTERN =
  /^export\s+(?!type\s|type\{|interface\s|declare\s)(?:default\b|abstract\s+class\b|async\s+function\b|function\b|const\b|let\b|var\b|class\b|enum\b|\*)/m;
const EXPORT_CLAUSE_PATTERN = /^export\s*(\{[^}]*\})/gm;
const ANY_EXPORT_PATTERN = /^export\b/m;

/**
 * True when the module contributes something that exists after type erasure: a
 * function, class, const, enum, `export *`, a named re-export that is not
 * type-only, or — for a side-effect-only module — the module body itself.
 * `export declare` is ambient and emits nothing, so it does not count. The bias
 * is conservative: a module this cannot read as runtime is treated as type-only
 * and Rule E leaves it alone.
 */
export function hasRuntimeExport(content: string): boolean {
  if (RUNTIME_EXPORT_PATTERN.test(content)) return true;
  for (const match of content.matchAll(EXPORT_CLAUSE_PATTERN)) {
    if (!isTypeOnlyClause(match[1] as string)) return true;
  }
  return !ANY_EXPORT_PATTERN.test(content);
}

/**
 * Map every package `exports` subpath to the file it serves, so a kebab-case
 * specifier such as `@octant/client-runtime/preview-client` resolves to
 * `packages/client-runtime/src/previewClient.ts`. Resolving by basename instead
 * would silently miscount these as unreferenced.
 */
export function buildPackageExportMap(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    if (!/(^|\/)package\.json$/.test(file.path)) continue;
    if (/(^|\/)node_modules\//.test(file.path)) continue;
    let parsed: { name?: string; exports?: unknown; bin?: unknown };
    try {
      parsed = JSON.parse(file.content) as typeof parsed;
    } catch {
      continue;
    }
    if (typeof parsed.name !== "string") continue;
    const packageRoot = dirname(file.path);
    const record = parsed.exports;
    if (record === null || typeof record !== "object") continue;
    for (const [subpath, target] of Object.entries(record as Record<string, unknown>)) {
      if (typeof target !== "string") continue;
      const specifier =
        subpath === "." ? parsed.name : `${parsed.name}/${subpath.replace(/^\.\//, "")}`;
      const targetPath = normalizeJoin(packageRoot, target.replace(/^\.\//, ""));
      map.set(specifier, targetPath);
    }
  }
  return map;
}

function normalizeJoin(base: string, relativePath: string): string {
  const segments = `${base}/${relativePath}`.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

/** Resolve a relative specifier the way the bundler would, trying extensions. */
function resolveRelative(fromPath: string, specifier: string, known: ReadonlySet<string>) {
  const base = normalizeJoin(dirname(fromPath), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
    // `./sqlitePort.node.ts` style specifiers already carry an extension.
    base.replace(/\.ts$/, ".ts"),
  ];
  return candidates.find((candidate) => known.has(candidate));
}

/**
 * Every file reachable from a non-test module, an HTML entry point, or a package
 * export that something imports.
 */
export function collectReferencedPaths(files: ReadonlyArray<ScannedFile>): ReadonlySet<string> {
  return collectReferences(files, extractSpecifiers);
}

/**
 * The subset of {@link collectReferencedPaths} reached by an edge that survives
 * type erasure. An HTML script entry point is a runtime edge by definition.
 */
export function collectRuntimeReferencedPaths(
  files: ReadonlyArray<ScannedFile>,
): ReadonlySet<string> {
  return collectReferences(files, extractRuntimeSpecifiers);
}

function collectReferences(
  files: ReadonlyArray<ScannedFile>,
  extract: (content: string) => ReadonlyArray<string>,
): ReadonlySet<string> {
  const known = new Set(files.map((file) => file.path));
  const exportMap = buildPackageExportMap(files);
  const referenced = new Set<string>();

  for (const file of files) {
    const isHtml = file.path.endsWith(".html");
    const isSource = SOURCE_EXTENSIONS.some((extension) => file.path.endsWith(extension));
    if (!isHtml && !isSource) continue;

    if (isHtml) {
      // <script type="module" src="/src/canvas/browserHarness.tsx">
      for (const match of file.content.matchAll(/src=["']\/?([^"']+\.(?:ts|tsx))["']/g)) {
        const target = normalizeJoin(dirname(file.path), (match[1] as string).replace(/^\//, ""));
        if (known.has(target)) referenced.add(target);
      }
      continue;
    }

    // A test may only confirm that non-test code already reaches a module, so
    // references originating in tests never count toward reachability.
    if (isTestPath(file.path)) continue;

    for (const specifier of extract(file.content)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file.path, specifier, known);
        if (resolved !== undefined) referenced.add(resolved);
        continue;
      }
      const mapped = exportMap.get(specifier);
      if (mapped !== undefined) referenced.add(mapped);
    }
  }
  return referenced;
}

export function findUnreachableModules(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<WiringViolation> {
  const referenced = collectReferencedPaths(files);
  return files
    .filter((file) => isCandidate(file.path))
    .filter((file) => !referenced.has(file.path))
    .filter((file) => !KNOWN_ISLANDS.has(file.path))
    .map((file) => ({
      path: file.path,
      reason:
        "reachable only from tests; wire it, delete it, or add it to KNOWN_ISLANDS with a reason",
    }));
}

/**
 * Modules whose only non-test references are erased by the compiler.
 *
 * Rule B already reports a module with no reference at all, so the candidates
 * here are exactly the modules Rule B considers wired: referenced somewhere, but
 * by nothing that survives to runtime. A module that exports only types is not a
 * candidate — being named by a type import is how such a module is meant to be
 * used.
 */
export function findTypeOnlyReferencedModules(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<WiringViolation> {
  const referenced = collectReferencedPaths(files);
  const runtimeReferenced = collectRuntimeReferencedPaths(files);
  return files
    .filter((file) => isCandidate(file.path))
    .filter((file) => referenced.has(file.path) && !runtimeReferenced.has(file.path))
    .filter((file) => !KNOWN_ISLANDS.has(file.path))
    .filter((file) => hasRuntimeExport(file.content))
    .map((file) => ({
      path: file.path,
      reason:
        "exports runtime values, but every non-test import of it is type-only, so the compiler erases every edge and nothing ever loads it; give it a real caller, drop its runtime exports, delete it, or add it to KNOWN_ISLANDS with a reason",
    }));
}

/** `packages/<name>/src/index.ts` — a package's distribution surface. */
function isPackageBarrel(path: string): boolean {
  return /^packages\/[^/]+\/src\/index\.ts$/.test(path);
}

const EXPORTED_NAME_PATTERN =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

export function extractExportedNames(content: string): ReadonlyArray<string> {
  return [...content.matchAll(EXPORTED_NAME_PATTERN)].map((match) => match[1] as string);
}

/**
 * Modules a package barrel re-exports that nothing actually uses.
 *
 * A barrel makes every module it names look referenced, so reachability by path
 * cannot see this. The question that survives is whether any name the module
 * exports appears in non-test code somewhere other than the module itself and
 * the barrel that re-exports it. A module exporting nothing is not a candidate:
 * there is no name to look for, and a side-effect-only module is answered by
 * Rule B.
 */
export function findBarrelOnlyModules(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<WiringViolation> {
  const candidates = files.filter(
    (file) =>
      /^packages\/[^/]+\/src\//.test(file.path) &&
      !isPackageBarrel(file.path) &&
      isCandidate(file.path),
  );
  if (candidates.length === 0) return [];

  const searchable = files.filter(
    (file) =>
      SOURCE_EXTENSIONS.some((extension) => file.path.endsWith(extension)) &&
      !isTestPath(file.path) &&
      !isPackageBarrel(file.path),
  );

  const violations: WiringViolation[] = [];
  for (const candidate of candidates) {
    if (KNOWN_ISLANDS.has(candidate.path)) continue;
    const names = extractExportedNames(candidate.content);
    if (names.length === 0) continue;
    const patterns = names.map((name) => new RegExp(`\\b${name}\\b`));
    const used = searchable.some(
      (file) =>
        file.path !== candidate.path && patterns.some((pattern) => pattern.test(file.content)),
    );
    if (used) continue;
    violations.push({
      path: candidate.path,
      reason:
        "only its own package barrel re-exports it and no non-test module uses any of its exports; wire it, delete it, or add it to KNOWN_ISLANDS with a reason",
    });
  }
  return violations;
}

export function findUnregisteredRouteModules(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<WiringViolation> {
  const server = files.find((file) => file.path === "apps/server/src/server.ts");
  if (server === undefined) return [];
  const known = new Set(files.map((file) => file.path));
  const registered = new Set<string>();
  for (const specifier of extractSpecifiers(server.content)) {
    if (!specifier.startsWith(".")) continue;
    const resolved = resolveRelative(server.path, specifier, known);
    if (resolved !== undefined) registered.add(resolved);
  }
  return files
    .filter((file) => /^apps\/server\/src\/.*Routes\.ts$/.test(file.path))
    .filter((file) => !isTestPath(file.path))
    .filter((file) => !registered.has(file.path))
    .filter((file) => !KNOWN_UNREGISTERED_ROUTES.has(file.path))
    .map((file) => ({
      path: file.path,
      reason: "route module is never imported by apps/server/src/server.ts, so its endpoints 404",
    }));
}

/**
 * Endpoints that are served but which nothing calls. Each entry states why.
 * These are a distinct failure from an unreachable module: the route module is
 * registered and the server answers, but no client, desktop, CLI, or mobile
 * caller ever constructs the path, so the capability is unusable in practice.
 */
export const KNOWN_UNCALLED_ENDPOINTS: ReadonlyMap<string, string> = new Map([
  [
    "/api/agent-profiles/scope",
    "Clients call the /api/agent-profiles base only; the scope sub-route has no caller.",
  ],
  [
    "/api/chat/evidence/mutation",
    "Chat evidence surface with no client path construction; appears to serve a QA/evidence flow that was never given a caller.",
  ],
  ["/api/chat/evidence/stream", "As above; the evidence stream has no caller."],
  [
    "/api/desktop/code-managed-root-grants",
    "Desktop-bridge managed-root grant flow with no caller. Managed worktree creation itself is reachable through the Code service path, so this bridge surface is unused rather than the feature being broken.",
  ],
  [
    "/api/desktop/code-managed-worktrees",
    "As above: the desktop-bridge create surface has no caller.",
  ],
  [
    "/api/desktop/code-managed-worktrees/cleanup",
    "As above: the desktop-bridge cleanup surface has no caller.",
  ],
]);

const API_PATH_PATTERN = /"(\/api\/[a-z0-9/_-]+)"/g;
const PREFIX_GUARD_PATTERN = /startsWith\(\s*"(\/api\/[a-z0-9/_-]+)"/g;

function apiPathsIn(content: string, pattern: RegExp): ReadonlyArray<string> {
  return [...content.matchAll(pattern)].map((match) => (match[1] as string).replace(/\/+$/, ""));
}

const CALLER_ROOTS = [
  "packages/client-runtime/src/",
  "apps/web/src/",
  "apps/desktop/src/",
  "apps/mobile/src/",
  "packages/cli/src/",
];

/**
 * Rule C: every endpoint the server answers has a caller.
 *
 * Prefix guards are detected structurally — a path used inside `startsWith(` is
 * a routing prefix, not an endpoint — so they do not need listing by hand. A
 * caller that constructs a longer path under an endpoint counts as calling it.
 */
export function findUncalledEndpoints(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<WiringViolation> {
  const isTest = (path: string) => /\.test\.(ts|tsx)$/.test(path) || path.endsWith(".smoke.ts");
  const served = new Set<string>();
  const prefixes = new Set<string>();
  const called = new Set<string>();

  for (const file of files) {
    if (isTest(file.path)) continue;
    if (file.path.startsWith("apps/server/src/")) {
      for (const p of apiPathsIn(file.content, API_PATH_PATTERN)) served.add(p);
      for (const p of apiPathsIn(file.content, PREFIX_GUARD_PATTERN)) prefixes.add(p);
      continue;
    }
    if (CALLER_ROOTS.some((root) => file.path.startsWith(root))) {
      for (const p of apiPathsIn(file.content, API_PATH_PATTERN)) called.add(p);
    }
  }

  const callers = [...called];
  return [...served]
    .filter((endpoint) => !prefixes.has(endpoint))
    .filter((endpoint) => !called.has(endpoint))
    .filter((endpoint) => !callers.some((caller) => caller.startsWith(`${endpoint}/`)))
    .filter((endpoint) => !KNOWN_UNCALLED_ENDPOINTS.has(endpoint))
    .sort()
    .map((endpoint) => ({
      path: endpoint,
      reason:
        "endpoint is served but no client, desktop, CLI, or mobile caller constructs it; give it a caller or add it to KNOWN_UNCALLED_ENDPOINTS with a reason",
    }));
}

export function findWiringViolations(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<WiringViolation> {
  return [
    ...findUnregisteredRouteModules(files),
    ...findUnreachableModules(files),
    ...findTypeOnlyReferencedModules(files),
    ...findUncalledEndpoints(files),
    ...findBarrelOnlyModules(files),
  ];
}

async function collectFiles(root: string, directory = root): Promise<ReadonlyArray<ScannedFile>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<ReadonlyArray<ScannedFile>> => {
      if (IGNORED_DIRECTORIES.has(entry.name)) return [];
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectFiles(root, absolutePath);
      if (!/\.(ts|tsx|html|json)$/.test(entry.name)) return [];
      const raw = await readFile(absolutePath);
      return [
        {
          path: relative(root, absolutePath).split("\\").join("/"),
          content: raw.includes(0) ? "" : raw.toString("utf8"),
        },
      ];
    }),
  );
  return nested.flat();
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const violations = findWiringViolations(await collectFiles(root));
  if (violations.length === 0) return;
  for (const violation of violations) {
    console.error(`${violation.path}: ${violation.reason}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) await main();
