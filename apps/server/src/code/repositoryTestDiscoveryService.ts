import { createHash } from "node:crypto";
import {
  decodeCodeRepositoryTestDefinitionFile,
  type CodeRepositoryTestDefinition,
  type CodeRepositoryTestDefinitionSource,
  type CodeTestDefinitionId,
  type CodeTestPackageManager,
} from "@octant/contracts";
import { classifyPathContainment } from "@octant/domain";
import {
  liveCodeTestSourcePort,
  type CodeDirectoryStat,
  type CodeOpenFile,
  type CodeTestSourcePort,
} from "./codeDirectoryPort";
import { isAbsolutePosixPath, joinCodePath, resolveContainedPath } from "./codePathConfinement";
import { TestDefinitionService } from "./testDefinitionService";

/** The only two files discovery reads, both relative to the checkout root. */
const PACKAGE_JSON_PATH = "package.json";
const OCTANT_TESTS_PATH = ".octant/tests.json";

/**
 * Bound on one source file. A `package.json` or `.octant/tests.json` larger
 * than this is not a definition source anyone authored by hand, and reading it
 * would cost the host memory for no user-visible gain.
 */
export const MAX_TEST_SOURCE_BYTES = 1_048_576;

/**
 * Bound on one discovered list. The renderer offers definitions in a picker, so
 * an unbounded list would only make the surface unusable while enlarging every
 * listing response.
 */
const MAX_DISCOVERED_TEST_DEFINITIONS = 64;

/**
 * Timeout applied to a package script, which carries no timeout of its own.
 * `.octant/tests.json` states its own timeout and keeps it.
 */
const DEFAULT_PACKAGE_SCRIPT_TIMEOUT_MS = 15 * 60 * 1000;

const PACKAGE_MANAGERS: ReadonlyArray<CodeTestPackageManager> = ["bun", "npm", "pnpm", "yarn"];

const utf8 = new TextDecoder("utf-8");

export interface RepositoryTestDiscoveryRequest {
  /** Identity of the checkout the definitions belong to; part of every id. */
  readonly checkoutId: string;
  /** Canonical host path of the checkout this thread is bound to. */
  readonly rootPath: string;
}

export interface RepositoryTestDiscoveryServiceOptions {
  readonly sourcePort?: CodeTestSourcePort;
}

/**
 * Server-authoritative discovery of the repository tests a Code thread may run.
 *
 * The renderer never authors a test definition: it picks one of these. Reading
 * is confined to the checkout root's `package.json` and `.octant/tests.json`,
 * and every path runs the shared confinement sequence, so a symlinked
 * `.octant` cannot make discovery read anything outside the bound checkout.
 *
 * Discovery fails closed to an empty list rather than throwing. A repository
 * with no tests, an unreadable root, and an invalid `.octant/tests.json` are
 * all "there is nothing you may run here" — none of them is a reason to take
 * the Code workspace down.
 */
export class RepositoryTestDiscoveryService {
  readonly #source: CodeTestSourcePort;
  readonly #definitions = new TestDefinitionService();

  constructor(options: RepositoryTestDiscoveryServiceOptions = {}) {
    this.#source = options.sourcePort ?? liveCodeTestSourcePort;
  }

