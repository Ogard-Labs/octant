import type { ExtensionCatalogEntry, ExtensionCommand } from "@octant/contracts/extension-rpc";
import type { ExtensionSource } from "@octant/contracts/extensions";
import { isAgentPluginsManifest } from "@octant/plugin-host/agent-plugins";
import {
  agentPluginExtensionId,
  agentPluginPackageId,
  normalizeAgentPluginPackage,
  type AgentPluginPackageInput,
} from "./agentPluginIngestion";
import {
  codexPluginExtensionId,
  codexPluginPackageId,
  normalizeCodexPluginPackage,
  type CodexPluginPackageInput,
} from "./codexPluginIngestion";
import type { ExtensionPackageResolverPort } from "./extensionApiService";
import type { ExtensionArchiveEntry, ResolvedExtensionPackage } from "./packageInspector";
import {
  fetchPinnedUpstreamPackage,
  type PinnedUpstreamFetchInput,
} from "./pinnedUpstreamPackageFetcher";
import type { CuratedBuildIosAppsCatalogSource } from "./curatedBuildIosAppsCatalog";

export type PluginPackageInput = CodexPluginPackageInput | AgentPluginPackageInput;

export interface CodexPluginLocalFolderSource {
  readonly source: Extract<ExtensionSource, { readonly kind: "local-folder" }>;
  readonly package: PluginPackageInput;
}

export interface CodexPluginPackageResolverOptions {
  readonly catalog?: ReadonlyArray<CuratedBuildIosAppsCatalogSource>;
  readonly localFolders?: ReadonlyMap<string, PluginPackageInput>;
  /** Resolves registered local Agent Plugins folders from disk-backed registry. */
  readonly localFolderRegistry?: {
    get(sourceRef: string): { readonly packageInput: PluginPackageInput } | undefined;
  };
  readonly fetch?: PinnedUpstreamFetchInput["fetch"];
  readonly appVersion?: string;
  readonly platform?: NodeJS.Platform;
}

export class CodexPluginPackageResolver implements ExtensionPackageResolverPort {
  readonly #catalog: ReadonlyArray<CuratedBuildIosAppsCatalogSource>;
  readonly #localFolders: ReadonlyMap<string, PluginPackageInput>;
  readonly #localFolderRegistry:
    | { get(sourceRef: string): { readonly packageInput: PluginPackageInput } | undefined }
    | undefined;
  readonly #fetch: PinnedUpstreamFetchInput["fetch"];
  readonly #appVersion: string;
  readonly #platform: NodeJS.Platform;

  constructor(options: CodexPluginPackageResolverOptions = {}) {
    this.#catalog = options.catalog ?? [];
    this.#localFolders = options.localFolders ?? new Map();
    this.#localFolderRegistry = options.localFolderRegistry;
    this.#fetch = options.fetch;
    this.#appVersion = options.appVersion ?? "1.0.0";
    this.#platform = options.platform ?? process.platform;
  }

  async resolve(
    command: Extract<ExtensionCommand, { readonly kind: "inspect-package" }>,
    signal?: AbortSignal,
  ): Promise<ResolvedExtensionPackage> {
    const input = await this.#resolveInput(command.source, signal);
    if (command.source.kind === "catalog") {
      if (command.expectedDigest !== undefined && command.expectedDigest !== input.expectedDigest) {
        throw new Error("Caller-supplied digest does not match the catalog-bound digest.");
      }
      return normalizePluginPackage(input);
    }
    return normalizePluginPackage({
      ...input,
      expectedDigest: command.expectedDigest ?? input.expectedDigest,
    });
  }

