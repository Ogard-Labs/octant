import { createHash } from "node:crypto";
import { readBoundedResponseBody } from "./boundedResponseBody";
import { MARKETPLACE_FETCH_USER_AGENT, type MarketplaceFetch } from "./marketplaceRequestSignal";
import { decodeCompactCatalogIdentity, encodeCompactCatalogIdentity } from "./skillPackageBuilder";

/**
 * Shared npm registry access for the skill and Agent Plugin marketplaces.
 * Every request runs through the marketplace fetch wrapper so the User-Agent
 * stays constrained, redirects stay disabled, and the host preference can
 * suppress the request entirely.
 */

export const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const MAX_NPM_REGISTRY_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_NPM_TARBALL_BYTES = 8 * 1024 * 1024;
export const NPM_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/**
 * A package name this module can request verbatim: npm's optional `@scope/`
 * and exactly one name segment, with no character `encodeURIComponent` would
 * rewrite. A name such as `@a/b/c` would otherwise be truncated to `@a/b` by
 * `encodeNpmName`, so a catalog identity would name one package and resolve
 * another. Uppercase and legacy punctuation stay because the registry still
 * serves legacy names and encoding leaves those characters alone.
 */
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9._~!()*'-]+\/)?[A-Za-z0-9._~!()*'-]+$/;

export interface NpmPackageMetadata {
  readonly version: string;
  readonly tarballUrl: string;
  readonly integrity?: string;
  readonly shasum?: string;
  readonly publisher?: string;
  readonly license?: string;
}

export async function fetchNpmPackageMetadata(input: {
  readonly fetch: MarketplaceFetch;
  readonly registryUrl: string;
  readonly packageName: string;
  readonly requestedVersion?: string;
  readonly signal?: AbortSignal;
}): Promise<NpmPackageMetadata> {
  const response = await input.fetch(
    new URL(`/${encodeNpmName(input.packageName)}`, input.registryUrl).toString(),
    {
      headers: { accept: "application/json", "user-agent": MARKETPLACE_FETCH_USER_AGENT },
      redirect: "error",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
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
  const version = input.requestedVersion ?? body["dist-tags"]?.latest;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("npm package version is unavailable.");
  }
  const release = body.versions?.[version];
  const tarballUrl = release?.dist?.tarball;
  if (typeof tarballUrl !== "string" || tarballUrl.trim() === "") {
    throw new Error("npm package tarball is unavailable.");
  }
  assertAllowedNpmTarballUrl(tarballUrl, input.registryUrl);
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

export async function downloadNpmTarball(input: {
  readonly fetch: MarketplaceFetch;
  readonly registryUrl: string;
  readonly url: string;
  readonly signal?: AbortSignal;
}): Promise<Uint8Array> {
  assertAllowedNpmTarballUrl(input.url, input.registryUrl);
  const response = await input.fetch(input.url, {
    headers: { "user-agent": MARKETPLACE_FETCH_USER_AGENT },
    redirect: "error",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new Error("npm package download failed.");
  return readBoundedResponseBody(
    response,
    MAX_NPM_TARBALL_BYTES,
    "npm package exceeds size limits.",
  );
}

export async function parseRegistryJson<T>(response: Response): Promise<T> {
  const bytes = await readBoundedResponseBody(
    response,
    MAX_NPM_REGISTRY_JSON_BYTES,
    "npm registry response exceeds size limits.",
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new Error("npm registry returned invalid JSON.");
  }
}

export function verifyNpmTarballIntegrity(
  tarballBytes: Uint8Array,
  integrity: string | undefined,
  shasum: string | undefined,
): void {
  if (typeof integrity === "string" && integrity.trim() !== "") {
    const match = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
    const algorithm = match?.[1];
    const digest = match?.[2];
    if (algorithm === undefined || digest === undefined) {
      throw new Error("npm package integrity metadata is invalid.");
    }
    const expected = Buffer.from(digest, "base64");
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

export function assertAllowedNpmTarballUrl(url: string, registryUrl: string): void {
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

export function parseNpmSearchObject(value: unknown):
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

export function encodeNpmName(packageName: string): string {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.slice(1).split("/");
    return `${encodeURIComponent(`@${scope}`)}/${encodeURIComponent(name ?? "")}`;
  }
  return encodeURIComponent(packageName);
}

/** Reversible catalog entry id: `n` + lowercase base32(utf8 package name). */
export function encodeNpmEntryId(packageName: string, version?: string): string {
  if (
    typeof packageName !== "string" ||
    !NPM_PACKAGE_NAME_PATTERN.test(packageName) ||
    (version !== undefined && !NPM_VERSION_PATTERN.test(version))
  ) {
    throw new Error("npm package name is invalid.");
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

export function decodeNpmEntryIdentity(
  entryId: string,
): { readonly packageName: string; readonly version?: string } | undefined {
  if (!/^n[a-z2-7]+$/.test(entryId)) return undefined;
  const decoded = decodeCompactCatalogIdentity(entryId.slice(1));
  if (decoded === undefined) return undefined;
  const separator = decoded.lastIndexOf("\n");
  if (separator < 0) {
    return NPM_PACKAGE_NAME_PATTERN.test(decoded) ? { packageName: decoded } : undefined;
  }
  const packageName = decoded.slice(0, separator);
  const version = decoded.slice(separator + 1);
  if (!NPM_PACKAGE_NAME_PATTERN.test(packageName) || !NPM_VERSION_PATTERN.test(version)) {
    return undefined;
  }
  return { packageName, version };
}
