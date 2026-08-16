import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionSource } from "@octant/contracts/extensions";
import { loadAgentPluginDirectory, localPluginSourceRefForPath } from "./agentPluginFilesystem";
import type { AgentPluginPackageInput } from "./agentPluginIngestion";
import type { ExtensionArchiveEntry } from "./packageInspector";

export interface RegisteredLocalPluginFolder {
  readonly source: Extract<ExtensionSource, { readonly kind: "local-folder" }>;
  readonly absolutePath: string;
  readonly packageInput: AgentPluginPackageInput;
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

  constructor(
    options: {
      readonly appVersion?: string;
      readonly platform?: NodeJS.Platform;
      readonly statePath?: string;
    } = {},
  ) {
    this.#appVersion = options.appVersion ?? "1.0.0";
    this.#platform = options.platform ?? process.platform;
    this.#statePath = options.statePath;
  }

  get(sourceRef: string): RegisteredLocalPluginFolder | undefined {
    return this.#folders.get(sourceRef);
  }

  snapshot(): ReadonlyMap<string, AgentPluginPackageInput> {
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
    const loaded = await loadAgentPluginDirectory(absolutePath);
    const sourceRef = localPluginSourceRefForPath(loaded.pluginRoot);
    const source = {
      kind: "local-folder",
      sourceRef,
    } as Extract<ExtensionSource, { readonly kind: "local-folder" }>;
    const entries: ExtensionArchiveEntry[] = loaded.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind === "directory" ? "directory" : "file",
      ...(entry.content === undefined ? {} : { content: entry.content }),
    }));
    const packageInput: AgentPluginPackageInput = {
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
    };
    this.#folders.set(sourceRef, registered);
    if (options.persist !== false) {
      await this.#persist();
    }
    return registered;
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
