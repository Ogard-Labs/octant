import { createHash } from "node:crypto";
import type { ExtensionNpmSource, ExtensionSource } from "@octant/contracts/extensions";
import {
  ExtensionNpmPackageName,
  ExtensionNpmSource as NpmSourceSchema,
} from "@octant/contracts/extensions";
import { AGENT_PLUGINS_PLUGIN_SCHEMA } from "@octant/plugin-host/agent-plugins";
import { LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH } from "@octant/plugin-api/language-server-package";
import { DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH } from "@octant/plugin-api/debug-adapter-package";
import {
  OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH,
  type OutsideProviderDriverRefusalReason,
} from "@octant/plugin-api/outside-provider-driver";
import { Schema } from "effect";
import { AgentPluginIngestionError, normalizeAgentPluginPackage } from "./agentPluginIngestion";
import { readBoundedResponseBody } from "./boundedResponseBody";
import { createMarketplaceFetch, MarketplaceFetchesDisabledError } from "./marketplaceHttps";
import type { MarketplaceFetch } from "./marketplaceHttps";
import { withMarketplaceRequest } from "./marketplaceRequestSignal";
import { extractAgentPluginEntriesFromTarball } from "./npmAgentPluginMarketplace";
import {
  MAX_NPM_TARBALL_BYTES,
  NPM_VERSION_PATTERN,
  encodeNpmName,
  parseRegistryJson,
} from "./npmRegistry";
import {
  chooseNpmRegistry,
  isLoopbackHost,
  type NpmRegistryConfigSources,
} from "./npmRegistryConfig";
import { chooseNpmVersion } from "./npmVersionRange";
import {
  outsideProviderDriverRefusalMessage,
  readOutsideProviderDriverPackage,
} from "./outsideProviderDriverPackage";
import { detectPluginDirectoryFormat } from "./pluginDirectoryLoader";
import type { ExtensionArchiveEntry, ResolvedExtensionPackage } from "./packageInspector";

/**
 * Installs a package from an npm registry without running anything from it.
 *
 * Octant looks the package up on the registry the person's npm configuration
 * names, downloads the one tarball the registry's metadata points at, checks
 * the bytes against the integrity the registry published, and reads the
 * archive in memory. It never runs npm, never runs a lifecycle script, and
 * never installs the package's dependencies: what is installed is the files in
 * that one tarball, read the same way a local folder is, and it then waits in
 * quarantine for the person to trust and switch it on.
 *
 * Every failure is a value (`NpmPackageResolution`), so each caller has to
 * say what happened. Only a cancelled request throws.
 */

export type NpmSourceRefusalReason =
  | "name-invalid"
  | "range-unreadable"
  | "registry-unreadable"
  | "registry-insecure"
  | "fetches-off"
  | "network-refused"
  | "registry-refused"
  | "not-found"
  | "version-not-published"
  | "metadata-invalid"
  | "integrity-unavailable"
  | "tarball-host-refused"
  | "integrity-mismatch"
  | "archive-invalid"
  | "too-large"
  | "manifest-unsupported"
  | "version-mismatch"
  | "driver-refused";

export interface NpmSourceRefusal {
  readonly status: "refused";
  readonly reason: NpmSourceRefusalReason;
  /** Set when `reason` is `driver-refused`: the provider driver reader's own reason. */
  readonly driverReason?: OutsideProviderDriverRefusalReason;
}

export type NpmPackageResolution =
  | { readonly status: "resolved"; readonly resolved: ResolvedExtensionPackage }
  | NpmSourceRefusal;

export type NpmLatestVersion =
  | { readonly status: "found"; readonly version: string }
  | NpmSourceRefusal;

export interface NpmPackageSourcePort {
  resolve(
    input: { readonly packageName: string; readonly range?: string },
    signal?: AbortSignal,
  ): Promise<NpmPackageResolution>;
  /** The version the registry an installed package came from tags `latest`. */
  latest(
    input: { readonly packageName: string; readonly registry: string },
    signal?: AbortSignal,
  ): Promise<NpmLatestVersion>;
}

export interface NpmPackageSourceOptions {
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly fetch?: MarketplaceFetch;
  /** When false, no registry request leaves the host. */
  readonly isMarketplaceFetchAllowed?: () => boolean;
  /** The person's npm configuration, read when a lookup starts so a change takes effect at once. */
  readonly readRegistryConfig: () => Promise<NpmRegistryConfigSources>;
}

