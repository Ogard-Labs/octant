import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MarketplaceFetch } from "./marketplaceHttps";
import { extractAgentPluginEntriesFromTarball } from "./npmAgentPluginMarketplace";
import {
  DEFAULT_NPM_REGISTRY_URL,
  downloadNpmTarball,
  fetchNpmPackageMetadata,
  verifyNpmTarballIntegrity,
} from "./npmRegistry";

export interface PinnedConnectorPackage {
  readonly name: string;
  readonly version: string;
  /** The integrity the bundled catalog pins; the registry's own answer never replaces it. */
  readonly integrity: string;
}

/**
 * Put one pinned npm package into `<folder>/node_modules/<name>`. The tarball
 * is accepted only when its bytes match the catalog's integrity, so a registry
 * that serves other bytes for the same version installs nothing. Nothing from
 * the package runs here: no install scripts, no dependency resolution.
 */
export type InstallConnectorPackage = (input: {
  readonly package: PinnedConnectorPackage;
  readonly folder: string;
}) => Promise<void>;

export function createConnectorPackageInstaller(options: {
  readonly fetch: MarketplaceFetch;
  /** False when the person turned marketplace fetches off: no request leaves the host. */
  readonly isFetchAllowed: () => boolean;
  readonly registryUrl?: string;
}): InstallConnectorPackage {
  const registryUrl = options.registryUrl ?? DEFAULT_NPM_REGISTRY_URL;
  return async ({ package: pinned, folder }) => {
    if (!options.isFetchAllowed()) {
      throw new Error(
        "Downloads from the package registry are turned off, so this connector cannot be installed.",
      );
    }
    const metadata = await fetchNpmPackageMetadata({
      fetch: options.fetch,
      registryUrl,
      packageName: pinned.name,
      requestedVersion: pinned.version,
    });
    if (metadata.version !== pinned.version) {
      throw new Error("The registry did not return the pinned version.");
    }
    const tarball = await downloadNpmTarball({
      fetch: options.fetch,
      registryUrl,
      url: metadata.tarballUrl,
    });
    verifyNpmTarballIntegrity(tarball, pinned.integrity, undefined);
    const root = join(folder, "node_modules", ...pinned.name.split("/"));
    for (const entry of extractAgentPluginEntriesFromTarball(tarball)) {
      if (entry.kind !== "file" || entry.content === undefined) continue;
      const target = join(root, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, entry.content, { mode: 0o600 });
    }
  };
}
