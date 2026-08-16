import type { ExtensionContentDigest } from "@octant/contracts/extensions";
import type { ExtensionCatalogEntryId, ExtensionCatalogId } from "@octant/contracts/extensions";
import type { ExtensionSource } from "@octant/contracts/extensions";
import {
  codexPluginExtensionId,
  codexPluginPackageId,
  type CodexPluginCurationBinding,
} from "./codexPluginIngestion";
import type { PinnedUpstreamPackageReference } from "./pinnedUpstreamPackageFetcher";

export const OCTANT_CURATED_CATALOG_ID = "octant-curated" as unknown as ExtensionCatalogId;
export const BUILD_IOS_APPS_CATALOG_ENTRY_ID =
  "build-ios-apps" as unknown as ExtensionCatalogEntryId;
export const BUILD_IOS_APPS_UPSTREAM_SOURCE_COMMIT = "cd0fccd4ed62dded584c16246685b232d7bfe7f6";
export const BUILD_IOS_APPS_CURATION_REVIEWED_AT = "2026-07-30T00:00:00.000Z";

/**
 * The expected digest of the complete exact pinned upstream package after
 * normalization. Computed from all 76 upstream blobs at commit
 * `cd0fccd4…` with the curation binding active (reviewed provenance). The
 * runtime fetcher fetches the complete package closure and the inspector
 * verifies the computed digest against this value before preview/install.
 * No partial, stale, or locally invented bytes can satisfy this binding.
 */
export const BUILD_IOS_APPS_EXPECTED_DIGEST =
  "sha256:29dd3dd3f185620eec9d67c87f792484fdbec420027f2d460306af59e9a51e50" as unknown as ExtensionContentDigest;

/**
 * The exact upstream reference for the curated `openai/build-ios-apps`
 * package. The fetcher uses this to fetch the complete package closure from
 * the GitHub tree API at the pinned commit.
 */
export const BUILD_IOS_APPS_UPSTREAM_REFERENCE: PinnedUpstreamPackageReference = {
  owner: "openai",
  repository: "plugins",
  packagePath: "plugins/build-ios-apps",
  commit: BUILD_IOS_APPS_UPSTREAM_SOURCE_COMMIT,
};

/**
 * Display metadata for the catalog listing. These fields are sufficient for
 * `ExtensionCatalogEntry` without fetching the complete package. The full
 * review (provenance, license, compatibility, capabilities, components) is
 * produced during inspect/preview, which fetches the complete package and
 * verifies the digest.
 */
export interface CuratedBuildIosAppsDisplayMetadata {
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
}

export const BUILD_IOS_APPS_DISPLAY_METADATA: CuratedBuildIosAppsDisplayMetadata = {
  name: "build-ios-apps",
  version: "0.1.2",
  displayName: "Build iOS Apps",
  description:
    "Build iOS apps with workflows for App Intents, SwiftUI UI work, Simulator mirroring in the Codex in-app browser, performance profiling, leak investigation, and simulator debugging.",
};

/**
 * The curated catalog source for `openai/build-ios-apps`. This is metadata-only:
 * no upstream bytes are vendored. The resolver fetches the complete exact
 * pinned upstream package at runtime via the pinned upstream fetcher and
 * verifies the computed digest against `BUILD_IOS_APPS_EXPECTED_DIGEST` before
 * preview/install. Installation still requires explicit inspection, trust,
 * plugin enablement, and component enablement.
 */
export interface CuratedBuildIosAppsCatalogSource {
  readonly packageFormat: "codex" | "agent-plugin";
  readonly source: Extract<ExtensionSource, { readonly kind: "catalog" }>;
  readonly upstreamReference: PinnedUpstreamPackageReference;
  readonly expectedDigest: ExtensionContentDigest;
  readonly curationBinding: CodexPluginCurationBinding;
  readonly displayMetadata: CuratedBuildIosAppsDisplayMetadata;
}

export function createCuratedBuildIosAppsCatalogSource(): CuratedBuildIosAppsCatalogSource {
  const source = {
    kind: "catalog" as const,
    catalogId: OCTANT_CURATED_CATALOG_ID,
    entryId: BUILD_IOS_APPS_CATALOG_ENTRY_ID,
  };
  return {
    packageFormat: "codex",
    source,
    upstreamReference: BUILD_IOS_APPS_UPSTREAM_REFERENCE,
    expectedDigest: BUILD_IOS_APPS_EXPECTED_DIGEST,
    curationBinding: {
      catalogId: OCTANT_CURATED_CATALOG_ID as unknown as string,
      entryId: BUILD_IOS_APPS_CATALOG_ENTRY_ID as unknown as string,
      sourceCommit: BUILD_IOS_APPS_UPSTREAM_SOURCE_COMMIT,
      reviewedAt: BUILD_IOS_APPS_CURATION_REVIEWED_AT,
      expectedDigest: BUILD_IOS_APPS_EXPECTED_DIGEST as unknown as string,
    },
    displayMetadata: BUILD_IOS_APPS_DISPLAY_METADATA,
  };
}

/**
 * Default production catalog: exactly the curated Build iOS Apps record.
 */
export function createDefaultCodexPluginPackageSources(): {
  readonly catalog: ReadonlyArray<CuratedBuildIosAppsCatalogSource>;
} {
  return { catalog: [createCuratedBuildIosAppsCatalogSource()] };
}
