import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,255}$/;
const INCOMING_DIRECTORY = ".octant-incoming";
const QUARANTINE_DIRECTORY = ".octant-quarantine";
const DIGEST_NAMESPACE = "octant.github-clone-destination.v1\0";

interface InventoryEntryStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

export interface ManagedInventoryDependencies {
  readonly lstat: (path: string) => Promise<InventoryEntryStat>;
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly realpath: (path: string) => Promise<string>;
  readonly mkdir: (path: string) => Promise<unknown>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly isMissingError: (error: unknown) => boolean;
}

const liveDependencies: ManagedInventoryDependencies = {
  lstat,
  readdir,
  realpath,
  mkdir: (path) => mkdir(path),
  rename,
  isMissingError: (error) =>
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT",
};

export type ManagedInventoryRefusalCode =
  | "path-confinement"
  | "case-fold-collision"
  | "destination-collision"
  | "inventory-unavailable";

export type ManagedInventoryDerivation =
  | {
      readonly status: "derived";
      readonly inventoryPath: string;
      readonly destinationPath: string;
      readonly digest: string;
    }
  | { readonly status: "refused"; readonly code: ManagedInventoryRefusalCode }
  | { readonly status: "unavailable" };

export type ManagedDestinationShape =
  | { readonly exists: false }
  | { readonly exists: true; readonly kind: "symlink" | "file" | "other" }
  | { readonly exists: true; readonly kind: "directory"; readonly empty: boolean };

export type ManagedStagingResult =
  | { readonly status: "staged"; readonly stagingPath: string }
  | { readonly status: "refused"; readonly code: ManagedInventoryRefusalCode }
  | { readonly status: "unavailable" };

export type ManagedPromotionResult =
  | { readonly status: "promoted"; readonly canonicalDestination: string }
  | { readonly status: "refused"; readonly code: ManagedInventoryRefusalCode }
  | { readonly status: "unavailable" };

export type ManagedQuarantineResult =
  | { readonly status: "quarantined"; readonly quarantinePath: string }
  | { readonly status: "clean" }
  | { readonly status: "unavailable" };

/**
 * The host's managed repository inventory. All destinations are derived from
 * strict identity segments beneath one configured root; every existing path
 * component is checked to be a real, non-symlinked directory without a
 * case-folded sibling before it may participate in a clone, promotion, or
 * quarantine. Nothing here overwrites, empties, or deletes existing content.
 */
export class ManagedRepositoryInventory {
  readonly #inventoryPath: string;
  readonly #dependencies: ManagedInventoryDependencies;

  constructor(options: {
    readonly inventoryPath: string;
    readonly dependencies?: ManagedInventoryDependencies;
  }) {
    this.#inventoryPath = options.inventoryPath;
    this.#dependencies = options.dependencies ?? liveDependencies;
  }

  get inventoryPath(): string {
    return this.#inventoryPath;
  }

  async deriveDestination(segments: readonly string[]): Promise<ManagedInventoryDerivation> {
    const base = await this.#canonicalInventory();
    if (typeof base !== "string") return base;
    if (segments.length === 0 || segments.some((segment) => !SEGMENT_PATTERN.test(segment))) {
      return { status: "refused", code: "path-confinement" };
    }
    const walked = await this.#walkExistingComponents(base, segments);
    if (walked !== undefined) return walked;
    const destinationPath = join(base, ...segments);
    return {
      status: "derived",
      inventoryPath: base,
      destinationPath,
      digest: createHash("sha256").update(DIGEST_NAMESPACE).update(destinationPath).digest("hex"),
    };
  }

