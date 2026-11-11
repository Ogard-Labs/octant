import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  DESIGN_SYSTEM_FILE_NAME,
  MAX_DESIGN_SYSTEM_FILE_BYTES,
  MAX_DESIGN_SYSTEM_SEARCH_DEPTH,
  MAX_DESIGN_SYSTEMS_PER_PROJECT,
  type DesignSystemChoice,
  type DesignSystemDocument,
  type DesignSystemList,
  type DesignSystemListing,
  type DesignSystemLocation,
  type DesignSystemReading,
  type DesignSystemWriteResult,
} from "@octant/contracts/design-systems";
import {
  designSystemFallbackName,
  primaryDesignSystem,
  readDesignSystem,
  splitDesignSystemFrontMatter,
} from "@octant/domain/design-system-policy";
import { projectExtraFolderRoots } from "@octant/domain/project-policy";
import {
  liveWorkProjectStatusFilesystem,
  type WorkProjectStatusFilesystem,
} from "../work/workProjectStatusFiles";

export interface DesignSystemFilesystem extends WorkProjectStatusFilesystem {
  /** Entries of a directory; a symlink is reported as neither file nor directory. */
  readonly readdir: (path: string) => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly isFile: boolean;
      readonly isDirectory: boolean;
    }>
  >;
}

export const liveDesignSystemFilesystem: DesignSystemFilesystem = {
  ...liveWorkProjectStatusFilesystem,
  readdir: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    })),
};

/** The folders a Project lends: the main folder first, then its extra folders. */
export interface DesignSystemFolders {
  readonly main: string;
  readonly extra: ReadonlyArray<string>;
  /** Names the system when nothing in a top-level file does. */
  readonly projectName: string;
  /** The person's choice, when they made one; absent follows the automatic rule. */
  readonly choice?: DesignSystemChoice;
}

/** The folders a Work or Code Project lends; a Chat Project has none. */
export function designSystemFolders(
  project:
    | { readonly type: "chat" }
    | {
        readonly type: "work" | "code";
        readonly name: string;
        readonly binding: { readonly canonicalRoot: string };
        readonly extraFolders?: ReadonlyArray<{ readonly canonicalRoot: string }> | undefined;
        readonly designSystem?: DesignSystemChoice | undefined;
      },
): DesignSystemFolders | undefined {
  if (project.type === "chat") return undefined;
  return {
    main: project.binding.canonicalRoot,
    extra: projectExtraFolderRoots(project),
    projectName: project.name,
    ...(project.designSystem === undefined ? {} : { choice: project.designSystem }),
  };
}

// Generated, vendored, and dependency trees hold other products' design docs,
// not this Project's, and walking them costs the most.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "Pods",
  "DerivedData",
]);
/** Directories visited per folder before the search stops and says it was cut short. */
const MAX_DIRECTORIES_VISITED = 4_000;

