import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type {
  ExtensionContentDigest,
  ExtensionDiagnostic,
  ExtensionEffectiveState,
  ExtensionSource,
  ExtensionSourceReference,
  StandaloneSkillProjectScope,
  StandaloneSkillRecord,
  StandaloneSkillScope,
} from "@octant/contracts/extensions";
import { sourceQualifiedSkillId, buildSkillCatalog, type SkillCatalog } from "@octant/plugin-host";

const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;
const skillNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
/**
 * The closed list of skill folders read in a Project's ancestry. A
 * `.claude/skills` folder inside the home folder's own `.claude` is never one
 * of them: that is a runtime's user-global folder, not a Project's.
 */
export const PROJECT_SKILL_ROOTS = [
  { segments: [".agents", "skills"] as const, sourcePrefix: "", userFolder: undefined },
  { segments: [".claude", "skills"] as const, sourcePrefix: "claude:", userFolder: ".claude" },
] as const;

export interface SkillDiscoveryRootSet {
  readonly workingDirectory: string;
  readonly projectRoot: string;
  readonly projectRef: string;
  readonly userGlobalSkillsRoot: string;
  /** The thread whose working directory this is; skills below the Project root belong to it. */
  readonly scope?: StandaloneSkillScope;
  /**
   * The Project whose root this is; skills at the root belong to it. Only the
   * host's Project-less fallback root leaves it out, and its root skills are
   * then shared like the user-global directory.
   */
  readonly projectScope?: StandaloneSkillProjectScope;
}

/** Where a discovered record belongs: one thread, one Project, or everywhere. */
type DiscoveredSkillScope =
  | { readonly scope: StandaloneSkillScope }
  | { readonly projectScope: StandaloneSkillProjectScope }
  | Record<string, never>;

export interface SkillDiscoveryRootProvider {
  resolve(): Promise<ReadonlyArray<SkillDiscoveryRootSet>>;
}

export interface SkillDiscoveryServiceOptions {
  readonly roots: SkillDiscoveryRootProvider;
  readonly maximumContentBytes?: number;
  /** The person's home folder; defaults to the host's. */
  readonly homeDirectory?: string;
}

