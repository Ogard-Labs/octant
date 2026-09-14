import { gunzipSync } from "node:zlib";
import type { ExtensionCatalogEntry } from "@octant/contracts/extension-rpc";
import type {
  ExtensionCatalogEntryId,
  ExtensionCatalogId,
  ExtensionSource,
} from "@octant/contracts/extensions";
import { AGENT_PLUGINS_PLUGIN_SCHEMA } from "@octant/plugin-host/agent-plugins";
import { normalizeAgentPluginPackage } from "./agentPluginIngestion";
import {
  createMarketplaceFetch,
  withMarketplaceRequest,
  type MarketplaceFetch,
} from "./marketplaceRequestSignal";
import {
  DEFAULT_NPM_REGISTRY_URL,
  decodeNpmEntryIdentity,
  downloadNpmTarball,
  encodeNpmEntryId,
  fetchNpmPackageMetadata,
  parseNpmSearchObject,
  parseRegistryJson,
  verifyNpmTarballIntegrity,
} from "./npmRegistry";
import {
  inspectExtensionPackage,
  type ExtensionArchiveEntry,
  type ResolvedExtensionPackage,
} from "./packageInspector";
import { isUnsafeSkillRelativePath } from "./skillPackageBuilder";

export const NPM_AGENT_PLUGINS_CATALOG_ID = "npm-agent-plugins" as unknown as ExtensionCatalogId;

/**
 * npm's `npm pack` layout: every archive member lives under a single `package/`
 * root. Agent Plugins require `plugin.json`, `mcp.json`, and `skills/` at the
 * plugin root, so the adapter strips exactly that one segment and rejects any
 * member that is not inside it.
 */
const NPM_PACKAGE_ROOT = "package";

/** npm registry search page per keyword query. */
const DEFAULT_LIMIT = 25;
/** Bound on candidates inspected for one search before giving up. */
const MAX_CANDIDATES = 40;
/** Bound on listed entries per search. */
const MAX_RESULTS = 25;
const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024;
const MAX_PLUGIN_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TAR_ENTRIES = 4_096;
const MAX_CACHED_PACKAGES = 24;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
/** Whole-listing budget: validation fetches up to two responses per candidate. */
const SEARCH_BUDGET_MS = 60_000;

export interface NpmAgentPluginMarketplaceOptions {
  readonly fetch?: MarketplaceFetch;
  readonly registryUrl?: string;
  readonly appVersion?: string;
  readonly platform?: NodeJS.Platform;
  /** When false, no npm request leaves the host. */
  readonly isMarketplaceFetchAllowed?: () => boolean;
}

/**
 * npm registry adapter for published Agent Plugins packages.
 *
 * The Agent Plugins standard defines no registry, so discovery is the
 * publisher-adopted `agent-plugin` / `agent-plugins` keyword convention. That
 * convention is not a trust signal: only a root `plugin.json` whose `$schema`
 * is the canonical 1.0.0 URL is listed, and each candidate is fetched with
 * bounded bytes and validated at listing time so the catalog entry already
 * carries the real identity and digest. A name@version lookup is cached, so
 * preview and install reuse the exact bytes that were listed.
 */
export class NpmAgentPluginMarketplace {
  readonly catalogId = NPM_AGENT_PLUGINS_CATALOG_ID;
  readonly #fetch: MarketplaceFetch;
  readonly #registryUrl: string;
  readonly #appVersion: string;
  readonly #platform: NodeJS.Platform;
  readonly #cache = new Map<
    string,
    { readonly resolved: ResolvedExtensionPackage; readonly bytes: number }
  >();
  #cachedBytes = 0;