export function designSystemRevision(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read a file's text into what the design-system surfaces show. */
export function readDesignSystemText(text: string, fallbackName: string): DesignSystemReading {
  const split = splitDesignSystemFrontMatter(text);
  let frontMatter: unknown;
  if (split.frontMatter !== undefined) {
    try {
      frontMatter = parseYaml(split.frontMatter, { maxAliasCount: 16 });
    } catch {
      frontMatter = null;
    }
  }
  return readDesignSystem({
    frontMatter,
    hasFrontMatter: split.frontMatter !== undefined,
    body: split.body,
    fallbackName,
  });
}

/**
 * The `DESIGN.md` files in a Project's folders.
 *
 * Only regular files named exactly `DESIGN.md` are touched, and nothing is
 * read or written through a symlink: the search does not descend into a
 * linked directory, a name that is a link is treated as taken, and every path
 * a caller names must resolve to the same place without any link above it.
 * The folder is the person's, so a link they planted cannot turn a save into a
 * write somewhere else. A folder the caller does not lend is refused before
 * any filesystem call.
 */
export class DesignSystemFiles {
  readonly #fs: DesignSystemFilesystem;
  /** The save in flight for each file, so saves of one file run one at a time. */
  readonly #writes = new Map<string, Promise<void>>();

  constructor(filesystem: DesignSystemFilesystem = liveDesignSystemFilesystem) {
    this.#fs = filesystem;
  }

  async list(folders: DesignSystemFolders): Promise<DesignSystemList> {
    const found: DesignSystemLocation[] = [];
    let truncated = false;
    for (const folder of [folders.main, ...folders.extra]) {
      if (found.length >= MAX_DESIGN_SYSTEMS_PER_PROJECT) {
        truncated = true;
        break;
      }
      const result = await this.#search(folder, MAX_DESIGN_SYSTEMS_PER_PROJECT - found.length);
      found.push(...result.found);
      truncated ||= result.truncated;
    }
    // A chosen file deeper than the search reaches is still the Project's.
    const choice = folders.choice;
    let choiceMissing = false;
    if (choice?.kind === "file" && lends(folders, choice.folder)) {
      const listed = found.some(
        (location) => location.folder === choice.folder && location.path === choice.path,
      );
      if (!listed) {
        if ((await this.#readText(choice)) === undefined) choiceMissing = true;
        else found.push({ folder: choice.folder, path: choice.path });
      }
    } else if (choice?.kind === "file") {
      choiceMissing = true;
    }
    const primary = primaryDesignSystem(found, folders.main, choice);
    const systems: DesignSystemListing[] = [];
    for (const location of found) {
      const text = await this.#readText(location);
      if (text === undefined) continue;
      const reading = readDesignSystemText(
        text,
        designSystemFallbackName(location.path, folders.projectName),
      );
      systems.push({
        ...location,
        name: reading.name,
        tokenCount: Object.keys(reading.brand).length,
        primary: location === primary,
      });
    }
    return {
      systems,
      truncated,
      ...(choice === undefined ? {} : { choice }),
      ...(choiceMissing ? { choiceMissing } : {}),
    };
  }

  async read(
    folders: DesignSystemFolders,
    location: DesignSystemLocation,
  ): Promise<DesignSystemDocument | undefined> {
    if (!lends(folders, location.folder)) return undefined;
    const text = await this.#readText(location);
    return text === undefined ? undefined : document(folders, location, text);
  }

  /** The Project's own design system with its text, for turns and Canvas. */
  async primary(folders: DesignSystemFolders): Promise<{
    readonly document: DesignSystemDocument | undefined;
    readonly others: ReadonlyArray<DesignSystemLocation>;
  }> {
    const listed = await this.list(folders);
    const primary = listed.systems.find((system) => system.primary);
    const others = listed.systems
      .filter((system) => !system.primary)
      .map(({ folder, path }) => ({ folder, path }));
    if (primary === undefined) return { document: undefined, others };
    return {
      document: await this.read(folders, { folder: primary.folder, path: primary.path }),
      others,
    };
  }

  async write(
    folders: DesignSystemFolders,
    location: DesignSystemLocation,
    text: string,
    baseRevision: string | undefined,
  ): Promise<DesignSystemWriteResult> {
    // Two windows saving from the same revision at once must not both pass the
    // revision check: each save of one file waits for the one before it, so
    // the second reads the first's text and is refused as stale.
    const key = `${location.folder}\u0000${location.path}`;
    const previous = this.#writes.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.#write(folders, location, text, baseRevision));
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#writes.set(key, settled);
    try {
      return await next;
    } finally {
      if (this.#writes.get(key) === settled) this.#writes.delete(key);
    }
  }

  async #write(
    folders: DesignSystemFolders,
    location: DesignSystemLocation,
    text: string,
    baseRevision: string | undefined,
  ): Promise<DesignSystemWriteResult> {
    if (Buffer.byteLength(text, "utf8") > MAX_DESIGN_SYSTEM_FILE_BYTES) {
      return { status: "refused", reason: "too-large" };
    }
    if (!lends(folders, location.folder))
      return { status: "refused", reason: "folder-unavailable" };
    const path = await this.#confinedPath(location);
    if (path === undefined) return { status: "refused", reason: "folder-unavailable" };
    const current = await this.#regularFile(path);
    if (baseRevision === undefined) {
      if (current !== "missing") return { status: "refused", reason: "exists" };
      try {
        await this.#fs.createFile(path, text);
      } catch {
        return { status: "refused", reason: "unwritable" };
      }
    } else {
      if (current === "missing") return { status: "refused", reason: "missing" };
      if (current === "taken") return { status: "refused", reason: "not-a-file" };
      const existing = await this.#readText(location);
      if (existing === undefined) return { status: "refused", reason: "not-a-file" };
      // A save names the text it was edited from, so an agent's or another
      // window's change made meanwhile is never overwritten unseen.
      if (designSystemRevision(existing) !== baseRevision) {
        return { status: "refused", reason: "stale" };
      }
      try {
        await this.#fs.replaceFile(path, text);
      } catch {
        return { status: "refused", reason: "unwritable" };
      }
    }
    return { status: "saved", document: document(folders, location, text) };
  }

  async #search(
    root: string,
    budget: number,
  ): Promise<{ readonly found: ReadonlyArray<DesignSystemLocation>; readonly truncated: boolean }> {
    try {
      if ((await this.#fs.realpath(root)) !== root) return { found: [], truncated: false };
    } catch {
      return { found: [], truncated: false };
    }
    const found: DesignSystemLocation[] = [];
    // Breadth first, so the shallow files that govern the most are found first.
    let level: ReadonlyArray<string> = [""];
    let visited = 0;
    for (let depth = 0; depth <= MAX_DESIGN_SYSTEM_SEARCH_DEPTH && level.length > 0; depth += 1) {
      const next: string[] = [];
      for (const relative of level) {
        if (visited >= MAX_DIRECTORIES_VISITED) return { found, truncated: true };
        visited += 1;
        let entries;
        try {
          entries = await this.#fs.readdir(relative === "" ? root : join(root, relative));
        } catch {
          continue;
        }
        const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of sorted) {
          const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
          if (entry.isFile && entry.name === DESIGN_SYSTEM_FILE_NAME) {
            if (found.length >= budget) return { found, truncated: true };
            found.push({ folder: root, path: child });
          } else if (
            entry.isDirectory &&
            !entry.name.startsWith(".") &&
            !SKIPPED_DIRECTORIES.has(entry.name)
          ) {
            next.push(child);
          }
        }
      }
      level = next;
    }
    return { found, truncated: false };
  }

  /** The absolute path, or undefined when the folder or any directory on the way is a link. */
  async #confinedPath(location: DesignSystemLocation): Promise<string | undefined> {
    const path = join(location.folder, location.path);
    try {
      if ((await this.#fs.realpath(location.folder)) !== location.folder) return undefined;
      const parent = dirname(path);
      if ((await this.#fs.realpath(parent)) !== parent) return undefined;
    } catch {
      return undefined;
    }
    return path;
  }

  async #regularFile(path: string): Promise<{ readonly size: number } | "missing" | "taken"> {
    try {
      const details = await this.#fs.lstat(path);
      if (details.isSymbolicLink || !details.isFile) return "taken";
      return { size: details.size };
    } catch {
      return "missing";
    }
  }

  async #readText(location: DesignSystemLocation): Promise<string | undefined> {
    const path = await this.#confinedPath(location);
    if (path === undefined) return undefined;
    const details = await this.#regularFile(path);
    if (typeof details === "string" || details.size > MAX_DESIGN_SYSTEM_FILE_BYTES)
      return undefined;
    try {
      return await this.#fs.readFile(path);
    } catch {
      return undefined;
    }
  }
}

function lends(folders: DesignSystemFolders, folder: string): boolean {
  return folder === folders.main || folders.extra.includes(folder);
}

function document(
  folders: DesignSystemFolders,
  location: DesignSystemLocation,
  text: string,
): DesignSystemDocument {
  return {
    folder: location.folder,
    path: location.path,
    text,
    revision: designSystemRevision(text),
    reading: readDesignSystemText(
      text,
      designSystemFallbackName(location.path, folders.projectName),
    ),
  };
}
