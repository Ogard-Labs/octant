import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADLESS_ARTIFACT_MANIFEST_FILENAME } from "@octant/host-runtime";

// In a headless artifact the CLI bundle is `bin/octant` and the server is
// `lib/server/main.mjs` beside it, with no repository checkout around them.
// The repository-relative `apps/server` path the development CLI uses does
// not exist there, which made an installed `octant server run` fail.

export interface ServerStartCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Environment the server child needs on top of the caller's own. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The artifact root this CLI module runs from, or `undefined` when it runs
 * from source. A root is recognised only by the manifest the artifact build
 * writes next to `bin/`.
 */
export function resolveInstalledArtifactRoot(
  moduleUrl: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!moduleUrl.startsWith("file:")) return undefined;
  const root = dirname(dirname(fileURLToPath(moduleUrl)));
  return exists(join(root, HEADLESS_ARTIFACT_MANIFEST_FILENAME)) ? root : undefined;
}

/**
 * Runs the artifact's own server under the runtime running this CLI. The
 * server verifies the artifact named by `OCTANT_ARTIFACT_ROOT` before it opens
 * anything, and serves the artifact's web assets.
 */
export function installedArtifactServerStartCommand(
  artifactRoot: string,
  runtimeExecutable: string,
): ServerStartCommand {
  return {
    command: runtimeExecutable,
    args: [join(artifactRoot, "lib", "server", "main.mjs")],
    env: {
      OCTANT_ARTIFACT_ROOT: artifactRoot,
      OCTANT_WEB_DIST_PATH: join(artifactRoot, "share", "web"),
    },
  };
}
