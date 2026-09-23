import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { ExtensionSource } from "@octant/contracts/extensions";
import type { SkillMarketplaceEntry } from "@octant/contracts/extension-rpc";
import type { ResolvedExtensionPackage } from "./packageInspector";
import type { SkillMarketplacePort } from "./standaloneSkillService";
import {
  MARKETPLACE_FETCH_USER_AGENT,
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
  NPM_SKILLS_CATALOG_ID,
  buildStandaloneSkillPackage,
  isUnsafeSkillRelativePath,
  skillSearchEntry,
} from "./skillPackageBuilder";

const DEFAULT_LIMIT = 25;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_TAR_ENTRIES = 4_096;
const MAX_EXTRA_FILES_PER_SKILL = 64;

export interface NpmSkillMarketplaceOptions {
  readonly fetch?: MarketplaceFetch;
  readonly registryUrl?: string;
  readonly appVersion?: string;
  readonly platform?: NodeJS.Platform;
}

type ExtractedSkill = {
  readonly directoryName: string;
  readonly markdown: string;
  readonly extraFiles: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>;
};

/**
 * npm registry adapter for packages that ship Agent Skills (`SKILL.md`).
 * Search prefers agent-skills keywords; resolve extracts skill documents from
 * the package tarball into the shared standalone skill package model.
 */
export class NpmSkillMarketplace implements SkillMarketplacePort {
  readonly #fetch: MarketplaceFetch;
  readonly #registryUrl: string;
  readonly #appVersion: string;
  readonly #platform: NodeJS.Platform;

  constructor(options: NpmSkillMarketplaceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#registryUrl = options.registryUrl ?? DEFAULT_NPM_REGISTRY_URL;
    this.#appVersion = options.appVersion ?? "1.0.0";
    this.#platform = options.platform ?? process.platform;
  }

  async search(
    query: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly entries: ReadonlyArray<SkillMarketplaceEntry>;
    readonly nextCursor?: string;
  }> {
    return withMarketplaceRequest(signal, (boundedSignal) =>
      this.#search(query, cursor, boundedSignal),
    );
  }

  async #search(
    query: string,
    _cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    readonly entries: ReadonlyArray<SkillMarketplaceEntry>;
    readonly nextCursor?: string;
  }> {
    const trimmed = query.trim();
    if (trimmed === "") return { entries: [] };
    const url = new URL("/-/v1/search", this.#registryUrl);
    url.searchParams.set("text", `${trimmed} keywords:agent-skills`);
    url.searchParams.set("size", String(DEFAULT_LIMIT));
    const response = await this.#fetch(url.toString(), {
      headers: { accept: "application/json", "user-agent": MARKETPLACE_FETCH_USER_AGENT },
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error("npm skill search is unavailable.");
    const body = await parseRegistryJson<{ objects?: unknown }>(response);
    const objects = Array.isArray(body.objects) ? body.objects : [];
    const entries: SkillMarketplaceEntry[] = [];
    for (const object of objects) {
      const pkg = parseNpmSearchObject(object);
      if (pkg === undefined) continue;
      let entryId: string;
      try {
        entryId = encodeNpmEntryId(pkg.name, pkg.version);
      } catch {
        continue;
      }
      const source = {
        kind: "catalog" as const,
        catalogId: NPM_SKILLS_CATALOG_ID as never,
        entryId: entryId as never,
      };
      entries.push(
        skillSearchEntry({
          source,
          skillName: internalSkillToken(pkg.name),
          displayName: pkg.name,
          description: pkg.description ?? `npm · ${pkg.name}@${pkg.version}`,
          ...(pkg.publisher === undefined ? {} : { publisher: pkg.publisher }),
          canonicalUrl: `https://www.npmjs.com/package/${pkg.name}`,
          version: pkg.version,
        }),
      );
    }
    return { entries };
  }

  async resolve(source: ExtensionSource, signal?: AbortSignal): Promise<ResolvedExtensionPackage> {
    return withMarketplaceRequest(signal, (boundedSignal) => this.#resolve(source, boundedSignal));
  }

  async #resolve(source: ExtensionSource, signal: AbortSignal): Promise<ResolvedExtensionPackage> {
    if (source.kind !== "catalog" || source.catalogId !== NPM_SKILLS_CATALOG_ID) {
      throw new Error("npm skill marketplace cannot resolve this source.");
    }
    const identity = decodeNpmEntryIdentity(source.entryId);
    if (identity === undefined) {
      throw new Error("npm skill package identity is unavailable.");
    }
    const packageName = identity.packageName;
    const metadata = await fetchNpmPackageMetadata({
      fetch: this.#fetch,
      registryUrl: this.#registryUrl,
      packageName,
      ...(identity.version === undefined ? {} : { requestedVersion: identity.version }),
      signal,
    });
    const tarball = await downloadNpmTarball({
      fetch: this.#fetch,
      registryUrl: this.#registryUrl,
      url: metadata.tarballUrl,
      signal,
    });
    verifyNpmTarballIntegrity(tarball, metadata.integrity, metadata.shasum);
    const skillFiles = extractSkillMarkdownFromTarball(tarball);
    if (skillFiles.length === 0) {
      throw new Error("npm package does not contain SKILL.md files.");
    }
    return buildStandaloneSkillPackage({
      source,
      lifecycleSource: {
        kind: "catalog",
        catalogId: NPM_SKILLS_CATALOG_ID as never,
        entryId: encodeNpmEntryId(packageName) as never,
      },
      slug: internalSkillToken(packageName),
      displayName: packageName,
      version: metadata.version,
      publisher: metadata.publisher ?? packageName,
      canonicalUrl: `https://www.npmjs.com/package/${packageName}/v/${metadata.version}`,
      ...(metadata.license === undefined ? {} : { packageLicense: metadata.license }),
      skills: [skillFiles[0]!],
      appVersion: this.#appVersion,
      platform: this.#platform,
    });
  }
}

