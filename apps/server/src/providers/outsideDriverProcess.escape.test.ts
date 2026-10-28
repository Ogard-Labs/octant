import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeProviderInstanceId, type OutsideProviderDriverReference } from "@octant/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionSupervisor, type OutsideDriverRuntime } from "../extensions/extensionSupervisor";
import { createNodeExtensionProcessPort } from "../extensions/nodeExtensionProcessPort";
import { OutsideDriverProcesses } from "./outsideDriverProcess";

/**
 * Escape tests for the outside driver profile, against a real Seatbelt
 * process, on each runtime a driver runs on: Bun, and Electron's Node when
 * its binary is present. They need macOS and a Bun on the PATH, and skip
 * everywhere else: a Linux host never starts a driver (see
 * `outsideDriverProcess.test.ts`), so there is nothing to escape from there.
 */
const onMacos = process.platform === "darwin" ? describe : describe.skip;

const instanceId = decodeProviderInstanceId("82000000-0000-4000-8000-000000000a01");
const driver = {
  extensionId: "82000000-0000-4000-8000-000000000001",
  packageId: "82000000-0000-4000-8000-000000000002",
  componentId: "driver",
  version: "0.1.0",
  digest: `sha256:${"c".repeat(64)}`,
} as OutsideProviderDriverReference;

interface EscapeOutcome {
  readonly readPackage: string;
  readonly readOutside: string;
  readonly readHome: string;
  readonly readHomeThroughDataVolume: string;
  readonly readKeychains: string;
  readonly writeTemporary: string;
  readonly writePackage: string;
  readonly writeOutside: string;
  readonly exec: string;
  readonly network: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** A driver entry that tries each way out and reports what it reached on one line. */
function escapeProbe(paths: {
  readonly packageRoot: string;
  readonly secret: string;
  readonly outside: string;
  readonly home: string;
  readonly homeCanaryThroughDataVolume: string;
  readonly port: number;
}): string {
  return `
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
const paths = ${JSON.stringify(paths)};
const attempt = (action) => {
  try {
    action();
    return "allowed";
  } catch {
    return "refused";
  }
};
const network = await new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port: paths.port });
  socket.once("connect", () => {
    socket.destroy();
    resolve("allowed");
  });
  socket.once("error", () => resolve("refused"));
  setTimeout(() => resolve("refused"), 3000);
});
let exec = "refused";
try {
  const result = spawnSync("/bin/echo", ["escaped"]);
  if (result.error === undefined && result.status === 0) exec = "allowed";
} catch {}
const outcome = {
  readPackage: attempt(() => readFileSync(join(paths.packageRoot, "own.txt"))),
  readOutside: attempt(() => readFileSync(paths.secret)),
  readHome: attempt(() => readdirSync(paths.home)),
  readHomeThroughDataVolume: attempt(() => readFileSync(paths.homeCanaryThroughDataVolume)),
  readKeychains: attempt(() => readdirSync(join(paths.home, "Library", "Keychains"))),
  writeTemporary: attempt(() => writeFileSync(join(process.env.TMPDIR, "scratch"), "ok")),
  writePackage: attempt(() => writeFileSync(join(paths.packageRoot, "planted"), "x")),
  writeOutside: attempt(() => writeFileSync(join(paths.outside, "planted"), "x")),
  exec,
  network,
  environment: { ...process.env },
};
process.stdout.write(JSON.stringify(outcome) + "\\n");
setInterval(() => undefined, 1000);
`;
}

/** The Bun a driver runs on: this runtime when it is Bun, else the one on the PATH. */
function resolveBun(): string {
  if (process.versions.bun !== undefined) return process.execPath;
  return execFileSync("/usr/bin/env", ["bun", "-e", "process.stdout.write(process.execPath)"], {
    encoding: "utf8",
  });
}

/**
 * The Electron the desktop app ships, which the packaged app's server and its
 * drivers run on as Node. Its binary arrives only when `electron/install.js`
 * runs (the `macos-15` CI job runs it before these tests), so without it the
 * Electron case skips rather than downloading here.
 */
function resolveElectron(): string | undefined {
  try {
    const packageRoot = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
    const relativeBinary = readFileSync(join(packageRoot, "path.txt"), "utf8").trim();
    const binary = join(packageRoot, "dist", relativeBinary);
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

const electron = process.platform === "darwin" ? resolveElectron() : undefined;

/**
 * Where macOS mounts the data volume. The person's files live on it, and each
 * folder the system volume links there (`/Users`, `/private`, `/opt`, ...) can
 * also be spelled beneath it, inside the `/System` the driver may read.
 */
const DATA_VOLUME = "/System/Volumes/Data";

onMacos("an outside driver's confined process", () => {
  let root = "";
  let server: Server | undefined;
  let connections = 0;
  let homeCanaryFolder = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "octant-driver-escape-"));
    // A file in the person's home, which the driver must not reach by any
    // spelling of its path.
    homeCanaryFolder = await mkdtemp(join(realpathSync(homedir()), ".octant-driver-escape-"));
    await writeFile(join(homeCanaryFolder, "canary.txt"), "home canary");
    server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    // The canary goes first: it sits in the person's real home, and a
    // set-up that failed before the server existed left nothing to close,
    // which waited out the hook's timeout with the canary still there.
    if (homeCanaryFolder !== "") await rm(homeCanaryFolder, { recursive: true, force: true });
    await new Promise<void>((resolve) =>
      server === undefined ? resolve() : server.close(() => resolve()),
    );
    await rm(root, { recursive: true, force: true });
  });