export class SkillDiscoveryService {
  readonly #roots: SkillDiscoveryRootProvider;
  readonly #maximumContentBytes: number;
  readonly #homeDirectory: string;
  #catalog: SkillCatalog = { skills: [], collisions: [] };
  #watchers: FSWatcher[] = [];
  #reconcileTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SkillDiscoveryServiceOptions) {
    this.#roots = options.roots;
    this.#maximumContentBytes = options.maximumContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
    this.#homeDirectory = options.homeDirectory ?? homedir();
  }

  snapshot(): SkillCatalog {
    return this.#catalog;
  }

  async reconcile(): Promise<SkillCatalog> {
    const records: Array<StandaloneSkillRecord> = [];
    const seenGlobalRoots = new Set<string>();
    for (const roots of await this.#roots.resolve()) {
      records.push(...(await this.#discoverProjectRoots(roots)));
      if (!seenGlobalRoots.has(resolve(roots.userGlobalSkillsRoot))) {
        seenGlobalRoots.add(resolve(roots.userGlobalSkillsRoot));
        records.push(...(await this.#discoverUserGlobal(roots)));
      }
    }
    const uniqueRecords = new Map(
      records.map((record) => [String(record.skill.qualifiedId), record] as const),
    );
    this.#catalog = buildSkillCatalog([...uniqueRecords.values()]);
    return this.#catalog;
  }

  async startWatching(): Promise<void> {
    this.stopWatching();
    const seen = new Set<string>();
    for (const roots of await this.#roots.resolve()) {
      const boundRoot = await canonicalDirectory(roots.projectRoot);
      const workingDirectory = await canonicalDirectory(roots.workingDirectory);
      if (
        boundRoot !== undefined &&
        workingDirectory !== undefined &&
        isWithin(boundRoot, workingDirectory)
      ) {
        const userFolders = await this.#userFolders();
        let current = workingDirectory;
        while (true) {
          for (const rootEntry of PROJECT_SKILL_ROOTS) {
            if (insideUserFolder(current, rootEntry.userFolder, userFolders)) continue;
            await this.#watchDirectory(join(current, ...rootEntry.segments), seen, boundRoot);
          }
          if (current === boundRoot) break;
          const parent = dirname(current);
          if (parent === current || !isWithin(boundRoot, parent)) break;
          current = parent;
        }
      }
      await this.#watchDirectory(roots.userGlobalSkillsRoot, seen);
    }
  }

  stopWatching(): void {
    for (const watcher of this.#watchers.splice(0)) watcher.close();
    if (this.#reconcileTimer !== undefined) {
      clearTimeout(this.#reconcileTimer);
      this.#reconcileTimer = undefined;
    }
  }

  async #watchDirectory(path: string, seen: Set<string>, allowedRoot?: string): Promise<void> {
    const canonical = await canonicalDirectory(path);
    if (
      canonical === undefined ||
      (allowedRoot !== undefined && !isWithin(allowedRoot, canonical)) ||
      seen.has(canonical)
    )
      return;
    seen.add(canonical);
    try {
      const watcher = watch(canonical, { persistent: false }, () => {
        if (this.#reconcileTimer !== undefined) return;
        this.#reconcileTimer = setTimeout(() => {
          this.#reconcileTimer = undefined;
          void this.reconcile().catch(() => undefined);
        }, 50);
      });
      watcher.on("error", () => watcher.close());
      this.#watchers.push(watcher);
    } catch {
      // Watchers are best-effort; startup reconciliation remains authoritative.
    }
  }

  async #discoverProjectRoots(
    roots: SkillDiscoveryRootSet,
  ): Promise<ReadonlyArray<StandaloneSkillRecord>> {
    const boundRoot = await canonicalDirectory(roots.projectRoot);
    const workingDirectory = await canonicalDirectory(roots.workingDirectory);
    if (
      boundRoot === undefined ||
      workingDirectory === undefined ||
      !isWithin(boundRoot, workingDirectory)
    ) {
      return [];
    }

    const records: Array<StandaloneSkillRecord> = [];
    const userFolders = await this.#userFolders();
    let current = workingDirectory;
    let depth = 0;
    while (true) {
      const position = depth === 0 ? "working" : `parent-${depth}`;
      for (const rootEntry of PROJECT_SKILL_ROOTS) {
        // The host's fallback root is its own working directory, which can be
        // the home folder; its `.claude` must still never be read.
        if (insideUserFolder(current, rootEntry.userFolder, userFolders)) continue;
        records.push(
          ...(await this.#scanSkillsDirectory(
            join(current, ...rootEntry.segments),
            current === boundRoot
              ? `project:${roots.projectRef}:${rootEntry.sourcePrefix}root`
              : roots.scope === undefined
                ? `project:${roots.projectRef}:${rootEntry.sourcePrefix}${position}`
                : `project:${roots.projectRef}:thread:${roots.scope.threadRef}:${rootEntry.sourcePrefix}${position}`,
            boundRoot,
            current === boundRoot
              ? roots.projectScope === undefined
                ? {}
                : { projectScope: roots.projectScope }
              : roots.scope === undefined
                ? {}
                : { scope: roots.scope },
          )),
        );
      }
      if (current === boundRoot) break;
      const parent = dirname(current);
      if (parent === current || !isWithin(boundRoot, parent)) break;
      current = parent;
      depth += 1;
    }
    return records;
  }

  /** The home folder as written and as resolved, so a linked home still matches. */
  async #userFolders(): Promise<ReadonlyArray<string>> {
    const written = resolve(this.#homeDirectory);
    try {
      const resolved = await realpath(written);
      return resolved === written ? [written] : [written, resolved];
    } catch {
      return [written];
    }
  }

  async #discoverUserGlobal(
    roots: SkillDiscoveryRootSet,
  ): Promise<ReadonlyArray<StandaloneSkillRecord>> {
    return this.#scanSkillsDirectory(roots.userGlobalSkillsRoot, "user-global", undefined, {});
  }

  async #scanSkillsDirectory(
    skillsRoot: string,
    sourceRef: string,
    allowedRoot: string | undefined,
    scope: DiscoveredSkillScope,
  ): Promise<ReadonlyArray<StandaloneSkillRecord>> {
    const root = await canonicalDirectory(skillsRoot);
    if (root === undefined || (allowedRoot !== undefined && !isWithin(allowedRoot, root)))
      return [];
    let entries: ReadonlyArray<import("node:fs").Dirent>;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const records: Array<StandaloneSkillRecord> = [];
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const packagePath = join(root, entry.name);
      const source = agentsSource(sourceRef);
      if (!skillNamePattern.test(entry.name)) {
        records.push(
          this.#invalidRecord(entry.name, source, "invalid-skill-name", 0, undefined, scope),
        );
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        records.push(
          this.#invalidRecord(entry.name, source, "symlink-package", 0, undefined, scope),
        );
        continue;
      }
      records.push(await this.#readPackage(packagePath, entry.name, source, root, scope));
    }
    return records;
  }

  async #readPackage(
    packagePath: string,
    name: string,
    source: ExtensionSource,
    root: string,
    scope: DiscoveredSkillScope,
  ): Promise<StandaloneSkillRecord> {
    const emptyDigest = digest(new Uint8Array());
    const skillPath = join(packagePath, "SKILL.md");
    try {
      const packageRealPath = await realpath(packagePath);
      if (!isWithin(root, packageRealPath)) {
        return this.#invalidRecord(name, source, "path-escape", 0, undefined, scope);
      }
      const skillStat = await lstat(skillPath);
      if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
        return this.#invalidRecord(name, source, "invalid-skill-file", 0, undefined, scope);
      }
      const content = await readFile(skillPath);
      if (content.byteLength > this.#maximumContentBytes) {
        return this.#invalidRecord(
          name,
          source,
          "content-oversize",
          content.byteLength,
          emptyDigest,
          scope,
        );
      }
      const skillRealPath = await realpath(skillPath);
      if (!isWithin(packageRealPath, skillRealPath)) {
        return this.#invalidRecord(
          name,
          source,
          "path-escape",
          content.byteLength,
          emptyDigest,
          scope,
        );
      }
      const contentDigest = digest(content);
      const diagnostic = validateSkillContent(content);
      const instructions = diagnostic === undefined ? new TextDecoder().decode(content) : undefined;
      return this.#record({
        name,
        source,
        digest: contentDigest,
        contentBytes: content.byteLength,
        ...(instructions === undefined ? {} : { instructions }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
        ...scope,
      });
    } catch {
      return this.#invalidRecord(name, source, "unreadable-skill", 0, emptyDigest, scope);
    }
  }

  #invalidRecord(
    name: string,
    source: ExtensionSource,
    code: ExtensionDiagnostic["code"],
    contentBytes = 0,
    contentDigest = digest(new Uint8Array()),
    scope: DiscoveredSkillScope = {},
  ): StandaloneSkillRecord {
    return this.#record({
      name: skillNamePattern.test(name) ? name : "invalid-skill",
      source,
      digest: contentDigest,
      contentBytes,
      diagnostic: { code, message: "Skill package is unavailable for context." },
      ...scope,
    });
  }

  #record(input: {
    readonly name: string;
    readonly source: ExtensionSource;
    readonly digest: ExtensionContentDigest;
    readonly contentBytes: number;
    readonly instructions?: string;
    readonly diagnostic?: ExtensionDiagnostic;
    readonly scope?: StandaloneSkillScope;
    readonly projectScope?: StandaloneSkillProjectScope;
  }): StandaloneSkillRecord {
    const skill = {
      qualifiedId: sourceQualifiedSkillId(input.source, input.name, input.digest),
      name: input.name,
      sourceKind: input.source.kind,
      digest: input.digest,
      available: input.diagnostic === undefined,
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
    };
    const effectiveState: ExtensionEffectiveState = {
      kind: "blocked",
      reason: "review-required",
    };
    return {
      skill,
      source: input.source,
      displayName: input.name,
      provenance: { reviewed: false },
      contentBytes: input.contentBytes,
      reviewed: false,
      desiredEnabled: false,
      effectiveState,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.projectScope === undefined ? {} : { projectScope: input.projectScope }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    };
  }
}