/**
 * Extract SKILL.md documents and sibling support files from a package tarball.
 * Decompression is bounded by `maxOutputLength` to resist gzip bombs.
 */
export function extractSkillMarkdownFromTarball(
  tarballBytes: Uint8Array,
): ReadonlyArray<ExtractedSkill> {
  let unzipped: Buffer;
  try {
    unzipped = gunzipSync(tarballBytes, { maxOutputLength: MAX_EXTRACTED_BYTES });
  } catch {
    throw new Error("npm package archive is invalid.");
  }
  if (unzipped.byteLength > MAX_EXTRACTED_BYTES) {
    throw new Error("npm package exceeds size limits.");
  }

  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let entries = 0;
  while (offset + 512 <= unzipped.byteLength) {
    const header = unzipped.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    entries += 1;
    if (entries > MAX_TAR_ENTRIES) throw new Error("npm package exceeds entry limits.");

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const sizeText = readTarString(header, 124, 12)
      // oxlint-disable-next-line no-control-regex -- strips NUL padding from tar header text.
      .replace(/\u0000/g, "")
      .trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    const typeFlag = header[156] ?? 0;
    if (!Number.isFinite(size) || size < 0 || offset + size > unzipped.byteLength) {
      throw new Error("npm package archive is invalid.");
    }
    const content = unzipped.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    // Regular file only (`\0` or `0`). Reject directories, links, and specials.
    if (typeFlag !== 0 && typeFlag !== 48 /* '0' */) continue;
    const fullPath = prefix === "" ? name : `${prefix}/${name}`;
    const normalized = fullPath.replace(/^\.\//, "");
    if (isUnsafeSkillRelativePath(normalized)) {
      throw new Error("npm package contains an unsafe path.");
    }
    if (content.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new Error("npm package contains a file that exceeds size limits.");
    }
    if (files.has(normalized)) {
      throw new Error("npm package contains a duplicate path.");
    }
    files.set(normalized, Buffer.from(content));
  }

  const skillMarkdownPaths = [...files.keys()].filter(
    (path) => path.endsWith("/SKILL.md") || path === "SKILL.md",
  );
  const found: ExtractedSkill[] = [];
  for (const skillPath of skillMarkdownPaths.slice(0, 32)) {
    const markdownBytes = files.get(skillPath);
    if (markdownBytes === undefined) continue;
    const segments = skillPath.split("/");
    const parent = segments.length >= 2 ? segments[segments.length - 2]! : "skill";
    const skillDir =
      skillPath === "SKILL.md" ? "" : skillPath.slice(0, skillPath.length - "SKILL.md".length);
    const siblingSkillRoots = skillMarkdownPaths
      .filter((path) => path !== skillPath && path !== "SKILL.md")
      .map((path) => path.slice(0, path.length - "SKILL.md".length));
    const extras: Array<{ path: string; content: Uint8Array }> = [];
    for (const [path, content] of files) {
      if (path === skillPath) continue;
      if (skillDir !== "" && !path.startsWith(skillDir)) continue;
      if (siblingSkillRoots.some((root) => path.startsWith(root))) continue;
      const relative = skillDir === "" ? path : path.slice(skillDir.length);
      if (isUnsafeSkillRelativePath(relative)) continue;
      extras.push({ path: relative, content });
      if (extras.length > MAX_EXTRA_FILES_PER_SKILL) {
        throw new Error("npm skill exceeds the support-file limit.");
      }
    }
    found.push({
      directoryName: internalSkillToken(parent),
      markdown: Buffer.from(markdownBytes).toString("utf8"),
      extraFiles: extras,
    });
  }
  return found;
}

function internalSkillToken(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/@/g, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (/^[a-z][a-z0-9-]{0,63}$/.test(sanitized)) return sanitized;
  const prefixed = `skill-${sanitized}`;
  if (/^[a-z][a-z0-9-]{0,63}$/.test(prefixed)) return prefixed;
  return `skill-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function readTarString(header: Uint8Array, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return Buffer.from(slice.subarray(0, end === -1 ? slice.length : end)).toString("utf8");
}
