import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { ExtensionSource } from "@octant/contracts/extensions";
import type { SkillMarketplaceEntry } from "@octant/contracts/extension-rpc";
import type { ResolvedExtensionPackage } from "./packageInspector";
import type { SkillMarketplacePort } from "./standaloneSkillService";
import { readBoundedResponseBody } from "./boundedResponseBody";
import { MARKETPLACE_FETCH_USER_AGENT, withMarketplaceRequest } from "./marketplaceRequestSignal";
import {
  NPM_SKILLS_CATALOG_ID,
  buildStandaloneSkillPackage,
  decodeCompactCatalogIdentity,
  encodeCompactCatalogIdentity,
  isUnsafeSkillRelativePath,
  skillSearchEntry,
} from "./skillPackageBuilder";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_LIMIT = 25;
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_TAR_ENTRIES = 4_096;
const MAX_EXTRA_FILES_PER_SKILL = 64;
const MAX_REGISTRY_JSON_BYTES = 8 * 1024 * 1024;
const NPM_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface NpmSkillMarketplaceOptions {
  readonly fetch?: typeof globalThis.fetch;
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
  readonly #fetch: typeof globalThis.fetch;
  readonly #registryUrl: string;
  readonly #appVersion: string;
  readonly #platform: NodeJS.Platform;

  constructor(options: NpmSkillMarketplaceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#registryUrl = options.registryUrl ?? DEFAULT_REGISTRY;
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
    const metadata = await this.#fetchPackageMetadata(packageName, identity.version, signal);
    const tarball = await this.#downloadTarball(metadata.tarballUrl, signal);
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

  async #fetchPackageMetadata(
    packageName: string,
    requestedVersion?: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly version: string;
    readonly tarballUrl: string;
    readonly integrity?: string;
    readonly shasum?: string;
    readonly publisher?: string;
    readonly license?: string;
  }> {
    const response = await this.#fetch(
      new URL(`/${encodeNpmName(packageName)}`, this.#registryUrl).toString(),
      {
        headers: { accept: "application/json", "user-agent": MARKETPLACE_FETCH_USER_AGENT },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) throw new Error("npm package metadata is unavailable.");
    const body = await parseRegistryJson<{
      "dist-tags"?: { latest?: string };
      versions?: Record<
        string,
        {
          dist?: { tarball?: string; integrity?: string; shasum?: string };
          version?: string;
          license?: unknown;
          _npmUser?: { name?: unknown };
        }
      >;
      author?: { name?: string } | string;
      maintainers?: ReadonlyArray<{ name?: unknown }>;
      license?: unknown;
    }>(response);
    const version = requestedVersion ?? body["dist-tags"]?.latest;
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error("npm package version is unavailable.");
    }
    const release = body.versions?.[version];
    const tarballUrl = release?.dist?.tarball;
    if (typeof tarballUrl !== "string" || tarballUrl.trim() === "") {
      throw new Error("npm package tarball is unavailable.");
    }
    assertAllowedTarballUrl(tarballUrl, this.#registryUrl);
    const integrity =
      typeof release?.dist?.integrity === "string" ? release.dist.integrity : undefined;
    const shasum = typeof release?.dist?.shasum === "string" ? release.dist.shasum : undefined;
    if (integrity === undefined && shasum === undefined) {
      throw new Error("npm package integrity metadata is unavailable.");
    }
    const publisher =
      typeof release?._npmUser?.name === "string"
        ? release._npmUser.name
        : typeof body.maintainers?.[0]?.name === "string"
          ? body.maintainers[0].name
          : undefined;
    const rawLicense = release?.license ?? body.license;
    const license =
      typeof rawLicense === "string" && rawLicense.trim() !== "" && rawLicense.length <= 256
        ? rawLicense.trim()
        : undefined;
    return {
      version,
      tarballUrl,
      ...(integrity === undefined ? {} : { integrity }),
      ...(shasum === undefined ? {} : { shasum }),
      ...(publisher === undefined ? {} : { publisher }),
      ...(license === undefined ? {} : { license }),
    };
  }

  async #downloadTarball(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    assertAllowedTarballUrl(url, this.#registryUrl);
    const response = await this.#fetch(url, {
      headers: { "user-agent": MARKETPLACE_FETCH_USER_AGENT },
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error("npm package download failed.");
    return readBoundedResponseBody(response, MAX_TARBALL_BYTES, "npm package exceeds size limits.");
  }
}

