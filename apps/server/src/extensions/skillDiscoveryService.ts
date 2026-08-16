import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  ExtensionContentDigest,
  ExtensionDiagnostic,
  ExtensionEffectiveState,
  ExtensionSource,
  ExtensionSourceReference,
  StandaloneSkillRecord,
  StandaloneSkillScope,
} from "@octant/contracts/extensions";
import { sourceQualifiedSkillId, buildSkillCatalog, type SkillCatalog } from "@octant/extensions";

const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;
const skillNamePattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface SkillDiscoveryRootSet {
  readonly workingDirectory: string;
  readonly projectRoot: string;
  readonly projectRef: string;
  readonly userGlobalSkillsRoot: string;
  readonly scope?: StandaloneSkillScope;
}

export interface SkillDiscoveryRootProvider {
  resolve(): Promise<ReadonlyArray<SkillDiscoveryRootSet>>;
}

export interface SkillDiscoveryServiceOptions {
  readonly roots: SkillDiscoveryRootProvider;
  readonly maximumContentBytes?: number;
}

export class SkillDiscoveryService {
  readonly #roots: SkillDiscoveryRootProvider;
  readonly #maximumContentBytes: number;
  #catalog: SkillCatalog = { skills: [], collisions: [] };
  #watchers: FSWatcher[] = [];
  #reconcileTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SkillDiscoveryServiceOptions) {
    this.#roots = options.roots;
    this.#maximumContentBytes = options.maximumContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
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
        let current = workingDirectory;
        while (true) {
          await this.#watchDirectory(join(current, ".agents", "skills"), seen, boundRoot);
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
    let current = workingDirectory;
    let depth = 0;
    while (true) {
      records.push(
        ...(await this.#scanSkillsDirectory(
          join(current, ".agents", "skills"),
          current === boundRoot
            ? `project:${roots.projectRef}:root`
            : roots.scope === undefined
              ? `project:${roots.projectRef}:${depth === 0 ? "working" : `parent-${depth}`}`
              : `project:${roots.projectRef}:thread:${roots.scope.threadRef}:${
                  depth === 0 ? "working" : `parent-${depth}`
                }`,
          boundRoot,
          current === boundRoot ? undefined : roots.scope,
        )),
      );
      if (current === boundRoot) break;
      const parent = dirname(current);
      if (parent === current || !isWithin(boundRoot, parent)) break;
      current = parent;
      depth += 1;
    }
    return records;
  }

  async #discoverUserGlobal(
    roots: SkillDiscoveryRootSet,
  ): Promise<ReadonlyArray<StandaloneSkillRecord>> {
    return this.#scanSkillsDirectory(roots.userGlobalSkillsRoot, "user-global");
  }

  async #scanSkillsDirectory(
    skillsRoot: string,
    sourceRef: string,
    allowedRoot?: string,
    scope?: StandaloneSkillScope,
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
    scope?: StandaloneSkillScope,
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
      return this.#record({
        name,
        source,
        digest: contentDigest,
        contentBytes: content.byteLength,
        ...(diagnostic === undefined ? {} : { diagnostic }),
        ...(scope === undefined ? {} : { scope }),
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
    scope?: StandaloneSkillScope,
  ): StandaloneSkillRecord {
    return this.#record({
      name: skillNamePattern.test(name) ? name : "invalid-skill",
      source,
      digest: contentDigest,
      contentBytes,
      diagnostic: { code, message: "Skill package is unavailable for context." },
      ...(scope === undefined ? {} : { scope }),
    });
  }

  #record(input: {
    readonly name: string;
    readonly source: ExtensionSource;
    readonly digest: ExtensionContentDigest;
    readonly contentBytes: number;
    readonly diagnostic?: ExtensionDiagnostic;
    readonly scope?: StandaloneSkillScope;
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
      reason: "untrusted",
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
