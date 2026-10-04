import { copyFile, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BUNDLED_MANAGED_TOOL_RELEASES,
  MANAGED_TOOLS,
  boundedRegistryDownload,
  stageManagedTool,
} from "../apps/desktop/src/managedToolRelease";

/**
 * Build-time tool acquisition: each managed tool is staged with the same
 * integrity verification the in-app update channel applies, then copied into
 * the packaged resources. End users receive the verified tree in the app.
 */
export async function prepareManagedTools(
  repositoryRoot: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const tools = MANAGED_TOOLS.filter((descriptor) => descriptor.platforms.includes(platform));
  for (const descriptor of tools) {
    const release = BUNDLED_MANAGED_TOOL_RELEASES.find(
      (candidate) => candidate.packageName === descriptor.packageName,
    );
    if (release === undefined) {
      throw new Error(`No bundled release is pinned for ${descriptor.tool}.`);
    }
    if (descriptor.shipInApp === false) continue;
    const staged = await stageManagedTool(
      descriptor,
      release,
      resolve(repositoryRoot, ".managed-tools", descriptor.tool),
      (url, signal) => boundedRegistryDownload(url, 256 * 1024 * 1024, signal),
      AbortSignal.timeout(300_000),
    );
    const target = join(destination, descriptor.tool);
    await mkdir(target, { recursive: true });
    await cp(staged.path, target, { recursive: true });
    // Attribution must ship with the vendored tree; a package whose tarball
    // carries no license file takes the copy checked in under
    // apps/desktop/resources/licenses instead.
    if (!existsSync(join(target, "LICENSE"))) {
      const checkedIn = resolve(
        repositoryRoot,
        "apps/desktop/resources/licenses",
        `${descriptor.tool}-LICENSE.md`,
      );
      if (existsSync(checkedIn)) {
        await copyFile(checkedIn, join(target, "LICENSE"));
      }
    }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  await prepareManagedTools(
    root,
    resolve(root, "apps/desktop/dist/managed-tools"),
    process.platform,
  );
}