const decodeNpmPackageName = Schema.decodeUnknownEither(ExtensionNpmPackageName);
const decodeNpmSource = Schema.decodeUnknownEither(NpmSourceSchema);
const INTEGRITY_ALGORITHMS = ["sha512", "sha384", "sha256"] as const;
const REGISTRY_ACCEPT = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";
const PACKAGE_DOCUMENT_PATHS = [
  LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH,
  OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH,
  DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH,
] as const;

export class NpmPackageSource implements NpmPackageSourcePort {
  readonly #options: NpmPackageSourceOptions;
  readonly #fetch: MarketplaceFetch;

  constructor(options: NpmPackageSourceOptions) {
    this.#options = options;
    this.#fetch =
      options.isMarketplaceFetchAllowed === undefined
        ? (options.fetch ?? globalThis.fetch)
        : createMarketplaceFetch({
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            isAllowed: options.isMarketplaceFetchAllowed,
          });
  }

  async resolve(
    input: { readonly packageName: string; readonly range?: string },
    signal?: AbortSignal,
  ): Promise<NpmPackageResolution> {
    const packageName = input.packageName.trim();
    if (decodeNpmPackageName(packageName)._tag === "Left") return refuse("name-invalid");
    const choice = chooseNpmRegistry(packageName, await this.#options.readRegistryConfig());
    if (choice.status === "unreadable") return refuse("registry-unreadable");
    if (choice.status === "insecure") return refuse("registry-insecure");
    return withMarketplaceRequest(signal, async (boundedSignal) => {
      const packument = await this.#packument(choice.registry, packageName, boundedSignal);
      if (packument.status === "refused") return packument;
      const chosen = chooseNpmVersion({
        requested: input.range,
        published: packument.published,
        distTags: packument.distTags,
      });
      if (chosen.status === "range-unreadable") return refuse("range-unreadable");
      if (chosen.status === "none-published") return refuse("version-not-published");
      const release = packument.releases.get(chosen.version);
      if (release === undefined) return refuse("metadata-invalid");
      const integrity = strongestIntegrity(release.integrity);
      if (integrity === undefined) return refuse("integrity-unavailable");
      const tarball = await this.#download(choice.registry, release.tarball, boundedSignal);
      if (tarball.status === "refused") return tarball;
      if (!matchesIntegrity(tarball.bytes, integrity)) return refuse("integrity-mismatch");
      const npm = decodeNpmSource({
        packageName,
        version: chosen.version,
        registry: choice.registry,
        integrity: integrity.token,
      });
      if (npm._tag === "Left") return refuse("metadata-invalid");
      return this.#read({ npm: npm.right, tarball: tarball.bytes });
    });
  }

  async latest(
    input: { readonly packageName: string; readonly registry: string },
    signal?: AbortSignal,
  ): Promise<NpmLatestVersion> {
    if (decodeNpmPackageName(input.packageName)._tag === "Left") return refuse("name-invalid");
    const choice = chooseNpmRegistry(input.packageName, {
      env: { npm_config_registry: input.registry },
    });
    if (choice.status === "unreadable") return refuse("registry-unreadable");
    if (choice.status === "insecure") return refuse("registry-insecure");
    return withMarketplaceRequest(signal, async (boundedSignal) => {
      const packument = await this.#packument(choice.registry, input.packageName, boundedSignal);
      if (packument.status === "refused") return packument;
      const chosen = chooseNpmVersion({
        requested: "latest",
        published: packument.published,
        distTags: packument.distTags,
      });
      return chosen.status === "chosen"
        ? { status: "found" as const, version: chosen.version }
        : refuse("version-not-published");
    });
  }

  async #packument(
    registry: string,
    packageName: string,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly status: "found";
        readonly published: ReadonlyArray<string>;
        readonly distTags: Readonly<Record<string, string>>;
        readonly releases: ReadonlyMap<
          string,
          { readonly tarball: string; readonly integrity: string | undefined }
        >;
      }
    | NpmSourceRefusal
  > {
    const answered = await this.#request(
      `${registry}/${encodeNpmName(packageName)}`,
      { accept: REGISTRY_ACCEPT },
      signal,
    );
    if (answered.status === "refused") return answered;
    let body: unknown;
    try {
      body = await parseRegistryJson<unknown>(answered.response);
    } catch {
      return refuse("metadata-invalid");
    }
    if (!isRecord(body) || body.name !== packageName || !isRecord(body.versions)) {
      return refuse("metadata-invalid");
    }
    const releases = new Map<
      string,
      { readonly tarball: string; readonly integrity: string | undefined }
    >();
    for (const [version, release] of Object.entries(body.versions)) {
      if (!NPM_VERSION_PATTERN.test(version) || !isRecord(release) || !isRecord(release.dist)) {
        continue;
      }
      const tarball = release.dist.tarball;
      if (typeof tarball !== "string") continue;
      const integrity = release.dist.integrity;
      releases.set(version, {
        tarball,
        integrity: typeof integrity === "string" ? integrity : undefined,
      });
    }
    const distTags: Record<string, string> = {};
    if (isRecord(body["dist-tags"])) {
      for (const [tag, version] of Object.entries(body["dist-tags"])) {
        if (typeof version === "string") distTags[tag] = version;
      }
    }
    return { status: "found", published: [...releases.keys()], distTags, releases };
  }

  async #download(
    registry: string,
    tarballUrl: string,
    signal: AbortSignal,
  ): Promise<{ readonly status: "found"; readonly bytes: Uint8Array } | NpmSourceRefusal> {
    // The tarball must come from the registry that named it. A registry that
    // points elsewhere could send the person's request, and the package, to a
    // host they never chose.
    let url: URL;
    try {
      url = new URL(tarballUrl, `${registry}/`);
    } catch {
      return refuse("tarball-host-refused");
    }
    if (url.origin !== new URL(registry).origin) return refuse("tarball-host-refused");
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      return refuse("tarball-host-refused");
    }
    const answered = await this.#request(url.toString(), {}, signal);
    if (answered.status === "refused") return answered;
    try {
      return {
        status: "found",
        bytes: await readBoundedResponseBody(
          answered.response,
          MAX_NPM_TARBALL_BYTES,
          "npm package exceeds size limits.",
        ),
      };
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      return refuse("too-large");
    }
  }

  async #request(
    url: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<{ readonly status: "ok"; readonly response: Response } | NpmSourceRefusal> {
    let response: Response;
    try {
      response = await this.#fetch(url, { headers, redirect: "error", signal });
    } catch (error) {
      if (error instanceof MarketplaceFetchesDisabledError) return refuse("fetches-off");
      if (isAbort(error) || signal.aborted) throw error;
      return refuse("network-refused");
    }
    if (response.status === 404) return refuse("not-found");
    if (!response.ok) return refuse("registry-refused");
    return { status: "ok", response };
  }

  #read(input: {
    readonly npm: ExtensionNpmSource;
    readonly tarball: Uint8Array;
  }): NpmPackageResolution {
    let entries: ReadonlyArray<ExtensionArchiveEntry>;
    try {
      entries = extractAgentPluginEntriesFromTarball(input.tarball, { recordExecutable: true });
    } catch (error) {
      return refuse(
        error instanceof Error && /exceeds|limits/.test(error.message)
          ? "too-large"
          : "archive-invalid",
      );
    }
    const source: ExtensionSource = {
      kind: "plugin-package",
      sourceRef: npmSourceReference(input.npm.registry, input.npm.packageName) as never,
    };
    if (
      PACKAGE_DOCUMENT_PATHS.filter((path) =>
        entries.some((entry) => entry.kind === "file" && entry.path === path),
      ).length > 1
    ) {
      return refuse("manifest-unsupported");
    }
    const format = detectPluginDirectoryFormat(entries);
    if (format === "outside-provider-driver") {
      const reading = readOutsideProviderDriverPackage({
        layout: "outside-provider-driver",
        source,
        format: "tar",
        archiveBytes: input.tarball.byteLength,
        entries,
        npm: input.npm,
        appVersion: this.#options.appVersion,
        platform: this.#options.platform,
      });
      if (reading.status === "refused") {
        return { status: "refused", reason: "driver-refused", driverReason: reading.reason };
      }
      // The signature binds the version the driver declares, and the registry
      // names the version it served. If they differ, the package on screen is
      // not the one that was signed.
      if ((reading.resolved.manifest as { version?: unknown }).version !== input.npm.version) {
        return refuse("version-mismatch");
      }
      return { status: "resolved", resolved: reading.resolved };
    }
    if (format === "agent-plugins" && hasCanonicalPluginSchema(entries)) {
      try {
        return {
          status: "resolved",
          resolved: normalizeAgentPluginPackage({
            source,
            format: "tar",
            archiveBytes: input.tarball.byteLength,
            entries: entries.map(({ executable: _mode, ...entry }) => entry),
            npm: input.npm,
            appVersion: this.#options.appVersion,
            platform: this.#options.platform,
          }),
        };
      } catch (error) {
        if (error instanceof AgentPluginIngestionError) return refuse("manifest-unsupported");
        throw error;
      }
    }
    return refuse("manifest-unsupported");
  }
}