  constructor(options: NpmAgentPluginMarketplaceOptions = {}) {
    this.#fetch =
      options.isMarketplaceFetchAllowed === undefined
        ? (options.fetch ?? globalThis.fetch)
        : createMarketplaceFetch({
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            isAllowed: options.isMarketplaceFetchAllowed,
          });
    this.#registryUrl = options.registryUrl ?? DEFAULT_NPM_REGISTRY_URL;
    this.#appVersion = options.appVersion ?? "1.0.0";
    this.#platform = options.platform ?? process.platform;
  }

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<{ readonly entries: ReadonlyArray<ExtensionCatalogEntry> }> {
    const trimmed = query.trim();
    if (trimmed === "") return { entries: [] };
    // Bound the whole listing, not only each registry request: validation can
    // fetch two bounded responses per candidate.
    return withMarketplaceRequest(
      signal,
      async (boundedSignal) => {
        const keywordSearches = await Promise.allSettled([
          this.#searchKeyword(trimmed, "agent-plugin", boundedSignal),
          this.#searchKeyword(trimmed, "agent-plugins", boundedSignal),
        ]);
        const candidates = new Map<string, { readonly name: string; readonly version: string }>();
        let failed = 0;
        for (const result of keywordSearches) {
          if (result.status === "rejected") {
            failed += 1;
            continue;
          }
          for (const candidate of result.value) {
            if (!candidates.has(candidate.name)) candidates.set(candidate.name, candidate);
          }
        }
        if (failed === keywordSearches.length) {
          const [first] = keywordSearches;
          throw first.status === "rejected"
            ? first.reason
            : new Error("Agent Plugin search failed.");
        }
        const entries: ExtensionCatalogEntry[] = [];
        for (const candidate of [...candidates.values()].slice(0, MAX_CANDIDATES)) {
          if (entries.length >= MAX_RESULTS) break;
          try {
            const source = catalogSourceFor(candidate.name, candidate.version);
            const resolved = await this.#fetchPackage(
              candidate.name,
              candidate.version,
              boundedSignal,
            );
            entries.push(catalogEntryFor(source, inspectExtensionPackage(resolved)));
          } catch (error) {
            if (boundedSignal.aborted) throw error;
            // One package that is not a conformant, reviewable Agent Plugin is
            // skipped. The registry search itself failing already threw above.
            continue;
          }
        }
        return { entries };
      },
      SEARCH_BUDGET_MS,
    );
  }

  async resolve(source: ExtensionSource, signal?: AbortSignal): Promise<ResolvedExtensionPackage> {
    const identity = acceptNpmAgentPluginSource(source);
    if (identity === undefined) {
      throw new Error("npm Agent Plugin marketplace cannot resolve this source.");
    }
    return this.#fetchPackage(identity.packageName, identity.version, signal);
  }

  async #searchKeyword(
    query: string,
    keyword: string,
    callerSignal?: AbortSignal,
  ): Promise<ReadonlyArray<{ readonly name: string; readonly version: string }>> {
    return withMarketplaceRequest(callerSignal, async (signal) => {
      const url = new URL("/-/v1/search", this.#registryUrl);
      url.searchParams.set("text", `${query} keywords:${keyword}`);
      url.searchParams.set("size", String(DEFAULT_LIMIT));
      const response = await this.#fetch(url.toString(), {
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("npm Agent Plugin search is unavailable.");
      const body = await parseRegistryJson<{ objects?: unknown }>(response);
      const objects = Array.isArray(body.objects) ? body.objects : [];
      const candidates = new Map<string, { readonly name: string; readonly version: string }>();
      for (const object of objects) {
        const pkg = parseNpmSearchObject(object);
        if (pkg === undefined) continue;
        if (!candidates.has(pkg.name)) candidates.set(pkg.name, pkg);
      }
      return [...candidates.values()];
    });
  }

  async #fetchPackage(
    packageName: string,
    version: string,
    callerSignal?: AbortSignal,
  ): Promise<ResolvedExtensionPackage> {
    const cacheKey = `${packageName}@${version}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached.resolved;
    const source = catalogSourceFor(packageName, version);
    const resolved = await withMarketplaceRequest(callerSignal, async (signal) => {
      const metadata = await fetchNpmPackageMetadata({
        fetch: this.#fetch,
        registryUrl: this.#registryUrl,
        packageName,
        requestedVersion: version,
        signal,
      });
      if (metadata.version !== version) {
        throw new Error("npm package version changed during resolution.");
      }
      const tarball = await downloadNpmTarball({
        fetch: this.#fetch,
        registryUrl: this.#registryUrl,
        url: metadata.tarballUrl,
        signal,
      });
      verifyNpmTarballIntegrity(tarball, metadata.integrity, metadata.shasum);
      const entries = extractAgentPluginEntriesFromTarball(tarball);
      assertCanonicalPluginManifest(entries);
      return normalizeAgentPluginPackage({
        source,
        format: "tar",
        archiveBytes: tarball.byteLength,
        entries,
        appVersion: this.#appVersion,
        platform: this.#platform,
      });
    });
    // Only a package that passes the full inspector becomes a listing, so a
    // catalog entry can never lead to a preview that fails review.
    inspectExtensionPackage(resolved);
    this.#remember(cacheKey, resolved);
    return resolved;
  }

  #remember(cacheKey: string, resolved: ResolvedExtensionPackage): void {
    const bytes = resolved.entries.reduce(
      (total, entry) => total + (entry.content?.byteLength ?? 0),
      0,
    );
    if (bytes > MAX_CACHED_BYTES) return;
    const existing = this.#cache.get(cacheKey);
    if (existing !== undefined) {
      this.#cachedBytes -= existing.bytes;
      this.#cache.delete(cacheKey);
    }
    this.#cache.set(cacheKey, { resolved, bytes });
    this.#cachedBytes += bytes;
    while (this.#cache.size > MAX_CACHED_PACKAGES || this.#cachedBytes > MAX_CACHED_BYTES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.#cache.get(oldest);
      this.#cache.delete(oldest);
      this.#cachedBytes -= evicted?.bytes ?? 0;
    }
  }
}

/**
 * Accept a catalog source this marketplace owns, pinned to an exact npm
 * version. Entry ids are built from `name@version`, so preview and install
 * resolve the exact bytes the search listed instead of whatever `latest` is.
 */
export function acceptNpmAgentPluginSource(
  source: ExtensionSource,
): { readonly packageName: string; readonly version: string } | undefined {
  if (source.kind !== "catalog" || source.catalogId !== NPM_AGENT_PLUGINS_CATALOG_ID) {
    return undefined;
  }
  const identity = decodeNpmEntryIdentity(source.entryId);
  if (identity === undefined || identity.version === undefined) return undefined;
  return { packageName: identity.packageName, version: identity.version };
}

function catalogSourceFor(
  packageName: string,
  version: string,
): Extract<ExtensionSource, { readonly kind: "catalog" }> {
  return {
    kind: "catalog",
    catalogId: NPM_AGENT_PLUGINS_CATALOG_ID,
    entryId: encodeNpmEntryId(packageName, version) as unknown as ExtensionCatalogEntryId,
  };
}

function catalogEntryFor(
  source: Extract<ExtensionSource, { readonly kind: "catalog" }>,
  inspection: ReturnType<typeof inspectExtensionPackage>,
): ExtensionCatalogEntry {
  const manifest = inspection.manifest;
  return {
    extensionId: manifest.extensionId,
    packageId: manifest.packageId,
    slug: manifest.slug,
    displayName: manifest.displayName,
    version: manifest.version,
    digest: manifest.digest,
    source,
  };
}

/**
 * Require a root `plugin.json` whose `$schema` is the canonical Agent Plugins
 * 1.0.0 URL. The schema is bundled in `@octant/plugin-host`; nothing is fetched
 * at runtime, and every other manifest field is still validated by the loader.
 */
function assertCanonicalPluginManifest(entries: ReadonlyArray<ExtensionArchiveEntry>): void {
  const manifestEntry = entries.find(
    (entry) => entry.path === "plugin.json" && entry.kind === "file" && entry.content !== undefined,
  );
  if (manifestEntry?.content === undefined) {
    throw new Error("npm package does not contain a root plugin.json.");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestEntry.content));
  } catch {
    throw new Error("npm package plugin.json is not valid JSON.");
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    (manifest as { readonly $schema?: unknown }).$schema !== AGENT_PLUGINS_PLUGIN_SCHEMA
  ) {
    throw new Error("npm package plugin.json does not use the canonical Agent Plugins schema.");
  }
}

/**
 * Extract files and directories from a package tarball into plugin-relative
 * entries. Rejects unsafe paths, duplicate members, links, and every other
 * unsupported tar member before the bytes can reach the loader; decompression
 * and per-file sizes are bounded to resist gzip bombs.
 */
export function extractAgentPluginEntriesFromTarball(
  tarballBytes: Uint8Array,
): ReadonlyArray<ExtensionArchiveEntry> {
  let unzipped: Buffer;
  try {
    unzipped = gunzipSync(tarballBytes, { maxOutputLength: MAX_EXTRACTED_BYTES });
  } catch {
    throw new Error("npm package archive is invalid.");
  }
  if (unzipped.byteLength > MAX_EXTRACTED_BYTES) {
    throw new Error("npm package exceeds size limits.");
  }

  const entries: ExtensionArchiveEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  let count = 0;
  while (offset + 512 <= unzipped.byteLength) {
    const header = unzipped.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    count += 1;
    if (count > MAX_TAR_ENTRIES) throw new Error("npm package exceeds entry limits.");

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const sizeText = readTarString(header, 124, 12).replaceAll("\u0000", "").trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    const typeFlag = header[156] ?? 0;
    if (!Number.isFinite(size) || size < 0 || offset + size > unzipped.byteLength) {
      throw new Error("npm package archive is invalid.");
    }
    const content = unzipped.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    const isDirectory = typeFlag === 53 /* '5' */;
    const isFile = typeFlag === 0 || typeFlag === 48; /* '\0' | '0' */
    if (!isDirectory && !isFile) {
      // Symlinks, hardlinks, pax/GNU long-name headers, and specials are
      // refused rather than skipped: the reviewed package must be exactly the
      // stored package, and a skipped member could hide that difference.
      throw new Error("npm package contains an unsupported entry.");
    }
    const fullPath = prefix === "" ? name : `${prefix}/${name}`;
    const rootRelative = stripNpmPackageRoot(fullPath.replace(/^\.\//, ""));
    if (rootRelative === undefined) {
      throw new Error("npm package contains an unsafe path.");
    }
    if (rootRelative === "") continue;
    const path = rootRelative.replace(/\/+$/, "");
    if (isUnsafeSkillRelativePath(path)) {
      throw new Error("npm package contains an unsafe path.");
    }
    if (paths.has(path)) {
      throw new Error("npm package contains a duplicate path.");
    }
    paths.add(path);
    if (isDirectory || rootRelative.endsWith("/")) {
      entries.push({ path, kind: "directory" });
      continue;
    }
    if (content.byteLength > MAX_PLUGIN_FILE_BYTES) {
      throw new Error("npm package contains a file that exceeds size limits.");
    }
    entries.push({ path, kind: "file", content: Buffer.from(content) });
  }
  return entries;
}

function stripNpmPackageRoot(path: string): string | undefined {
  if (path === NPM_PACKAGE_ROOT) return "";
  if (!path.startsWith(`${NPM_PACKAGE_ROOT}/`)) return undefined;
  return path.slice(NPM_PACKAGE_ROOT.length + 1);
}

function readTarString(header: Uint8Array, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return Buffer.from(slice.subarray(0, end === -1 ? slice.length : end)).toString("utf8");
}
