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
 * Rule A: every server route module is registered by the composition root
 * (`server.ts`) or by one of the `wiring/` modules it imports.
 * Rule B: no source module is reachable only from tests.
 * Rule C: every endpoint the server answers has a caller.
 * Rule D: no package module is used only by its own barrel.
 * Rule E: no module that exports runtime values is referenced only by type imports.
 * Rule F: no KNOWN_ISLANDS entry names a module that is reachable after all.
 * Rule G: the server's wiring modules carry no more forward references (late
 * cells and getters read per use) than {@link WIRING_CYCLE_CEILING} allows, and
 * the ceiling is tightened whenever a reference is removed.
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
 * does any non-test module import one of its exported names by name? An
 * earlier form matched the bare word anywhere in a file, which let a module
 * exporting a common word such as `hostId` pass on coincidence; a named import
 * binding is the evidence that a consumer reached for the export.
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
  ".agent-worktrees",
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
    "Browser-realm bundle entry built by remoteExitEvidenceA.smoke.test.ts via `bun build`; excluded from the server tsconfig on purpose. Remove once that evidence is served by a product caller or the smoke is retired.",
  ],
  [
    "apps/server/src/security/escapeSuite/evaluateEscapeSuite.ts",
    "Evaluator for the security escape suite, driven by escapeSuite.server.test.ts as its runner. Remove once a product runner imports it or the suite is retired.",
  ],
  [
    "apps/server/src/persistence/sqlitePort.conformance.ts",
    "Conformance kit that sqlitePort.test.ts and sqlitePort.smoke.ts run against the SQLite port; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the port's last conformance test is retired.",
  ],
  // ── Delivered ahead of its first caller by a staged design ──
  [
    "packages/domain/src/hostedRelayProtocol.ts",
    "Hosted relay route id derivation, registration message, and frame reader, delivered as the contracts-and-policy slice of docs/design/hosted-relay.md before the relay service and host connector that call it. Remove once the relay service reads frames with it.",
  ],
  [
    "packages/domain/src/remoteSourceAdmission.ts",
    "Admission table for the `relayed` source class, delivered as the contracts-and-policy slice of docs/design/hosted-relay.md; no transport produces `relayed` until the host connector does. Remove once the listener's source-class gates consult it.",
  ],
  [
    "packages/domain/src/hostedRelayPathPolicy.ts",
    "Client direct-or-relay path choice, delivered as the contracts-and-policy slice of docs/design/hosted-relay.md before the desktop and phone relay transports that call it. Remove once the desktop client chooses its path with it.",
  ],
  [
    "packages/contracts/src/hostedRelay.ts",
    "Hosted relay frame and grant schemas, reached only through hostedRelayProtocol.ts and hostedRelayPathPolicy.ts until the relay service and host connector decode frames with them. Remove once those policies' entries are removed.",
  ],
  // ── Reached only through another island, so an island with it ──
  [
    "packages/domain/src/auditPolicy.ts",
    "Audit redaction assertions whose only consumer is evaluateEscapeSuite.ts. Remove once a product runner reaches the escape suite or the suite is retired.",
  ],
  [
    "packages/client-runtime/src/remoteProductMutations.ts",
    "Remote product mutation exercisers whose only consumer is remoteExitEvidenceADriver.ts. Remove once a product caller serves that evidence or the smoke is retired.",
  ],
  [
    "packages/provider-sdk/src/outsideDriver.ts",
    "The author-facing re-export of the outside driver protocol schemas, whose only in-repository consumer is outsideDriverConformance.ts; the host reads the same schemas from @octant/contracts directly. Remove once a product module imports it or the conformance kit leaves the islands.",
  ],
  // ── Rule D: re-exported by a package barrel, used by nobody ──
  [
    "packages/provider-sdk/src/conformance.ts",
    "Provider conformance harness that chatProviderMatrixEvidence.test-support.ts runs against drivers; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the matrix evidence is retired.",
  ],
  [
    "packages/provider-sdk/src/contextFactsConformance.ts",
    "Conformance evidence a driver test runs against contextFacts; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the last driver test that uses the kit is retired.",
  ],
  [
    "packages/provider-sdk/src/directoryOAuthConformance.ts",
    "Directory sign-in conformance harness, with its fake directory and endpoint, that drivers declaring directory-oauth run in their tests; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the kind is retired.",
  ],
  [
    "packages/provider-sdk/src/cloudIamConformance.ts",
    "Cloud-IAM signing conformance harness, with its fake signer and endpoint, that drivers declaring cloud-iam run in their tests; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the kind is retired.",
  ],
  [
    "packages/provider-sdk/src/harnessEndpointConformance.ts",
    "Harness-endpoint-port conformance harness that direct-endpoint driver tests run; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the port is retired.",
  ],
  [
    "packages/provider-sdk/src/outsideDriverConformance.ts",
    "Out-of-process conformance kit that an outside driver's author runs in their own CI, and that the example loopback driver's tests run here; advisory test scaffolding by design, so reachable only from tests is its correct state. Remove once a product runner imports it or outside drivers are retired.",
  ],
  [
    "packages/provider-sdk/src/imageGenerationConformance.ts",
    "Image-seam conformance harness that image driver tests run; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the image seam is retired.",
  ],
  [
    "packages/provider-sdk/src/processPlacementConformance.ts",
    "Remote placement conformance harness that driver tests run against a stand-in target; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the placement seam is retired.",
  ],
  [
    "packages/plugin-api/src/desktopProviderConformance.ts",
    "Desktop-provider seam conformance harness that desktop driver tests run; test scaffolding by intent, and reachable only from tests is its correct state. Remove once a product runner imports it or the desktop-provider seam is retired.",
  ],
]);