  async function expectConfined(runtime: OutsideDriverRuntime): Promise<void> {
    const address = server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("expected a listening loopback server");
    }
    const runtimeRoot = join(root, runtime.kind);
    const packageRoot = join(runtimeRoot, "package");
    const outside = join(runtimeRoot, "outside");
    const temporaryRoot = join(runtimeRoot, "temporary");
    await Promise.all(
      [packageRoot, outside, temporaryRoot].map((path) => mkdir(path, { recursive: true })),
    );
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "host secret");
    await writeFile(join(packageRoot, "own.txt"), "package file");
    const homeCanaryThroughDataVolume = `${DATA_VOLUME}${join(homeCanaryFolder, "canary.txt")}`;
    // The host itself reads the canary by that spelling, so a refusal below
    // is the profile's and not a path that leads nowhere.
    expect(readFileSync(homeCanaryThroughDataVolume, "utf8")).toBe("home canary");
    const entryPoint = join(packageRoot, "main.mjs");
    await writeFile(
      entryPoint,
      escapeProbe({
        packageRoot,
        secret,
        outside,
        home: homedir(),
        homeCanaryThroughDataVolume,
        port: address.port,
      }),
    );
    const connectionsBefore = connections;
    // A variable the server holds must not reach the driver.
    process.env.OCTANT_ESCAPE_CANARY = "sk-host-canary";
    const supervisor = new ExtensionSupervisor({
      process: createNodeExtensionProcessPort({ shutdownTimeoutMs: 1_000 }),
      clock: () => new Date().toISOString(),
      authorizeLaunch: async () => true,
    });
    const owner = new OutsideDriverProcesses({
      supervisor,
      platform: process.platform,
      runtime,
      temporaryRoot,
    });
    const start = await owner.start({ instanceId, driver, packageRoot, entryPoint });
    if (start.status !== "started") throw new Error(`The driver was refused: ${start.reason}.`);
    const lines: Array<string> = [];
    start.channel.onLine((line) => lines.push(line));

    try {
      await vi.waitFor(() => expect(lines).toHaveLength(1), { timeout: 20_000 });
      const outcome = JSON.parse(lines[0] ?? "{}") as EscapeOutcome;
      const [temporaryDirectory] = await readdir(temporaryRoot);
      const ownFolder = join(temporaryRoot, temporaryDirectory ?? "");
      expect(outcome).toEqual({
        readPackage: "allowed",
        readOutside: "refused",
        readHome: "refused",
        readHomeThroughDataVolume: "refused",
        readKeychains: "refused",
        writeTemporary: "allowed",
        writePackage: "refused",
        writeOutside: "refused",
        exec: "refused",
        network: "refused",
        environment: {
          PATH: "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          HOME: ownFolder,
          TMPDIR: ownFolder,
          ...(runtime.kind === "electron-node" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
      });
      expect(connections).toBe(connectionsBefore);
    } finally {
      delete process.env.OCTANT_ESCAPE_CANARY;
      await owner.stop(instanceId);
    }
    expect(await readdir(temporaryRoot)).toEqual([]);
  }

  it("reaches no network, no file outside its package and folder, not the home folder by either spelling or its keychains, no program, and no host variable", async () => {
    await expectConfined({ kind: "bun", path: resolveBun() });
  });

  it.skipIf(electron === undefined)(
    "reaches none of them on Electron's Node either, the runtime the packaged app runs drivers on",
    async () => {
      if (electron === undefined) throw new Error("expected the Electron binary");
      await expectConfined({ kind: "electron-node", path: electron });
    },
  );
});
