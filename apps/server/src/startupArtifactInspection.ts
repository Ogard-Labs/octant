import {
  inspectHeadlessArtifact,
  type HeadlessArtifactInspectionResult,
} from "@octant/host-runtime";
import { MIGRATIONS } from "./persistence/migrations";

// Startup inspection for the packaged headless artifact. It runs before
// runtime ownership and reads only artifact-internal metadata: the manifest,
// component bytes, and (optionally) native-module loadability. It never opens
// the live SQLite store; store-schema compatibility against the actual store
// is enforced separately behind the exclusive owner socket by the migration
// boundary.

export interface StartupArtifactInspectionOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly arch?: string;
  readonly wireVersion?: string;
  readonly storeVersion?: number;
  readonly loadNativeModule?: (absolutePath: string) => void | Promise<void>;
}

/** The newest store schema version this server binary can own. */
export function latestStoreVersion(): number {
  return MIGRATIONS.at(-1)?.version ?? 0;
}

/**
 * Inspects the packaged artifact named by `OCTANT_ARTIFACT_ROOT`. Returns
 * `undefined` when the runtime is not a packaged headless artifact (development
 * bootstrap, desktop-managed child), and a typed inspection result otherwise.
 */
export async function runStartupArtifactInspection(
  options: StartupArtifactInspectionOptions,
): Promise<HeadlessArtifactInspectionResult | undefined> {
  const artifactRoot = options.env.OCTANT_ARTIFACT_ROOT;
  if (artifactRoot === undefined || artifactRoot === "") return undefined;
  return inspectHeadlessArtifact({
    artifactRoot,
    runtime: {
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      wireVersion: options.wireVersion ?? "1",
      storeVersion: options.storeVersion ?? latestStoreVersion(),
    },
    ...(options.loadNativeModule === undefined
      ? {}
      : { loadNativeModule: options.loadNativeModule }),
  });
}