/** Route modules exempt from Rule A, with the reason they are not registered. */
export const KNOWN_UNREGISTERED_ROUTES: ReadonlyMap<string, string> = new Map();

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

function isTestPath(path: string): boolean {
  return /\.test\.(ts|tsx)$/.test(path);
}

/**
 * Files that exist to be imported by tests: test files, smokes, fixtures, fakes,
 * and shared test support. "Reachable only from tests" is their correct state,
 * so they are never candidates, and what they import is not product use.
 */
function isTestScaffolding(path: string): boolean {
  if (isTestPath(path)) return true;
  if (path.endsWith(".smoke.ts")) return true;
  // Test scaffolding: fixtures, fakes, helpers, and support models exist to be
  // imported by tests, so "reachable only from tests" is their correct state.
  if (/(^|\/)fixtures\//.test(path)) return true;
  if (/[Ff]ixtures?\.(ts|tsx)$/.test(path)) return true;
  if (/\.test-(support|fixtures|certs)\.(ts|tsx)$/.test(path)) return true;
  if (/[Tt]est(Fixtures|Helpers|Model|Support)\.(ts|tsx)$/.test(path)) return true;
  if (/(^|\/)fake[A-Z][^/]*\.(ts|tsx)$/.test(path)) return true;
  if (/(^|\/)testSetup\.(ts|tsx)$/.test(path)) return true;
  return false;
}

/**
 * Files that are entry points or test scaffolding rather than product modules.
 * These are never candidates, because nothing is expected to import them.
 */
function isExemptByShape(path: string): boolean {
  if (isTestScaffolding(path)) return true;
  if (path.endsWith(".d.ts")) return true;
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
export function collectReferencedPaths(
  files: ReadonlyArray<ScannedFile>,
  islands: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  return collectReferences(files, extractSpecifiers, islands);
}

/**
 * The subset of {@link collectReferencedPaths} reached by an edge that survives
 * type erasure. An HTML script entry point is a runtime edge by definition.
 */
export function collectRuntimeReferencedPaths(
  files: ReadonlyArray<ScannedFile>,
  islands: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  return collectReferences(files, extractRuntimeSpecifiers, islands);
}

function collectReferences(
  files: ReadonlyArray<ScannedFile>,
  extract: (content: string) => ReadonlyArray<string>,
  islands: ReadonlySet<string>,
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
    // references originating in tests or the scaffolding they share (support
    // files, fixtures, fakes, smokes) never count toward reachability.
    if (isTestScaffolding(file.path)) continue;

    // An island is unreachable from the running host, so what it imports is not
    // product use either; counting it would hide every module only it depends on.
    if (islands.has(file.path)) continue;

    // Electron loads dedicated preloads from bundled output, so there is no
    // TypeScript import edge. Count only literal entries declared by tsdown.
    if (file.path.endsWith("/tsdown.config.ts")) {
      for (const entry of file.content.matchAll(/\bentry\s*:\s*\[([^\]]*)\]/g)) {
        for (const literal of (entry[1] ?? "").matchAll(/["']([^"']+\.(?:ts|tsx))["']/g)) {
          const source = literal[1];
          if (source === undefined) continue;
          const target = normalizeJoin(dirname(file.path), source);
          if (known.has(target)) referenced.add(target);
        }
      }
    }

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
  exemptions: ReadonlyMap<string, string> = KNOWN_ISLANDS,
  islands: ReadonlySet<string> = new Set(exemptions.keys()),
): ReadonlyArray<WiringViolation> {
  const referenced = collectReferencedPaths(files, islands);
  return files
    .filter((file) => isCandidate(file.path))
    .filter((file) => !referenced.has(file.path))
    .filter((file) => !exemptions.has(file.path))
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
  exemptions: ReadonlyMap<string, string> = KNOWN_ISLANDS,
  islands: ReadonlySet<string> = new Set(exemptions.keys()),
): ReadonlyArray<WiringViolation> {
  const referenced = collectReferencedPaths(files, islands);
  const runtimeReferenced = collectRuntimeReferencedPaths(files, islands);
  return files
    .filter((file) => isCandidate(file.path))
    .filter((file) => referenced.has(file.path) && !runtimeReferenced.has(file.path))
    .filter((file) => !exemptions.has(file.path))
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
 * The names a non-test module imports by name, from any specifier.
 *
 * Rule D used to search file contents for a bare word. A module exporting a
 * generic name — `hostId`, `Usage`, `reason` — then looked used wherever that
 * word appeared as a field or a local, so a barrel-only module could hide
 * behind a common word forever. Only a named import binding is evidence that
 * a module's export is what the consumer reached for. No first-party code
 * imports `@octant/*` as a namespace, so `import * as` is not a form this
 * needs to read.
 */
const NAMED_IMPORT_PATTERN = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;

export function extractImportedNames(content: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(NAMED_IMPORT_PATTERN)) {
    for (const binding of (match[1] ?? "").split(",")) {
      const local = binding.trim().replace(/^type\s+/, "");
      if (local === "") continue;
      const imported = local.split(/\s+as\s+/)[0]?.trim();
      if (imported !== undefined && imported !== "") names.add(imported);
    }
  }
  return names;
}

/**
 * Modules a package barrel re-exports that nothing actually uses.
 *
 * A barrel makes every module it names look referenced, so reachability by path
 * cannot see this. The question that survives is whether any name the module
 * exports is imported by name in non-test code somewhere other than the module
 * itself and the barrel that re-exports it. Tests, the scaffolding they share,
 * and modules that are themselves islands do not count as consumers: an island
 * is unreachable from the running host, so what it imports is not product use
 * either. A module exporting nothing is not a candidate: there is no name to
 * look for, and a side-effect-only module is answered by Rule B.
 */
export function findBarrelOnlyModules(
  files: ReadonlyArray<ScannedFile>,
  exemptions: ReadonlyMap<string, string> = KNOWN_ISLANDS,
  islands: ReadonlySet<string> = new Set(exemptions.keys()),
): ReadonlyArray<WiringViolation> {
  const candidates = files.filter(
    (file) =>
      /^packages\/[^/]+\/src\//.test(file.path) &&
      !isPackageBarrel(file.path) &&
      isCandidate(file.path),
  );
  if (candidates.length === 0) return [];

  const importedNames = new Map<string, ReadonlySet<string>>();
  for (const file of files) {
    if (
      !SOURCE_EXTENSIONS.some((extension) => file.path.endsWith(extension)) ||
      isTestScaffolding(file.path) ||
      islands.has(file.path) ||
      isPackageBarrel(file.path)
    ) {
      continue;
    }
    importedNames.set(file.path, extractImportedNames(file.content));
  }

  const violations: WiringViolation[] = [];
  for (const candidate of candidates) {
    if (exemptions.has(candidate.path)) continue;
    const names = extractExportedNames(candidate.content);
    if (names.length === 0) continue;
    let used = false;
    for (const [path, imported] of importedNames) {
      if (path === candidate.path) continue;
      if (names.some((name) => imported.has(name))) {
        used = true;
        break;
      }
    }
    if (used) continue;
    violations.push({
      path: candidate.path,
      reason:
        "only its own package barrel re-exports it and no non-test module imports any of its exports by name; wire it, delete it, or add it to KNOWN_ISLANDS with a reason",
    });
  }
  return violations;
}

/**
 * Exemptions that no longer exempt anything.
 *
 * An island entry is a reviewed reason for a module to be unreachable. Once the
 * module is wired, the reason is history and the entry is a claim about the
 * tree that is no longer true — two native-harness contract entries kept
 * saying "ahead of the server routing engine" for weeks after the router
 * imported them. Reporting the entry keeps the list a description of the
 * present, and keeps a later regression from hiding behind an old exemption.
 */
export function findStaleIslandExemptions(
  files: ReadonlyArray<ScannedFile>,
  exemptions: ReadonlyMap<string, string> = KNOWN_ISLANDS,
): ReadonlyArray<WiringViolation> {
  const known = new Set(files.map((file) => file.path));
  const none: ReadonlyMap<string, string> = new Map();
  const islands = new Set(exemptions.keys());
  const stillIslands = new Set(
    [
      ...findUnreachableModules(files, none, islands),
      ...findTypeOnlyReferencedModules(files, none, islands),
      ...findBarrelOnlyModules(files, none, islands),
    ].map((violation) => violation.path),
  );
  const violations: WiringViolation[] = [];
  for (const path of exemptions.keys()) {
    if (!known.has(path)) {
      violations.push({
        path,
        reason: "KNOWN_ISLANDS exempts a module that no longer exists; remove the entry",
      });
      continue;
    }
    if (!stillIslands.has(path)) {
      violations.push({
        path,
        reason:
          "KNOWN_ISLANDS exempts a module that product code now reaches; remove the entry so the reason stops describing a tree that no longer exists",
      });
    }
  }
  return violations;
}

const SERVER_ROOT_PATH = "apps/server/src/server.ts";
const SERVER_WIRING_PREFIX = "apps/server/src/wiring/";

export function findUnregisteredRouteModules(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<WiringViolation> {
  const server = files.find((file) => file.path === SERVER_ROOT_PATH);
  if (server === undefined) return [];
  const known = new Set(files.map((file) => file.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const resolveImports = (file: ScannedFile): ReadonlyArray<string> =>
    extractSpecifiers(file.content)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolveRelative(file.path, specifier, known))
      .filter((resolved): resolved is string => resolved !== undefined);
  // The root composes per-area wiring modules; a route handler is registered
  // when the root or one of those modules imports it.
  const registered = new Set<string>();
  for (const resolved of resolveImports(server)) {
    registered.add(resolved);
    const wiring = byPath.get(resolved);
    if (wiring === undefined || !resolved.startsWith(SERVER_WIRING_PREFIX)) continue;
    for (const nested of resolveImports(wiring)) registered.add(nested);
  }
  return files
    .filter((file) => /^apps\/server\/src\/.*Routes\.ts$/.test(file.path))
    .filter((file) => !isTestPath(file.path))
    .filter((file) => !registered.has(file.path))
    .filter((file) => !KNOWN_UNREGISTERED_ROUTES.has(file.path))
    .map((file) => ({
      path: file.path,
      reason:
        "route module is never imported by apps/server/src/server.ts or a wiring module it composes, so its endpoints 404",
    }));
}

/**
 * Endpoints that are served but which nothing calls. Each remaining entry
 * states a dated reason and the caller it is waiting on. Empty means every
 * served endpoint has a caller (or is a routing prefix).
 */
export const KNOWN_UNCALLED_ENDPOINTS: ReadonlyMap<string, string> = new Map([
  [
    "/api/code/language/documents",
    "Language services' document sync, served by the host since 2026-10-26 ahead of the editor that calls it (docs/design/language-services.md, delivery plan slice 3). Remove once the Code editor syncs its open documents.",
  ],
  [
    "/api/code/language/read",
    "Language services' diagnostics and definition reads, served by the host since 2026-10-26 ahead of the editor that calls them (docs/design/language-services.md, delivery plan slice 3). Remove once the Code editor shows diagnostics and jumps to definitions.",
  ],
  ...[
    "/api/hub/join",
    "/api/hub/leave",
    "/api/hub/roster",
    "/api/hub/status",
    "/api/hub/standby",
    "/api/hub/heartbeat",
    "/api/hub/handback",
    "/api/hub/wake-times",
    "/api/hub/wake-nudge",
    "/api/hub/wake-copy",
    "/api/hub/push",
    "/api/hub/push-grant",
    "/api/hub/push-copy",
  ].map((endpoint): [string, string] => [
    endpoint,
    "Member-to-member request that a hub, standby, or spoke signs and sends over the private listener from apps/server (hubService.ts, spokeLinkService.ts, failoverService.ts, wakeService.ts, spokeWakeService.ts, pushService.ts, spokePushService.ts), which builds the path itself; no window or device calls it. Remove when the checker counts apps/server as a caller of its own listener's routes.",
  ]),
  ...["/api/hub/guest", "/api/hub/guest-roster"].map((endpoint): [string, string] => [
    endpoint,
    "Served to a guest's signed request from the phone app, which builds the path inside the guest client in packages/client-runtime (hubGuestClient.ts); no window script names it. Remove when the checker counts packages/client-runtime as a caller of a host route.",
  ]),
  ...[
    "/api/hub/peer/delegations",
    "/api/hub/peer/delegations/status",
    "/api/hub/peer/delegations/cancel",
  ].map((endpoint): [string, string] => [
    endpoint,
    "A delegating spoke signs and sends this over the private listener from apps/server (delegatingSpokeService.ts), which builds the path itself; no window or device calls it. Remove when the checker counts apps/server as a caller of its own listener's routes.",
  ]),
  ...[
    "/api/desktop/hub/delegations",
    "/api/desktop/hub/delegations/read",
    "/api/desktop/hub/delegations/cancel",
  ].map((endpoint): [string, string] => [
    endpoint,
    "Starts, reads, and cancels a remote child run for one of this spoke's threads. It is the loopback entry point until the agent tool surface carries a target member (docs/design/hub-and-spokes.md, delivery plan slice 6); no window script or desktop bridge operation names it yet. Remove once the agent tool or a window calls it.",
  ]),
  [
    "/api/desktop/hub/members/held",
    "Lists the members this host holds under Confirm new members. The window reads the same list from the hub status read (apps/web HubSettingsSection), because the desktop bridge's operation list (apps/desktop hubAdministrationControls.ts) does not name this route yet. Remove once the bridge forwards it.",
  ],
  [
    "/api/v1/shares",
    "Served by the public Canvas share service (the octant-webapp repository) and called by the host's share-service port in apps/server, which builds the address from the configured service URL; no window or device calls it. Remove when the checker counts apps/server as a caller of an external service's routes.",
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
      // An island is unreachable from the running server, so path strings in it
      // cannot be endpoints the host answers. The remote-exit evidence driver is
      // a browser bundle that constructs client paths; counting those as served
      // invented two uncalled "product" routes the Chat handler never registered.
      if (KNOWN_ISLANDS.has(file.path)) continue;
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

/**
 * What the server's wiring modules still read before the value exists: values
 * one module assigns after another has captured them (`LateBindings` cells)
 * and getters a dependency type carries for a value a later module creates.
 * Each is a cycle between areas. The ceiling only goes down: removing a
 * reference without lowering it fails Rule G, so the debt cannot creep back.
 */
export const WIRING_CYCLE_CEILING = { lateCells: 0, forwardGetters: 7 } as const;

const LATE_BINDINGS_PATH = "apps/server/src/wiring/lateBindings.ts";
const LATE_CELL_PATTERN = /^ {2}readonly \w+:/gm;
const FORWARD_GETTER_PATTERN =
  /\/\*\* Wired by \w+; read only after startup\. \*\/\s*readonly \w+: \(\)\s*=>/g;

export function countWiringCycleDebt(files: ReadonlyArray<ScannedFile>): {
  readonly lateCells: number;
  readonly forwardGetters: number;
} {
  let lateCells = 0;
  let forwardGetters = 0;
  for (const file of files) {
    if (file.path === LATE_BINDINGS_PATH) {
      const start = file.content.indexOf("export interface LateBindings");
      lateCells =
        start === -1 ? 0 : (file.content.slice(start).match(LATE_CELL_PATTERN) ?? []).length;
    } else if (file.path.startsWith(SERVER_WIRING_PREFIX) && !isTestPath(file.path)) {
      forwardGetters += (file.content.match(FORWARD_GETTER_PATTERN) ?? []).length;
    }
  }
  return { lateCells, forwardGetters };
}

export function findWiringCycleDebt(
  files: ReadonlyArray<ScannedFile>,
  ceiling: { readonly lateCells: number; readonly forwardGetters: number } = WIRING_CYCLE_CEILING,
): ReadonlyArray<WiringViolation> {
  if (!files.some((file) => file.path === SERVER_ROOT_PATH)) return [];
  const counted = countWiringCycleDebt(files);
  const violations: WiringViolation[] = [];
  const check = (name: string, found: number, allowed: number, path: string) => {
    if (found > allowed) {
      violations.push({
        path,
        reason: `${found} ${name} exceed the ceiling of ${allowed}; build the value before the module that reads it instead of adding a forward reference`,
      });
    } else if (found < allowed) {
      violations.push({
        path,
        reason: `${found} ${name} remain but the ceiling is ${allowed}; lower WIRING_CYCLE_CEILING in scripts/check-module-wiring.ts`,
      });
    }
  };
  check("late cells", counted.lateCells, ceiling.lateCells, LATE_BINDINGS_PATH);
  check("forward getters", counted.forwardGetters, ceiling.forwardGetters, SERVER_WIRING_PREFIX);
  return violations;
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
    ...findStaleIslandExemptions(files),
    ...findWiringCycleDebt(files),
  ];
}

export async function collectFiles(
  root: string,
  directory = root,
): Promise<ReadonlyArray<ScannedFile>> {
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
