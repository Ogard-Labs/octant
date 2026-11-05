import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopIdentity, type DesktopIdentity } from "@octant/host-runtime";
import {
  appOutputContext,
  packagedServerEnvironment,
  spawnPackagedApplication,
  runBoundedCommand,
  stagePackagedAppBundle,
} from "./packaged-smoke-process";

import { validateDesktopRuntimeFuses } from "./desktop-client-runtime";
import { resolveDesktopNodeRuntime } from "../apps/desktop/src/runtimePaths";
import { DESKTOP_TERMINAL_SWITCH } from "../apps/desktop/src/desktopLaunch";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function packagedServerBundle(
  repositoryRootPath: string,
  identity: DesktopIdentity = desktopIdentity("stable"),
): string {
  return resolve(repositoryRootPath, "out", `${identity.productName}.app`);
}

export function packagedServerEntry(appBundle: string): string {
  return resolve(appBundle, "Contents/Resources/app/apps/server/dist/main.mjs");
}

export function packagedServerExecutable(
  appBundle: string,
  identity: DesktopIdentity = desktopIdentity("stable"),
): string {
  return resolve(appBundle, "Contents/MacOS", identity.productName);
}

async function waitForStorageReady(
  url: string,
  timeoutMs: number,
  outputTail: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      const body = (await response.json()) as Record<string, unknown>;
      if (
        response.ok &&
        body.product === "Octant" &&
        body.status === "ok" &&
        body.storage === "ready"
      ) {
        return;
      }
    } catch {
      // The packaged Node-mode server may still be binding, or it may have
      // already died on a missing import. The output tail names that.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Packaged Octant server was not storage-ready within ${timeoutMs}ms.${appOutputContext(outputTail)}`,
  );
}

export async function assertPackagedServerStarts(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly repositoryRoot: string;
  readonly identity?: DesktopIdentity;
}): Promise<void> {
  if (input.platform !== "darwin" || input.arch !== "arm64") {
    throw new Error("The packaged-server start check requires Apple Silicon macOS.");
  }
  const identity = input.identity ?? desktopIdentity("stable");
  const sourceBundle = packagedServerBundle(input.repositoryRoot, identity);
  if (!existsSync(sourceBundle)) {
    throw new Error(`Packaged ${identity.productName}.app is missing at ${sourceBundle}.`);
  }
  const appBundle = stagePackagedAppBundle(sourceBundle);
  const executable = packagedServerExecutable(appBundle, identity);
  if (identity.flavor === "nightly") {
    if (!existsSync(resolve(appBundle, "Contents/Resources/app.asar")))
      throw new Error("Nightly is missing its sealed application archive.");
    await validateDesktopRuntimeFuses(appBundle);
    const dataDirectory = await mkdtemp(resolve(tmpdir(), "octant-packaged-client-start."));
    try {
      const output = await runBoundedCommand(
        executable,
        [DESKTOP_TERMINAL_SWITCH, "mcp", "--help"],
        packagedServerEnvironment(process.env, dataDirectory),
        20_000,
      );
      if (!output.startsWith("octant mcp\n"))
        throw new Error("Nightly did not run its scoped terminal command.");
      if ((await readdir(dataDirectory)).length !== 0)
        throw new Error("Nightly's terminal command wrote host data.");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
    return;
  }
  const serverEntry = packagedServerEntry(appBundle);
  if (!existsSync(executable) || !existsSync(serverEntry)) {
    throw new Error("The packaged app is missing its Octant executable or server entry.");
  }
  const dataDirectory = await mkdtemp(resolve(tmpdir(), "octant-packaged-server-start."));
  const port = 13_776;
  const serverUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...packagedServerEnvironment(process.env, dataDirectory),
    ELECTRON_RUN_AS_NODE: "1",
    OCTANT_SERVER_PORT: String(port),
  };
  const { child, outputTail } = spawnPackagedApplication({
    executable: resolveDesktopNodeRuntime({
      packaged: true,
      platform: "darwin",
      resourcesPath: resolve(appBundle, "Contents/Resources"),
      execPath: executable,
    }),
    args: [serverEntry],
    env,
  });
  try {
    await waitForStorageReady(serverUrl, 20_000, outputTail);
  } finally {
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The process may already have exited on the missing import.
        }
      }
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await assertPackagedServerStarts({
    platform: process.platform,
    arch: process.arch,
    repositoryRoot,
    identity: desktopIdentity(process.env.OCTANT_PACKAGE_FLAVOR ?? "stable"),
  });
  console.log(
    process.env.OCTANT_PACKAGE_FLAVOR === "nightly"
      ? "Packaged Nightly scoped terminal command ran outside the checkout without host data."
      : "Packaged server started outside the checkout.",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