/**
 * The identity an installed npm package keeps across versions: the registry
 * it came from and its name. A different registry is a different source, so a
 * same-named package served somewhere else is never an update of this one.
 */
export function npmSourceReference(registry: string, packageName: string): string {
  return `npm:${createHash("sha256").update(`${registry}\n${packageName}`).digest("hex").slice(0, 32)}`;
}

function hasCanonicalPluginSchema(entries: ReadonlyArray<ExtensionArchiveEntry>): boolean {
  const content = entries.find(
    (entry) => entry.kind === "file" && entry.path === "plugin.json",
  )?.content;
  if (content === undefined) return false;
  try {
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
    ) as unknown;
    return isRecord(manifest) && manifest.$schema === AGENT_PLUGINS_PLUGIN_SCHEMA;
  } catch {
    return false;
  }
}

/**
 * The strongest SHA-2 digest in a Subresource Integrity string. A SHA-1 digest
 * is not enough to prove the bytes, so a registry that offers only that gives
 * Octant nothing to check against.
 */
function strongestIntegrity(
  published: string | undefined,
):
  | { readonly algorithm: (typeof INTEGRITY_ALGORITHMS)[number]; readonly token: string }
  | undefined {
  if (published === undefined) return undefined;
  const tokens = published.trim().split(/\s+/);
  for (const algorithm of INTEGRITY_ALGORITHMS) {
    const token = tokens.find((candidate) => candidate.startsWith(`${algorithm}-`));
    if (token !== undefined && /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(token)) {
      return { algorithm, token };
    }
  }
  return undefined;
}

