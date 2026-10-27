import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionSource } from "@octant/contracts/extensions";
import { localPluginSourceRefForPath } from "./agentPluginFilesystem";
import type { PluginPackageInput } from "./codexPluginResolver";
import type { ExtensionArchiveEntry } from "./packageInspector";
import { loadPluginDirectory, type PluginDirectoryFormat } from "./pluginDirectoryLoader";

/** The source kinds a folder registry may hand out: a folder the person picked, or one the host wrote for a server they added. */
export type LocalPluginFolderSourceKind = "local-folder" | "user-added";

export interface RegisteredLocalPluginFolder {
  readonly source: Extract<ExtensionSource, { readonly kind: LocalPluginFolderSourceKind }>;
  readonly absolutePath: string;
  readonly packageInput: PluginPackageInput;
  /** The layout the folder was read as. */
  readonly format: PluginDirectoryFormat;
  /** What the loader left out of another tool's plugin, in plain words. */
  readonly notes: ReadonlyArray<string>;
}

interface PersistedLocalPluginFolders {
  readonly schemaVersion: 1;
  readonly paths: ReadonlyArray<string>;
}

/**
 * Registers and materializes Agent Plugins directories from the local filesystem
 * for inspect/install through the existing local-folder source kind.
 * When `statePath` is provided, absolute paths are persisted so inspect remains
 * available after process restart without re-importing.
 */
export class LocalPluginFolderRegistry {
  readonly #folders = new Map<string, RegisteredLocalPluginFolder>();
  readonly #appVersion: string;
  readonly #platform: NodeJS.Platform;
  readonly #statePath: string | undefined;
  readonly #sourceKind: LocalPluginFolderSourceKind;

  constructor(
    options: {
      readonly appVersion?: string;
      readonly platform?: NodeJS.Platform;
      readonly statePath?: string;
      /** The source kind every folder here is registered under; local-folder unless told otherwise. */
      readonly sourceKind?: LocalPluginFolderSourceKind;
    } = {},
  ) {
    this.#appVersion = options.appVersion ?? "1.0.0";
    this.#platform = options.platform ?? process.platform;
    this.#statePath = options.statePath;
    this.#sourceKind = options.sourceKind ?? "local-folder";
  }

  get(sourceRef: string): RegisteredLocalPluginFolder | undefined {
    return this.#folders.get(sourceRef);
  }

  snapshot(): ReadonlyMap<string, PluginPackageInput> {
    return new Map(
      [...this.#folders.entries()].map(([sourceRef, folder]) => [sourceRef, folder.packageInput]),
    );
  }

  async initialize(): Promise<void> {
    if (this.#statePath === undefined) return;
    let raw: string;
    try {
      raw = await readFile(this.#statePath, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as PersistedLocalPluginFolders).schemaVersion !== 1 ||
      !Array.isArray((parsed as PersistedLocalPluginFolders).paths)
    ) {
      return;
    }
    for (const path of (parsed as PersistedLocalPluginFolders).paths) {
      if (typeof path !== "string" || path.trim() === "") continue;
      try {
        await this.register(path, { persist: false });
      } catch {
        // Stale paths after restart must not block startup.
      }
    }
  }

  async register(
    absolutePath: string,
    options: { readonly persist?: boolean } = {},
  ): Promise<RegisteredLocalPluginFolder> {
    const loaded = await loadPluginDirectory(absolutePath);
    const sourceRef = localPluginSourceRefForPath(loaded.pluginRoot);
    const source = {
      kind: this.#sourceKind,
      sourceRef,
    } as Extract<ExtensionSource, { readonly kind: LocalPluginFolderSourceKind }>;
    const entries: ExtensionArchiveEntry[] = loaded.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind === "directory" ? "directory" : "file",
      ...(entry.content === undefined ? {} : { content: entry.content }),
    }));
    const packageInput: PluginPackageInput =
      loaded.format === "language-server-package"
        ? {
            layout: "language-server-package",
            source,
            format: "directory",
            archiveBytes: loaded.archiveBytes,
            // A language server may run its one binary and nothing else, so
            // its files keep their execute permission for inspection to judge.
            entries: loaded.entries.map((entry) => ({
              path: entry.path,
              kind: entry.kind === "directory" ? "directory" : "file",
              ...(entry.content === undefined ? {} : { content: entry.content }),
              ...(entry.executable === true ? { executable: true } : {}),
            })),
            appVersion: this.#appVersion,
            platform: this.#platform,
          }
        : loaded.format === "codex-plugin"
          ? {
              source,
              format: "directory",
              archiveBytes: loaded.archiveBytes,
              manifest: loaded.codexManifest,
              entries,
              appVersion: this.#appVersion,
              platform: this.#platform,
            }
          : {
              source,
              format: "directory",
              archiveBytes: loaded.archiveBytes,
              entries,
              appVersion: this.#appVersion,
              platform: this.#platform,
            };
    const registered: RegisteredLocalPluginFolder = {
      source,
      absolutePath: loaded.pluginRoot,
      packageInput,
      format: loaded.format,
      notes: loaded.notes,
    };
    this.#folders.set(sourceRef, registered);
    if (options.persist !== false) {
      await this.#persist();
    }
    return registered;
  }

  /** Forgets a folder; the caller removes what is on disk. */
  async unregister(sourceRef: string): Promise<void> {
    if (!this.#folders.delete(sourceRef)) return;
    await this.#persist();
  }

  async #persist(): Promise<void> {
    if (this.#statePath === undefined) return;
    const payload: PersistedLocalPluginFolders = {
      schemaVersion: 1,
      paths: [...this.#folders.values()].map((folder) => folder.absolutePath),
    };
    await mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 });
    await writeFile(this.#statePath, JSON.stringify(payload), { mode: 0o600 });
  }
}
