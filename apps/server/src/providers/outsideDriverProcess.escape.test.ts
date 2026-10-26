import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProviderInstanceId, type OutsideProviderDriverReference } from "@octant/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionSupervisor } from "../extensions/extensionSupervisor";
import { createNodeExtensionProcessPort } from "../extensions/nodeExtensionProcessPort";
import { OutsideDriverProcesses } from "./outsideDriverProcess";

/**
 * Escape tests for the outside driver profile, against a real Seatbelt
 * process. They need macOS and a Bun on the PATH, and skip everywhere else:
 * a Linux host never starts a driver (see `outsideDriverProcess.test.ts`), so
 * there is nothing to escape from there.
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
  readonly port: number;
}): string {
  return `
import { readFileSync, writeFileSync } from "node:fs";
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

onMacos("an outside driver's confined process", () => {
  let root = "";
  let server: Server | undefined;
  let connections = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "octant-driver-escape-"));
    server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("reaches no network, no file outside its package and folder, no program, and no host variable", async () => {
    const address = server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("expected a listening loopback server");
    }
    const packageRoot = join(root, "package");
    const outside = join(root, "outside");
    const temporaryRoot = join(root, "temporary");
    await Promise.all([packageRoot, outside, temporaryRoot].map((path) => mkdir(path)));
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "host secret");
    await writeFile(join(packageRoot, "own.txt"), "package file");
    const entryPoint = join(packageRoot, "main.mjs");
    await writeFile(entryPoint, escapeProbe({ packageRoot, secret, outside, port: address.port }));
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
      runtime: resolveBun(),
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
        },
      });
      expect(connections).toBe(0);
    } finally {
      delete process.env.OCTANT_ESCAPE_CANARY;
      await owner.stop(instanceId);
    }
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
});