  searchCatalog(command: Extract<ExtensionCommand, { readonly kind: "search-catalog" }>): {
    readonly entries: ReadonlyArray<ExtensionCatalogEntry>;
    readonly nextCursor?: string;
  } {
    const query = command.query.toLocaleLowerCase("en-US");
    const entries = this.#catalog.flatMap((record) => {
      if (command.catalogId !== undefined && command.catalogId !== record.source.catalogId) {
        return [];
      }
      const { name, version, displayName } = record.displayMetadata;
      const haystack = `${name} ${displayName}`.toLocaleLowerCase("en-US");
      if (!haystack.includes(query)) return [];
      // Catalog metadata historically used Codex identity seeds. Keep that for
      // existing curated entries; Agent Plugins packages still normalize through
      // inspect/install using content-detected format.
      return [
        {
          extensionId:
            record.packageFormat === "agent-plugin"
              ? agentPluginExtensionId(record.source, name)
              : codexPluginExtensionId(name),
          packageId:
            record.packageFormat === "agent-plugin"
              ? agentPluginPackageId(record.source, name)
              : codexPluginPackageId(record.source, name),
          slug: name,
          displayName,
          version,
          digest: record.expectedDigest,
          source: record.source,
        } as ExtensionCatalogEntry,
      ];
    });
    const start = command.cursor === undefined ? 0 : Number(command.cursor);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error("Invalid catalog cursor.");
    const page = entries.slice(start, start + 50);
    return {
      entries: page,
      ...(start + page.length < entries.length ? { nextCursor: String(start + page.length) } : {}),
    };
  }

  async #resolveInput(source: ExtensionSource, signal?: AbortSignal): Promise<PluginPackageInput> {
    if (source.kind === "catalog") {
      const record = this.#catalog.find(
        (candidate) =>
          candidate.source.catalogId === source.catalogId &&
          candidate.source.entryId === source.entryId,
      );
      if (record === undefined) throw new Error("Catalog package is unavailable.");
      if (!sameSource(record.source, source)) throw new Error("Catalog package source changed.");
      if (record.curationBinding.sourceCommit !== record.upstreamReference.commit) {
        throw new Error(
          "Catalog curation binding source commit does not match the upstream reference.",
        );
      }
      const fetched = await fetchPinnedUpstreamPackage({
        reference: record.upstreamReference,
        source: record.source,
        appVersion: this.#appVersion,
        platform: this.#platform,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        ...(signal === undefined ? {} : { signal }),
      });
      return packageInputFromFetched(fetched, record, this.#appVersion, this.#platform);
    }
    if (source.kind === "local-folder") {
      const input =
        this.#localFolders.get(source.sourceRef) ??
        this.#localFolderRegistry?.get(source.sourceRef)?.packageInput;
      if (input === undefined || !sameSource(input.source, source)) {
        throw new Error("Local plugin folder is unavailable.");
      }
      return input;
    }
    throw new Error("Plugin source is unsupported.");
  }
}

function normalizePluginPackage(input: PluginPackageInput): ResolvedExtensionPackage {
  if (isAgentPluginPackageInput(input)) {
    return normalizeAgentPluginPackage(input);
  }
  return normalizeCodexPluginPackage(input);
}

function isAgentPluginPackageInput(input: PluginPackageInput): input is AgentPluginPackageInput {
  if ("manifest" in input && input.manifest !== undefined) {
    return isAgentPluginsManifest(input.manifest);
  }
  return input.entries.some((entry) => entry.path === "plugin.json");
}

function packageInputFromFetched(
  fetched: {
    readonly source: ExtensionSource;
    readonly format: ResolvedExtensionPackage["format"];
    readonly archiveBytes: number;
    readonly manifest: unknown;
    readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  },
  record: CuratedBuildIosAppsCatalogSource,
  appVersion: string,
  platform: NodeJS.Platform,
): PluginPackageInput {
  if (isAgentPluginsManifest(fetched.manifest) || hasAgentPluginsRoot(fetched.entries)) {
    return {
      source: fetched.source,
      format: fetched.format,
      archiveBytes: fetched.archiveBytes,
      entries: fetched.entries,
      expectedDigest: record.expectedDigest,
      curationBinding: record.curationBinding,
      appVersion,
      platform,
    };
  }
  return {
    source: fetched.source,
    format: fetched.format,
    archiveBytes: fetched.archiveBytes,
    manifest: fetched.manifest,
    entries: fetched.entries,
    expectedDigest: record.expectedDigest,
    curationBinding: record.curationBinding,
    appVersion,
    platform,
  };
}

function hasAgentPluginsRoot(entries: ReadonlyArray<ExtensionArchiveEntry>): boolean {
  const entry = entries.find((candidate) => candidate.path === "plugin.json");
  if (entry?.content === undefined) return false;
  try {
    return isAgentPluginsManifest(JSON.parse(new TextDecoder().decode(entry.content)));
  } catch {
    return false;
  }
}

function sameSource(left: ExtensionSource, right: ExtensionSource): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "catalog" && right.kind === "catalog") {
    return left.catalogId === right.catalogId && left.entryId === right.entryId;
  }
  return "sourceRef" in left && "sourceRef" in right && left.sourceRef === right.sourceRef;
}