function agentsSource(sourceRef: string): ExtensionSource {
  return {
    kind: "agents-skills-directory",
    sourceRef: sourceRef as ExtensionSourceReference,
  };
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const resolved = resolve(path);
    if ((await lstat(resolved)).isSymbolicLink()) return undefined;
    const canonical = await realpath(resolved);
    return (await lstat(canonical)).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Is `<directory>/<userFolder>` the home folder's own folder, or inside it? */
function insideUserFolder(
  directory: string,
  userFolder: string | undefined,
  homeFolders: ReadonlyArray<string>,
): boolean {
  if (userFolder === undefined) return false;
  return homeFolders.some((home) => isWithin(join(home, userFolder), join(directory, userFolder)));
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${"/"}`));
}

function digest(content: Uint8Array): ExtensionContentDigest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}` as ExtensionContentDigest;
}

function validateSkillContent(content: Uint8Array): ExtensionDiagnostic | undefined {
  if (content.includes(0)) {
    return { code: "invalid-content", message: "Skill package is unavailable for context." };
  }
  const text = new TextDecoder().decode(content);
  if (!text.startsWith("---\n")) return undefined;
  const closing = text.indexOf("\n---", 4);
  if (closing < 0) {
    return { code: "invalid-frontmatter", message: "Skill package is unavailable for context." };
  }
  for (const line of text.slice(4, closing).split("\n")) {
    if (line.trim() !== "" && !/^[A-Za-z][A-Za-z0-9_-]*\s*:\s*\S.*$/.test(line)) {
      return { code: "invalid-frontmatter", message: "Skill package is unavailable for context." };
    }
  }
  return undefined;
}