async function parseRegistryJson<T>(response: Response): Promise<T> {
  const bytes = await readBoundedResponseBody(
    response,
    MAX_REGISTRY_JSON_BYTES,
    "npm registry response exceeds size limits.",
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new Error("npm registry returned invalid JSON.");
  }
}

/** Reversible catalog entry id: `n` + lowercase base32(utf8 package name). */
export function encodeNpmEntryId(packageName: string, version?: string): string {
  if (
    typeof packageName !== "string" ||
    packageName.trim() === "" ||
    packageName.includes("\n") ||
    (version !== undefined && !NPM_VERSION_PATTERN.test(version))
  ) {
    throw new Error("npm package name is required.");
  }
  const identity = version === undefined ? packageName : `${packageName}\n${version}`;
  const id = `n${encodeCompactCatalogIdentity(identity)}`;
  if (id.length > 96 || !/^[a-z][a-z0-9]*$/.test(id)) {
    throw new Error("npm package name is too long for catalog identity.");
  }
  return id;
}

export function decodeNpmEntryId(entryId: string): string | undefined {
  return decodeNpmEntryIdentity(entryId)?.packageName;
}

function decodeNpmEntryIdentity(
  entryId: string,
): { readonly packageName: string; readonly version?: string } | undefined {
  if (!/^n[a-z2-7]+$/.test(entryId)) return undefined;
  const decoded = decodeCompactCatalogIdentity(entryId.slice(1));
  if (decoded === undefined || decoded.trim() === "") return undefined;
  const separator = decoded.lastIndexOf("\n");
  if (separator < 0) return { packageName: decoded };
  const packageName = decoded.slice(0, separator);
  const version = decoded.slice(separator + 1);
  if (
    packageName.trim() === "" ||
    !NPM_VERSION_PATTERN.test(version) ||
    packageName.includes("\n")
  ) {
    return undefined;
  }
  return { packageName, version };
}

export function verifyNpmTarballIntegrity(
  tarballBytes: Uint8Array,
  integrity: string | undefined,
  shasum: string | undefined,
): void {
  if (typeof integrity === "string" && integrity.trim() !== "") {
    const match = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
    if (match === null) throw new Error("npm package integrity metadata is invalid.");
    const algorithm = match[1]!;
    const expected = Buffer.from(match[2]!, "base64");
    const actual = createHash(algorithm).update(tarballBytes).digest();
    if (expected.byteLength !== actual.byteLength || !expected.equals(actual)) {
      throw new Error("npm package integrity check failed.");
    }
    return;
  }
  if (typeof shasum === "string" && /^[0-9a-f]{40}$/i.test(shasum.trim())) {
    const actual = createHash("sha1").update(tarballBytes).digest("hex");
    if (actual !== shasum.trim().toLowerCase()) {
      throw new Error("npm package integrity check failed.");
    }
    return;
  }
  throw new Error("npm package integrity metadata is unavailable.");
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

function assertAllowedTarballUrl(url: string, registryUrl: string): void {
  let parsed: URL;
  let registry: URL;
  try {
    parsed = new URL(url);
    registry = new URL(registryUrl);
  } catch {
    throw new Error("npm package tarball URL is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("npm package tarball URL must use HTTPS.");
  }
  const allowed = new Set([registry.hostname, "registry.npmjs.org"]);
  if (!allowed.has(parsed.hostname)) {
    throw new Error("npm package tarball host is not allowed.");
  }
}

function parseNpmSearchObject(value: unknown):
  | {
      readonly name: string;
      readonly version: string;
      readonly description?: string;
      readonly publisher?: string;
    }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const packageValue = (value as { package?: unknown }).package;
  if (typeof packageValue !== "object" || packageValue === null) return undefined;
  const pkg = packageValue as {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    publisher?: { username?: unknown };
  };
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return undefined;
  const name = pkg.name.trim();
  const version = pkg.version.trim();
  if (name === "" || version === "") return undefined;
  const description = typeof pkg.description === "string" ? pkg.description.trim() : undefined;
  const publisher =
    typeof pkg.publisher?.username === "string" ? pkg.publisher.username.trim() : undefined;
  return {
    name,
    version,
    ...(description === undefined || description === "" ? {} : { description }),
    ...(publisher === undefined || publisher === "" ? {} : { publisher }),
  };
}

function encodeNpmName(packageName: string): string {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.slice(1).split("/");
    return `${encodeURIComponent(`@${scope}`)}/${encodeURIComponent(name ?? "")}`;
  }
  return encodeURIComponent(packageName);
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
