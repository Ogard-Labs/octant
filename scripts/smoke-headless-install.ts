import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostHeadlessTarget } from "./package-headless";

// Installs a built headless artifact into an empty prefix and drives the
// installed `octant` through `server start`, `server status` and
// `server stop`. The prefix has no repository checkout and no node_modules
// above it, so the installed CLI and server can only load what the artifact
// itself carries.
//
// `server start` installs the per-user service (systemd `octant.service` or
// launchd `app.octant.server`). The smoke refuses to run when that descriptor
// already exists, so it never replaces a host someone else installed, and it
// removes the descriptor it wrote when it finishes.

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMMAND_TIMEOUT_MS = 90_000;

/** The nearest directory at or above `path` that holds a node_modules entry. */
export function findNodeModulesAncestor(
  path: string,
  exists: (candidate: string) => boolean = existsSync,
): string | undefined {
  let directory = resolve(path);
  while (true) {
    if (exists(join(directory, "node_modules"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Where `octant server start` writes the per-user service descriptor. */
export function serviceDescriptorPath(platform: NodeJS.Platform, home: string): string {
  return platform === "darwin"
    ? join(home, "Library", "LaunchAgents", "app.octant.server.plist")
    : join(home, ".config", "systemd", "user", "octant.service");
}

/**
 * The installed CLI's environment: nothing from the caller's shell that could
 * point module resolution back at a checkout, only what the service manager
 * and the Bun runtime need.
 */
export function installedCliEnvironment(input: {
  readonly source: Readonly<Record<string, string | undefined>>;
  readonly bunDirectory: string;
  readonly dataDirectory: string;
  readonly port: number;
}): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: input.source.HOME ?? homedir(),
    PATH: `${input.bunDirectory}:/usr/bin:/bin`,
    OCTANT_DATA_DIR: input.dataDirectory,
    OCTANT_SERVER_PORT: String(input.port),
  };
  for (const key of ["USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const) {
    const value = input.source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

interface CommandResult {
  readonly code: number;
  readonly output: string;
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> },
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4_000_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolvePromise({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

async function expectSuccess(label: string, result: CommandResult): Promise<void> {
  process.stdout.write(`$ ${label}\n${result.output.trimEnd()}\n(exit ${result.code})\n`);
  if (result.code !== 0) throw new Error(`${label} exited with ${result.code}.`);
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") resolvePromise(address.port);
        else reject(new Error("No loopback port was available."));
      });
    });
  });
}

function defaultTarball(): string {
  const target = hostHeadlessTarget();
  if (target === undefined) throw new Error("This host has no headless artifact target.");
  const directory = resolve(repositoryRoot, "out", "headless");
  const suffix = `-${target.platform}-${target.arch}.tar.gz`;
  const candidates = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.startsWith("octant-") && name.endsWith(suffix))
        .map((name) => join(directory, name))
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    : [];
  const newest = candidates[0];
  if (newest === undefined) {
    throw new Error(`No ${suffix} artifact in out/headless. Run bun scripts/package-headless.ts.`);
  }
  return newest;
}

function parseArguments(argv: readonly string[]): {
  readonly tarball?: string;
  readonly prefix?: string;
} {
  const parsed: { tarball?: string; prefix?: string } = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || (flag !== "--tarball" && flag !== "--prefix")) {
      throw new Error("Usage: smoke-headless-install.ts [--tarball <path>] [--prefix <empty dir>]");
    }
    if (flag === "--tarball") parsed.tarball = resolve(value);
    else parsed.prefix = resolve(value);
  }
  return parsed;
}

async function smokeHeadlessInstall(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv);
  const tarball = options.tarball ?? defaultTarball();
  const prefix = options.prefix ?? (await mkdtemp(join(tmpdir(), "octant-headless-smoke-")));
  await mkdir(prefix, { recursive: true });
  if ((await readdir(prefix)).length > 0) throw new Error(`${prefix} is not empty.`);
  const nodeModulesAncestor = findNodeModulesAncestor(prefix);
  if (nodeModulesAncestor !== undefined) {
    throw new Error(`${nodeModulesAncestor} has a node_modules directory; choose another prefix.`);
  }
  const descriptor = serviceDescriptorPath(process.platform, homedir());
  if (existsSync(descriptor)) {
    throw new Error(`${descriptor} already exists; refusing to replace another Octant service.`);
  }

  const bunDirectory = dirname(Bun.which("bun") ?? process.execPath);
  const port = await freePort();
  const env = installedCliEnvironment({
    source: process.env,
    bunDirectory,
    dataDirectory: join(prefix, "data"),
    port,
  });
  const extracted = join(prefix, "artifact");
  await mkdir(extracted);
  await expectSuccess(
    `tar -xzf ${tarball}`,
    await run("tar", ["-xzf", tarball, "-C", extracted], { cwd: prefix, env }),
  );
  const [artifactName] = await readdir(extracted);
  if (artifactName === undefined) throw new Error("The tarball held no artifact directory.");
  const artifactRoot = join(extracted, artifactName);
  const installRoot = join(prefix, "install");
  const installed = join(installRoot, "current", "bin", "octant");

  await expectSuccess(
    "octant server install",
    await run(
      join(artifactRoot, "bin", "octant"),
      ["server", "install", "--artifact", artifactRoot, "--install-root", installRoot],
      { cwd: prefix, env },
    ),
  );

  // Until stop has run, the finally block stops whatever start left running.
  let started = true;
  try {
    await expectSuccess(
      "octant server start",
      await run(installed, ["server", "start"], { cwd: prefix, env }),
    );
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      readonly status?: string;
      readonly storage?: string;
    };
    if (health.status !== "ok" || health.storage !== "ready") {
      throw new Error(`The installed host is not ready: ${JSON.stringify(health)}.`);
    }
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    if (!page.includes("<html")) throw new Error("The installed host did not serve its web app.");
    process.stdout.write(`health and web app served on 127.0.0.1:${port}\n`);
    await expectSuccess(
      "octant server status",
      await run(installed, ["server", "status"], { cwd: prefix, env }),
    );
    await expectSuccess(
      "octant server stop",
      await run(installed, ["server", "stop"], { cwd: prefix, env }),
    );
    started = false;
    // The stop acknowledgment can arrive before the listener has closed.
    let answering = true;
    for (let attempt = 0; attempt < 20 && answering; attempt += 1) {
      answering = await fetch(`http://127.0.0.1:${port}/health`).then(
        () => true,
        () => false,
      );
      if (answering) await Bun.sleep(250);
    }
    if (answering) throw new Error("The host still answers after server stop.");
  } finally {
    if (started) await run(installed, ["server", "stop"], { cwd: prefix, env });
    await removeServiceDescriptor(descriptor, env, prefix);
  }
  process.stdout.write(`Headless install smoke passed in ${prefix}.\n`);
}

async function removeServiceDescriptor(
  descriptor: string,
  env: Record<string, string>,
  cwd: string,
): Promise<void> {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    await run("/bin/launchctl", ["bootout", `gui/${uid}/app.octant.server`], { cwd, env });
    await rm(descriptor, { force: true });
    return;
  }
  await rm(descriptor, { force: true });
  await run("/usr/bin/systemctl", ["--user", "daemon-reload"], { cwd, env });
  await run("/usr/bin/systemctl", ["--user", "reset-failed", "octant.service"], { cwd, env });
}

if (import.meta.main) {
  await smokeHeadlessInstall(process.argv.slice(2));
}