  async observeDestination(destinationPath: string): Promise<ManagedDestinationShape> {
    let details: InventoryEntryStat;
    try {
      details = await this.#dependencies.lstat(destinationPath);
    } catch (error) {
      if (this.#dependencies.isMissingError(error)) return { exists: false };
      throw error;
    }
    if (details.isSymbolicLink()) return { exists: true, kind: "symlink" };
    if (details.isFile()) return { exists: true, kind: "file" };
    if (!details.isDirectory()) return { exists: true, kind: "other" };
    const entries = await this.#dependencies.readdir(destinationPath);
    return { exists: true, kind: "directory", empty: entries.length === 0 };
  }

  stagingPath(requestId: string): string | undefined {
    if (!REQUEST_ID_PATTERN.test(requestId)) return undefined;
    return join(this.#inventoryPath, INCOMING_DIRECTORY, requestId);
  }

  async stagingExists(requestId: string): Promise<boolean> {
    const path = this.stagingPath(requestId);
    if (path === undefined) return false;
    try {
      await this.#dependencies.lstat(path);
      return true;
    } catch (error) {
      if (this.#dependencies.isMissingError(error)) return false;
      throw error;
    }
  }

  async ensureStaging(requestId: string): Promise<ManagedStagingResult> {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return { status: "refused", code: "path-confinement" };
    }
    try {
      const created = await this.#ensureOwnedDirectory(
        join(this.#inventoryPath, INCOMING_DIRECTORY),
      );
      if (created !== undefined) return created;
      const stagingPath = join(this.#inventoryPath, INCOMING_DIRECTORY, requestId);
      if (await this.#exists(stagingPath)) {
        return { status: "refused", code: "destination-collision" };
      }
      const staging = await this.#ensureOwnedDirectory(stagingPath);
      if (staging !== undefined) return staging;
      return { status: "staged", stagingPath };
    } catch {
      return { status: "unavailable" };
    }
  }

  /**
   * Atomically rename a confined staging directory onto the derived
   * destination. Parent components are re-checked immediately before the
   * rename so a symlink or case-fold replacement race is refused instead of
   * followed; an existing destination is never overwritten.
   */
  async promote(stagingPath: string, destinationPath: string): Promise<ManagedPromotionResult> {
    try {
      const base = await this.#canonicalInventory();
      if (typeof base !== "string") return base;
      const canonicalStaging = await this.#confinedRealpath(stagingPath, base);
      if (canonicalStaging === undefined) {
        return { status: "refused", code: "path-confinement" };
      }
      if (!this.#isWithin(destinationPath, base)) {
        return { status: "refused", code: "path-confinement" };
      }
      if (await this.#exists(destinationPath)) {
        return { status: "refused", code: "destination-collision" };
      }
      const relative = destinationPath.slice(base.length + 1).split(sep);
      const walked = await this.#walkExistingComponents(base, relative.slice(0, -1), {
        requireReal: true,
      });
      if (walked !== undefined) return walked;
      let parent = base;
      for (const segment of relative.slice(0, -1)) {
        parent = join(parent, segment);
        const created = await this.#ensureOwnedDirectory(parent);
        if (created !== undefined) return created;
      }
      try {
        await this.#dependencies.rename(canonicalStaging, destinationPath);
      } catch (error) {
        if (this.#dependencies.isMissingError(error)) return { status: "unavailable" };
        return { status: "refused", code: "destination-collision" };
      }
      const canonicalDestination = await this.#confinedRealpath(destinationPath, base);
      if (canonicalDestination === undefined) {
        return { status: "refused", code: "path-confinement" };
      }
      return { status: "promoted", canonicalDestination };
    } catch {
      return { status: "unavailable" };
    }
  }

  /** Move a leftover staging directory aside without deleting any content. */
  async quarantine(requestId: string): Promise<ManagedQuarantineResult> {
    const stagingPath = this.stagingPath(requestId);
    if (stagingPath === undefined) return { status: "clean" };
    try {
      if (!(await this.#exists(stagingPath))) return { status: "clean" };
      const quarantineRoot = join(this.#inventoryPath, QUARANTINE_DIRECTORY);
      const created = await this.#ensureOwnedDirectory(quarantineRoot);
      if (created !== undefined) return { status: "unavailable" };
      for (let ordinal = 0; ordinal < 100; ordinal += 1) {
        const quarantinePath = join(
          quarantineRoot,
          ordinal === 0 ? requestId : `${requestId}-${ordinal}`,
        );
        if (await this.#exists(quarantinePath)) continue;
        await this.#dependencies.rename(stagingPath, quarantinePath);
        return { status: "quarantined", quarantinePath };
      }
      return { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }
  }

  /** True when the path realpath-resolves to a location beneath the inventory. */
  async isConfined(path: string): Promise<boolean> {
    const base = await this.#canonicalInventory();
    if (typeof base !== "string") return false;
    return (await this.#confinedRealpath(path, base)) !== undefined;
  }

  async #canonicalInventory(): Promise<
    string | Extract<ManagedInventoryDerivation, { status: "refused" | "unavailable" }>
  > {
    if (!isAbsolute(this.#inventoryPath) || this.#hasTraversal(this.#inventoryPath)) {
      return { status: "refused", code: "inventory-unavailable" };
    }
    let details: InventoryEntryStat;
    try {
      details = await this.#dependencies.lstat(this.#inventoryPath);
    } catch (error) {
      if (this.#dependencies.isMissingError(error)) return this.#inventoryPath;
      return { status: "unavailable" };
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      return { status: "refused", code: "path-confinement" };
    }
    return this.#inventoryPath;
  }

  /**
   * Component-by-component confinement walk. Every existing component must be
   * a real, non-symlinked directory whose parent holds no case-folded sibling.
   */
  async #walkExistingComponents(
    base: string,
    segments: readonly string[],
    options: { readonly requireReal?: boolean } = {},
  ): Promise<
    Extract<ManagedInventoryDerivation, { status: "refused" | "unavailable" }> | undefined
  > {
    let parent = base;
    for (const segment of segments) {
      const candidate = join(parent, segment);
      let siblings: readonly string[];
      try {
        siblings = await this.#dependencies.readdir(parent);
      } catch (error) {
        if (this.#dependencies.isMissingError(error)) return undefined;
        return { status: "unavailable" };
      }
      const folded = siblings.filter(
        (entry) => entry.toLowerCase() === segment.toLowerCase() && entry !== segment,
      );
      if (folded.length > 0) return { status: "refused", code: "case-fold-collision" };
      let details: InventoryEntryStat;
      try {
        details = await this.#dependencies.lstat(candidate);
      } catch (error) {
        if (this.#dependencies.isMissingError(error)) return undefined;
        return { status: "unavailable" };
      }
      if (details.isSymbolicLink() || !details.isDirectory()) {
        return { status: "refused", code: "path-confinement" };
      }
      if (options.requireReal === true) {
        const canonical = await this.#confinedRealpath(candidate, base);
        if (canonical !== candidate) return { status: "refused", code: "path-confinement" };
      }
      parent = candidate;
    }
    return undefined;
  }

  async #ensureOwnedDirectory(
    path: string,
  ): Promise<Extract<ManagedStagingResult, { status: "refused" | "unavailable" }> | undefined> {
    try {
      await this.#dependencies.mkdir(path);
    } catch (error) {
      if (this.#dependencies.isMissingError(error)) {
        const created = await this.#ensureOwnedDirectory(dirname(path));
        if (created !== undefined) return created;
        return this.#ensureOwnedDirectory(path);
      }
      // An existing directory is acceptable; anything else is verified below.
    }
    let details: InventoryEntryStat;
    try {
      details = await this.#dependencies.lstat(path);
    } catch {
      return { status: "unavailable" };
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      return { status: "refused", code: "path-confinement" };
    }
    return undefined;
  }

  async #confinedRealpath(path: string, base: string): Promise<string | undefined> {
    let canonical: string;
    try {
      canonical = await this.#dependencies.realpath(path);
    } catch {
      return undefined;
    }
    let canonicalBase: string;
    try {
      canonicalBase = await this.#dependencies.realpath(base);
    } catch {
      return undefined;
    }
    return this.#isWithin(canonical, canonicalBase) ? canonical : undefined;
  }

  #isWithin(path: string, base: string): boolean {
    return path.startsWith(`${base}${sep}`);
  }

  #hasTraversal(path: string): boolean {
    return path.split(sep).some((segment) => segment === "." || segment === "..");
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await this.#dependencies.lstat(path);
      return true;
    } catch (error) {
      if (this.#dependencies.isMissingError(error)) return false;
      throw error;
    }
  }
}
