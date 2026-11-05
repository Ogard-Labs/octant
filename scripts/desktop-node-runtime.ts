import { packager, type Options as PackagerOptions } from "@electron/packager";
import { mkdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  DESKTOP_NODE_RUNTIME_APP,
  DESKTOP_NODE_RUNTIME_BUNDLE_ID,
  DESKTOP_NODE_RUNTIME_NAME,
} from "../apps/desktop/src/runtimePaths";
import { validateNodeRuntimeFuses } from "./desktop-client-runtime";

/** This component executes approved scripts, so it must not identify a desktop main. */
export function createNodeRuntimePackagerOptions(input: {
  readonly stage: string;
  readonly out: string;
  readonly version: string;
  readonly electronVersion: string;
  readonly electronZipDir?: string;
}): PackagerOptions {
  return {
    dir: input.stage,
    out: input.out,
    appBundleId: DESKTOP_NODE_RUNTIME_BUNDLE_ID,
    appVersion: input.version,
    name: DESKTOP_NODE_RUNTIME_NAME,
    platform: "darwin",
    arch: "arm64",
    electronVersion: input.electronVersion,
    asar: false,
    prune: false,
    overwrite: true,
    extendInfo: { LSBackgroundOnly: true },
    ...(input.electronZipDir === undefined ? {} : { electronZipDir: input.electronZipDir }),
  };
}

export async function packageDesktopNodeRuntime(input: {
  readonly primaryApp: string;
  readonly temporaryRoot: string;
  readonly version: string;
  readonly electronVersion: string;
  readonly electronZipDir?: string;
}): Promise<string> {
  const stage = join(input.temporaryRoot, "stage");
  const out = join(input.temporaryRoot, "packager");
  await mkdir(stage, { recursive: true });
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: "@octant/desktop-node-runtime",
      version: input.version,
      main: "refuse.cjs",
    }),
  );
  // There is no second application here. Script execution requires explicit Node mode.
  await writeFile(join(stage, "refuse.cjs"), "require('electron').app.exit(1);\n");
  const directories = await packager(
    createNodeRuntimePackagerOptions({
      stage,
      out,
      version: input.version,
      electronVersion: input.electronVersion,
      ...(input.electronZipDir === undefined ? {} : { electronZipDir: input.electronZipDir }),
    }),
  );
  const directory = directories[0];
  if (directories.length !== 1 || directory === undefined)
    throw new Error("Expected one standalone worker runtime.");
  const runtime = join(input.primaryApp, DESKTOP_NODE_RUNTIME_APP);
  await rename(join(directory, `${DESKTOP_NODE_RUNTIME_NAME}.app`), runtime);
  await validateRuntimeFrameworkIndependence(input.primaryApp, runtime);
  await validateNodeRuntimeFuses(runtime);
  await rm(input.temporaryRoot, { recursive: true, force: true });
  return runtime;
}

/** Fuse writes must never follow an escaped link or mutate the other executable's Framework. */
export async function validateRuntimeFrameworkIndependence(
  primaryApp: string,
  runtimeApp: string,
): Promise<void> {
  const framework = "Contents/Frameworks/Electron Framework.framework";
  const inspect = async (app: string) => {
    const root = await realpath(app);
    const directory = join(root, framework);
    const binary = await realpath(join(directory, "Electron Framework"));
    if (!binary.startsWith(`${directory}${sep}`))
      throw new Error("Runtime Framework escapes its own bundle.");
    for (const path of ["Electron Framework", "Versions/Current"]) {
      const target = await readlink(join(directory, path));
      if (resolve(target) === target) throw new Error("Runtime Framework has an absolute symlink.");
    }
    return { binary, metadata: await stat(binary) };
  };
  const primary = await inspect(primaryApp);
  const runtime = await inspect(runtimeApp);
  if (
    primary.binary === runtime.binary ||
    (primary.metadata.dev === runtime.metadata.dev && primary.metadata.ino === runtime.metadata.ino)
  ) {
    throw new Error("Desktop and worker runtime share Framework fuse bytes.");
  }
}