  async discover(
    request: RepositoryTestDiscoveryRequest,
  ): Promise<ReadonlyArray<CodeRepositoryTestDefinition>> {
    const canonicalRoot = await this.#canonicalRoot(request.rootPath);
    if (canonicalRoot === undefined) return [];
    const discovered = [
      ...this.#fromPackageScripts(
        request.checkoutId,
        await this.#readJson(canonicalRoot, PACKAGE_JSON_PATH),
      ),
      ...this.#fromOctantFile(
        request.checkoutId,
        await this.#readJson(canonicalRoot, OCTANT_TESTS_PATH),
      ),
    ];
    return discovered.slice(0, MAX_DISCOVERED_TEST_DEFINITIONS);
  }

  async #canonicalRoot(rootPath: string): Promise<string | undefined> {
    if (!isAbsolutePosixPath(rootPath)) return undefined;
    try {
      const canonicalRoot = await this.#source.realpath(rootPath);
      if (!(await this.#source.stat(canonicalRoot)).isDirectory) return undefined;
      // A filesystem-root binding would classify every path as contained.
      return classifyPathContainment(canonicalRoot, canonicalRoot) === "escapes-root"
        ? undefined
        : canonicalRoot;
    } catch {
      return undefined;
    }
  }

  /** Parsed JSON of one confined regular file, or undefined for any failure. */
  async #readJson(canonicalRoot: string, relativePath: string): Promise<unknown> {
    const resolved = await resolveContainedPath(
      this.#source,
      canonicalRoot,
      joinCodePath(canonicalRoot, relativePath),
    );
    if (resolved === undefined || !resolved.stat.isFile) return undefined;
    const text = await this.#readContained(resolved.canonical, resolved.stat);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Text of the one object containment proved, read from a single handle.
   *
   * Confinement proves a fact about a path, and a path can be made to mean
   * something else the moment after it is proved. So the path is opened once
   * and never resolved again: the handle refuses a symlinked final component,
   * and every fact that decides whether to read — regular file, same object,
   * within the ceiling — comes from that handle, as do the bytes. The read is
   * capped at the length the handle reported and must return exactly that, so
   * an object that grows after it was measured is refused rather than read.
   *
   * `O_NOFOLLOW` guards only the final component; the ancestor directories are
   * still the confinement sequence's `realpath` to check, which is why this is
   * only ever called on a path that sequence already resolved.
   */
  async #readContained(
    canonical: string,
    resolvedStat: CodeDirectoryStat,
  ): Promise<string | undefined> {
    let file: CodeOpenFile;
    try {
      file = await this.#source.openFile(canonical);
    } catch {
      return undefined;
    }
    try {
      const opened = await file.stat();
      if (!opened.isFile) return undefined;
      if (opened.device !== resolvedStat.device || opened.inode !== resolvedStat.inode) {
        return undefined;
      }
      if (opened.size > MAX_TEST_SOURCE_BYTES) return undefined;
      const bytes = await file.read(opened.size + 1);
      if (bytes.byteLength !== opened.size) return undefined;
      return utf8.decode(bytes);
    } catch {
      return undefined;
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  /**
   * Test-shaped scripts of the checkout root `package.json`. Only `test` and
   * `test:*` are offered: the Tests surface runs tests, and presenting `dev` or
   * `build` there would invite a user to start a long-lived process from a pane
   * that reports pass or fail.
   */
  #fromPackageScripts(
    checkoutId: string,
    packageJson: unknown,
  ): ReadonlyArray<CodeRepositoryTestDefinition> {
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) return [];
    const scripts = packageJson.scripts;
    const packageManager = packageManagerOf(packageJson);
    const definitions: CodeRepositoryTestDefinition[] = [];
    for (const script of Object.keys(scripts).sort()) {
      if (typeof scripts[script] !== "string") continue;
      if (script !== "test" && !script.startsWith("test:")) continue;
      const source = {
        kind: "package-script",
        packagePath: PACKAGE_JSON_PATH,
        packageManager,
        script,
      } as const;
      try {
        definitions.push(
          this.#definitions.fromPackageScript({
            id: deriveCodeTestDefinitionId(checkoutId, source),
            packagePath: source.packagePath,
            packageManager: source.packageManager,
            script,
            packageJson,
            cwd: ".",
            environmentRefs: [],
            timeoutMs: DEFAULT_PACKAGE_SCRIPT_TIMEOUT_MS,
            artifactPaths: [],
          }),
        );
      } catch {
        // A script name the definition contract rejects is not offered; the
        // rest of the repository's tests stay available.
      }
    }
    return definitions;
  }

  #fromOctantFile(checkoutId: string, file: unknown): ReadonlyArray<CodeRepositoryTestDefinition> {
    if (file === undefined) return [];
    let entries: ReadonlyArray<{ readonly id: string }>;
    try {
      entries = decodeCodeRepositoryTestDefinitionFile(file).tests;
    } catch {
      // An invalid definition file offers no tests; it never fails the surface.
      return [];
    }
    const definitions: CodeRepositoryTestDefinition[] = [];
    for (const entry of entries) {
      try {
        definitions.push(
          this.#definitions.fromOctantFile({
            id: deriveCodeTestDefinitionId(checkoutId, {
              kind: "octant-file",
              path: OCTANT_TESTS_PATH,
              selectedId: entry.id,
            }),
            selectedId: entry.id,
            file,
          }),
        );
      } catch {
        // As above: one unusable entry does not remove the others.
      }
    }
    return definitions;
  }
}

/**
 * Derive the stable id of one discovered definition.
 *
 * The id must survive a re-list, because the renderer keeps the user's selected
 * definition by id and the run path re-derives the same list to authorize a
 * submitted definition. A random id would break both, so the id is a pure
 * function of the checkout and the definition's source identity, formatted as a
 * UUID because that is what the contract brands. The full definition is decoded
 * by `TestDefinitionService`, which validates this id like any other field.
 */
function deriveCodeTestDefinitionId(
  checkoutId: string,
  source: CodeRepositoryTestDefinitionSource,
): CodeTestDefinitionId {
  const digest = createHash("sha256")
    .update("octant.code-test-definition.v1\0")
    .update(checkoutId)
    .update("\0")
    .update(
      source.kind === "package-script"
        ? `package-script\0${source.packagePath}\0${source.packageManager}\0${source.script}`
        : `octant-file\0${source.path}\0${source.selectedId}`,
    )
    .digest("hex")
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}` as CodeTestDefinitionId;
}

/**
 * Structural equality of two definitions.
 *
 * The run path compares a submitted definition against the ones the server
 * discovered, so this must compare every field that reaches the process — argv
 * above all — rather than the id alone.
 */
export function codeRepositoryTestDefinitionsMatch(
  left: CodeRepositoryTestDefinition,
  right: CodeRepositoryTestDefinition,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.cwd === right.cwd &&
    left.timeoutMs === right.timeoutMs &&
    sameStrings(left.argv, right.argv) &&
    sameStrings(left.environmentRefs, right.environmentRefs) &&
    sameStrings(left.artifactPaths, right.artifactPaths) &&
    sameSource(left.source, right.source)
  );
}

function sameSource(
  left: CodeRepositoryTestDefinitionSource,
  right: CodeRepositoryTestDefinitionSource,
): boolean {
  if (left.kind === "package-script") {
    return (
      right.kind === "package-script" &&
      left.packagePath === right.packagePath &&
      left.packageManager === right.packageManager &&
      left.script === right.script
    );
  }
  return (
    right.kind === "octant-file" && left.path === right.path && left.selectedId === right.selectedId
  );
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The package manager the repository declares. A checkout that names none is
 * run with `npm`, which is the manager a Node checkout always has; discovery
 * never probes for lockfiles, because it reads only the two declared files.
 */
function packageManagerOf(packageJson: Record<string, unknown>): CodeTestPackageManager {
  const declared = packageJson.packageManager;
  if (typeof declared !== "string") return "npm";
  const name = declared.split("@")[0];
  return PACKAGE_MANAGERS.find((candidate) => candidate === name) ?? "npm";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