function matchesIntegrity(
  bytes: Uint8Array,
  integrity: { readonly algorithm: string; readonly token: string },
): boolean {
  const expected = Buffer.from(integrity.token.slice(integrity.algorithm.length + 1), "base64");
  const actual = createHash(integrity.algorithm).update(bytes).digest();
  return expected.byteLength === actual.byteLength && expected.equals(actual);
}

function refuse(reason: NpmSourceRefusalReason): NpmSourceRefusal {
  return { status: "refused", reason };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Octant's own words for each refusal. None repeats text from the registry or the package. */
export function npmSourceRefusalMessage(refusal: NpmSourceRefusal): string {
  switch (refusal.reason) {
    case "name-invalid":
      return "That is not an npm package name. Use a lowercase name, with its @scope before a slash when it has one.";
    case "range-unreadable":
      return "Octant could not read that version. Use an exact version such as 1.2.3, a range such as ^1.2.0, or a tag such as latest.";
    case "registry-unreadable":
      return "Your npm configuration names a registry address Octant cannot read, so it fetched nothing. An address that uses an environment variable is not read.";
    case "registry-insecure":
      return "Your npm configuration names a registry over plain http. Octant reaches a registry only over https, or over http on this computer, so it fetched nothing.";
    case "fetches-off":
      return "Marketplace fetches are turned off in Settings.";
    case "network-refused":
      return "Octant could not reach the npm registry. Nothing was installed.";
    case "registry-refused":
      return "The npm registry refused the request. Octant sends no login, so a registry that needs one cannot be used.";
    case "not-found":
      return "The npm registry has no package with that name.";
    case "version-not-published":
      return "The registry has no published version of that package that matches.";
    case "metadata-invalid":
      return "The registry's answer for that package was not valid. Nothing was installed.";
    case "integrity-unavailable":
      return "The registry published no SHA-256, SHA-384 or SHA-512 integrity for that version, so Octant cannot check the download.";
    case "tarball-host-refused":
      return "The registry pointed at a download outside its own address. Octant did not fetch it.";
    case "integrity-mismatch":
      return "The download does not match the integrity the registry published. Octant discarded it and installed nothing.";
    case "archive-invalid":
      return "The download is not a package archive Octant can read. Links, special files and unsafe paths are refused.";
    case "too-large":
      return "The package is larger than Octant reads.";
    case "manifest-unsupported":
      return "This npm package is not one Octant can install: it has neither an Agent Plugin description nor a provider driver description.";
    case "version-mismatch":
      return "This provider driver declares a different version from the npm version that carries it.";
    case "driver-refused":
      return refusal.driverReason === undefined
        ? "This provider driver was refused."
        : outsideProviderDriverRefusalMessage(refusal.driverReason);
  }
}

/** How the extension API files a refusal: what the person can change, or nothing they can. */
export function npmSourceRefusalCategory(
  reason: NpmSourceRefusalReason,
): "blocked" | "unavailable" | "invalid" {
  if (reason === "fetches-off") return "blocked";
  if (
    reason === "network-refused" ||
    reason === "registry-refused" ||
    reason === "not-found" ||
    reason === "version-not-published"
  ) {
    return "unavailable";
  }
  return "invalid";
}
