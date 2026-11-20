import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddedAcpAgentConfiguration } from "@octant/contracts";
import type { AcpRegistryAgent } from "@octant/plugin-host/acp-agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeProcessConfinementLive,
  ProcessConfinementError,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";
import {
  hasPendingAcpAgentInstallScripts,
  installAcpAgent,
  makeAcpAgentInstallPorts,
  runAcpAgentInstallScripts,
  toolchainReadRoots,
  type AcpAgentInstallPorts,
} from "./acpAgentInstall";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-acp-install-"));
  directories.push(directory);
  return directory;
}

const agentBytes = Buffer.from("#!/bin/sh\necho agent\n");
const agentSha256 = createHash("sha256").update(agentBytes).digest("hex");

function listing(
  distribution: Partial<Extract<AcpRegistryAgent["distribution"], { kind: "binary" }>> = {},
): AcpRegistryAgent {
  return {
    registryId: "example-agent",
    name: "Example agent",
    version: "1.0.0",
    distribution: {
      kind: "binary",
      archive: "https://downloads.example/agent",
      command: "agent",
      args: ["acp"],
      ...distribution,
    },
    unreviewedBecause: "Test agent.",
  };
}

const registryConfiguration: AddedAcpAgentConfiguration = {
  kind: "acp-agent",
  source: {
    kind: "registry",
    registryId: "example-agent",
    version: "1.0.0",
    distribution: "binary",
  },
  args: ["acp"],
  trusted: false,
};

function ports(body: Buffer, overrides: Partial<AcpAgentInstallPorts> = {}): AcpAgentInstallPorts {
  return {
    fetch: vi.fn(async (url: string) => {
      const response = new Response(new Uint8Array(body), { status: 200 });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }),
    run: vi.fn(async () => ({ exitCode: 0 })),
    findExecutable: async () => undefined,
    fetchesAllowed: () => true,
    ...overrides,
  };
}

describe("installing an added ACP agent", () => {
  it("installs a download whose checksum matches the registry's, and runs nothing it fetched", async () => {
    const root = scratch();
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const result = await installAcpAgent(
      { configuration: registryConfiguration, listing: listing({ sha256: agentSha256 }), root },
      ports(agentBytes, { run }),
    );
    expect(result).toMatchObject({ status: "installed", integrity: "sha256-verified" });
    if (result.status !== "installed") return;
    expect(result.executable.startsWith(root)).toBe(true);
    expect(readFileSync(result.executable)).toEqual(agentBytes);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a download that does not match the registry's checksum and leaves nothing on disk", async () => {
    const root = scratch();
    const result = await installAcpAgent(
      { configuration: registryConfiguration, listing: listing({ sha256: "0".repeat(64) }), root },
      ports(agentBytes),
    );
    expect(result).toMatchObject({ status: "refused", reason: "checksum-mismatch" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a download it cannot write to disk and leaves nothing behind", async () => {
    const root = scratch();
    const result = await installAcpAgent(
      { configuration: registryConfiguration, listing: listing(), root },
      ports(agentBytes, {
        // A folder where the download goes makes the write fail asynchronously,
        // as a full disk does.
        fetch: async (url: string) => {
          for (const entry of readdirSync(root)) mkdirSync(join(root, entry, ".download"));
          const response = new Response(new Uint8Array(agentBytes), { status: 200 });
          Object.defineProperty(response, "url", { value: url });
          return response;
        },
      }),
    );
    expect(result).toMatchObject({ status: "refused", reason: "write-failed" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("marks a download the registry lists no checksum for as unverified", async () => {
    const result = await installAcpAgent(
      { configuration: registryConfiguration, listing: listing(), root: scratch() },
      ports(agentBytes),
    );
    expect(result).toMatchObject({ status: "installed", integrity: "unverified-download" });
  });

  it("downloads only over HTTPS, a redirect included", async () => {
    const plain = await installAcpAgent(
      {
        configuration: registryConfiguration,
        listing: listing({ archive: "http://downloads.example/agent" }),
        root: scratch(),
      },
      ports(agentBytes),
    );
    expect(plain).toMatchObject({ status: "refused", reason: "not-https" });

    const redirected = await installAcpAgent(
      { configuration: registryConfiguration, listing: listing(), root: scratch() },
      ports(agentBytes, {
        fetch: async () => {
          const response = new Response(new Uint8Array(agentBytes), { status: 200 });
          Object.defineProperty(response, "url", { value: "http://mirror.example/agent" });
          return response;
        },
      }),
    );
    expect(redirected).toMatchObject({ status: "refused", reason: "not-https" });
  });

  it("downloads nothing with Marketplace fetches off, or for a release the listing no longer pins", async () => {
    const fetch = vi.fn();
    const off = await installAcpAgent(
      { configuration: registryConfiguration, listing: listing(), root: scratch() },
      ports(agentBytes, { fetch, fetchesAllowed: () => false }),
    );
    expect(off).toMatchObject({ status: "refused", reason: "fetches-off" });
    const moved = await installAcpAgent(
      {
        configuration: registryConfiguration,
        listing: { ...listing(), version: "2.0.0" },
        root: scratch(),
      },
      ports(agentBytes, { fetch }),
    );
    expect(moved).toMatchObject({ status: "refused", reason: "not-listed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an archive with an entry that climbs out of its folder", async () => {
    const work = scratch();
    mkdirSync(join(work, "inside"));
    writeFileSync(join(work, "escape"), "x");
    const archive = join(work, "agent.tar.gz");
    execFileSync("tar", ["-czPf", archive, "../escape"], { cwd: join(work, "inside") });
    const result = await installAcpAgent(
      {
        configuration: registryConfiguration,
        listing: listing({ archive: "https://downloads.example/agent.tar.gz" }),
        root: scratch(),
      },
      ports(readFileSync(archive)),
    );
    expect(result).toMatchObject({ status: "refused", reason: "unsafe-archive" });
  });

  it("unpacks a tarball and finds the command inside it", async () => {
    const work = scratch();
    mkdirSync(join(work, "bin"));
    writeFileSync(join(work, "bin", "agent"), agentBytes);
    chmodSync(join(work, "bin", "agent"), 0o755);
    const archive = join(work, "agent.tar.gz");
    execFileSync("tar", ["-czf", archive, "bin"], { cwd: work });
    const result = await installAcpAgent(
      {
        configuration: registryConfiguration,
        listing: listing({
          archive: "https://downloads.example/agent.tar.gz",
          command: "bin/agent",
        }),
        root: scratch(),
      },
      ports(readFileSync(archive)),
    );
    expect(result).toMatchObject({ status: "installed", integrity: "unverified-download" });
  });

  it("installs an npm release with install scripts off, at its exact version", async () => {
    const root = scratch();
    const run = vi.fn(
      async (
        _npm: string,
        args: ReadonlyArray<string>,
        _options: { readonly env: Readonly<Record<string, string>> },
      ) => {
        const prefix = args[args.indexOf("--prefix") + 1] ?? "";
        const packageDirectory = join(prefix, "node_modules", "@scope", "agent");
        mkdirSync(packageDirectory, { recursive: true });
        writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ bin: "cli.js" }));
        writeFileSync(join(packageDirectory, "cli.js"), agentBytes);
        chmodSync(join(packageDirectory, "cli.js"), 0o755);
        mkdirSync(join(prefix, "node_modules", ".bin"));
        execFileSync("ln", [
          "-s",
          "../@scope/agent/cli.js",
          join(prefix, "node_modules", ".bin", "agent"),
        ]);
        return { exitCode: 0 };
      },
    );
    const result = await installAcpAgent(
      {
        configuration: {
          ...registryConfiguration,
          source: {
            kind: "registry",
            registryId: "example-agent",
            version: "1.0.0",
            distribution: "npx",
          },
        },
        listing: {
          ...listing(),
          distribution: { kind: "npx", package: "@scope/agent", version: "1.0.0", args: ["--acp"] },
        },
        root,
      },
      ports(agentBytes, { run, findExecutable: async () => "/usr/bin/npm" }),
    );
    expect(result).toMatchObject({
      status: "installed",
      integrity: "package-manager",
      hasInstallScripts: false,
    });
    const [, args, options] = run.mock.calls[0] ?? [];
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("@scope/agent@1.0.0");
    expect(options?.env.npm_config_ignore_scripts).toBe("true");
  });

  it("keeps install scripts off during Install and records when an installed npm package declares a postinstall script", async () => {
    const root = scratch();
    const marker = join(root, "ran-during-install");
    const run = vi.fn(
      async (
        _npm: string,
        args: ReadonlyArray<string>,
        _options: { readonly env: Readonly<Record<string, string>> },
      ) => {
        const prefix = args[args.indexOf("--prefix") + 1] ?? "";
        const packageDirectory = join(prefix, "node_modules", "droid");
        mkdirSync(packageDirectory, { recursive: true });
        writeFileSync(
          join(packageDirectory, "package.json"),
          JSON.stringify({
            name: "droid",
            version: "1.12.1",
            bin: "cli.js",
            scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}', 'ran')"` },
          }),
        );
        writeFileSync(join(packageDirectory, "cli.js"), agentBytes);
        chmodSync(join(packageDirectory, "cli.js"), 0o755);
        mkdirSync(join(prefix, "node_modules", ".bin"));
        execFileSync("ln", [
          "-s",
          "../droid/cli.js",
          join(prefix, "node_modules", ".bin", "droid"),
        ]);
        return { exitCode: 0 };
      },
    );
    const result = await installAcpAgent(
      {
        configuration: {
          ...registryConfiguration,
          source: {
            kind: "registry",
            registryId: "factory-droid",
            version: "1.12.1",
            distribution: "npx",
          },
        },
        listing: {
          ...listing(),
          registryId: "factory-droid",
          version: "1.12.1",
          distribution: { kind: "npx", package: "droid", version: "1.12.1", args: [] },
        },
        root,
      },
      ports(agentBytes, { run, findExecutable: async () => "/usr/bin/npm" }),
    );
    expect(result).toMatchObject({
      status: "installed",
      integrity: "package-manager",
      hasInstallScripts: true,
    });
    expect(existsSync(marker)).toBe(false);
    const [, args, options] = run.mock.calls[0] ?? [];
    expect(args).toContain("--ignore-scripts");
    expect(options?.env.npm_config_ignore_scripts).toBe("true");
  });

  it("checks a local command is an executable file and fetches nothing", async () => {
    const work = scratch();
    const command = join(work, "agent");
    writeFileSync(command, agentBytes);
    chmodSync(command, 0o755);
    const fetch = vi.fn();
    const local: AddedAcpAgentConfiguration = {
      kind: "acp-agent",
      source: { kind: "local", command },
      args: [],
      trusted: false,
    };
    await expect(
      installAcpAgent(
        { configuration: local, listing: undefined, root: scratch() },
        ports(agentBytes, { fetch }),
      ),
    ).resolves.toEqual({ status: "installed", executable: command, integrity: "local-command" });
    await expect(
      installAcpAgent(
        {
          configuration: { ...local, source: { kind: "local", command: join(work, "missing") } },
          listing: undefined,
          root: scratch(),
        },
        ports(agentBytes, { fetch }),
      ),
    ).resolves.toMatchObject({ status: "refused", reason: "executable-missing" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function createInstalledNpmPrefix(
  root: string,
  options: { readonly postinstall?: string; readonly version?: string } = {},
): {
  readonly folder: string;
  readonly executable: string;
  readonly configuration: AddedAcpAgentConfiguration;
} {
  const version = options.version ?? "1.12.1";
  const folder = join(root, `${version}-abcd1234`);
  const packageDirectory = join(folder, "node_modules", "droid");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({ name: "acp-install", dependencies: { droid: version } }),
  );
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "droid",
      version,
      bin: { droid: "cli.js" },
      ...(options.postinstall === undefined
        ? {}
        : { scripts: { postinstall: options.postinstall } }),
    }),
  );
  writeFileSync(join(packageDirectory, "cli.js"), agentBytes);
  chmodSync(join(packageDirectory, "cli.js"), 0o755);
  mkdirSync(join(folder, "node_modules", ".bin"), { recursive: true });
  const executable = join(folder, "node_modules", ".bin", "droid");
  execFileSync("ln", ["-s", "../droid/cli.js", executable]);
  return {
    folder,
    executable,
    configuration: {
      kind: "acp-agent",
      source: {
        kind: "registry",
        registryId: "factory-droid",
        version,
        distribution: "npx",
      },
      args: ["exec"],
      install: {
        executable,
        integrity: "package-manager",
        hasInstallScripts: options.postinstall !== undefined,
      },
      trusted: false,
    },
  };
}

describe("running ACP package install scripts on Trust", () => {
  it("runs install scripts outside Strict without Octant's sandbox", async () => {
    const root = scratch();
    const installed = createInstalledNpmPrefix(root, { postinstall: "echo ok" });
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const prepare = vi.fn();
    const confinement: ProcessConfinementPort = { prepare };
    const result = await runAcpAgentInstallScripts(
      { configuration: installed.configuration, root, strict: false },
      {
        findExecutable: async (name) => (name === "npm" ? "/usr/bin/npm" : undefined),
        run,
        confinement,
        clock: () => "2026-11-19T12:00:00.000Z",
      },
    );
    expect(result).toEqual({
      status: "completed",
      sandboxed: false,
      completedAt: "2026-11-19T12:00:00.000Z",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/npm",
      ["rebuild", "--prefix", realpathSync(installed.folder), "--ignore-scripts=false"],
      expect.objectContaining({
        cwd: realpathSync(installed.folder),
        env: expect.objectContaining({ npm_config_ignore_scripts: "false" }),
      }),
    );
  });

  it("runs install scripts under Strict inside Octant's sandbox with writes limited to the agent's install folder", async () => {
    const root = scratch();
    const installed = createInstalledNpmPrefix(root, { postinstall: "echo ok" });
    const canonicalFolder = realpathSync(installed.folder);
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const prepare = vi.fn((input) => ({
      command: "/usr/bin/sandbox-exec",
      args: ["-p", "(version 1)", input.executable, ...input.args],
      environment: { OCTANT_CONFINED: "1" },
    }));
    const result = await runAcpAgentInstallScripts(
      { configuration: installed.configuration, root, strict: true },
      {
        findExecutable: async (name) => (name === "npm" ? "/usr/bin/npm" : "/usr/bin/node"),
        run,
        confinement: { prepare },
        clock: () => "2026-11-19T12:00:00.000Z",
      },
    );
    expect(result).toEqual({
      status: "completed",
      sandboxed: true,
      completedAt: "2026-11-19T12:00:00.000Z",
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "/usr/bin/npm",
        boundRoot: canonicalFolder,
        temporaryDirectory: join(canonicalFolder, ".octant-install-tmp"),
        writeBoundRoot: true,
      }),
    );
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/sandbox-exec",
      expect.arrayContaining(["/usr/bin/npm", "rebuild", "--prefix", canonicalFolder]),
      expect.objectContaining({
        cwd: canonicalFolder,
        env: expect.objectContaining({
          HOME: join(canonicalFolder, ".octant-install-tmp"),
          TMPDIR: join(canonicalFolder, ".octant-install-tmp"),
          npm_config_cache: join(canonicalFolder, ".octant-npm-cache"),
          OCTANT_CONFINED: "1",
        }),
      }),
    );
    expect(existsSync(join(canonicalFolder, ".octant-install-tmp"))).toBe(false);
    expect(existsSync(join(canonicalFolder, ".octant-npm-cache"))).toBe(false);
  });

  it("treats local commands, binary downloads and packages with no install script as clean no-ops", async () => {
    const root = scratch();
    const noScript = createInstalledNpmPrefix(root);
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const findExecutable = vi.fn(async () => "/usr/bin/npm");

    await expect(
      runAcpAgentInstallScripts(
        { configuration: noScript.configuration, root, strict: true },
        { findExecutable, run },
      ),
    ).resolves.toEqual({ status: "not-needed" });

    await expect(
      runAcpAgentInstallScripts(
        {
          configuration: {
            kind: "acp-agent",
            source: { kind: "local", command: "/opt/agent" },
            args: [],
            install: { executable: "/opt/agent", integrity: "local-command" },
            trusted: false,
          },
          root,
          strict: true,
        },
        { findExecutable, run },
      ),
    ).resolves.toEqual({ status: "not-needed" });

    await expect(
      runAcpAgentInstallScripts(
        {
          configuration: {
            ...registryConfiguration,
            install: { executable: join(root, "agent"), integrity: "sha256-verified" },
          },
          root,
          strict: true,
        },
        { findExecutable, run },
      ),
    ).resolves.toEqual({ status: "not-needed" });

    expect(run).not.toHaveBeenCalled();
  });

  it("returns a typed failure value when the install script fails, times out, or Strict confinement is unavailable", async () => {
    const root = scratch();
    const installed = createInstalledNpmPrefix(root, { postinstall: "exit 1" });
    const clock = () => "2026-11-19T12:00:00.000Z";

    await expect(
      runAcpAgentInstallScripts(
        { configuration: installed.configuration, root, strict: false },
        {
          findExecutable: async () => "/usr/bin/npm",
          run: async () => ({ exitCode: 1 }),
          clock,
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      sandboxed: false,
      reason: "script-failed",
      completedAt: "2026-11-19T12:00:00.000Z",
    });

    await expect(
      runAcpAgentInstallScripts(
        { configuration: installed.configuration, root, strict: false },
        {
          findExecutable: async () => "/usr/bin/npm",
          run: async () => ({ exitCode: null, timedOut: true }),
          clock,
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      sandboxed: false,
      reason: "timed-out",
    });

    await expect(
      runAcpAgentInstallScripts(
        { configuration: installed.configuration, root, strict: true },
        {
          findExecutable: async () => "/usr/bin/npm",
          run: async () => ({ exitCode: 0 }),
          confinement: {
            prepare: () => {
              throw new ProcessConfinementError("incompatible", "no sandbox");
            },
          },
          clock,
        },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      sandboxed: true,
      reason: "sandbox-unavailable",
    });
  });

  it("detects pending install scripts even for an earlier install record that omitted hasInstallScripts", async () => {
    const root = scratch();
    const installed = createInstalledNpmPrefix(root, { postinstall: "echo download" });
    const legacyConfig: AddedAcpAgentConfiguration = {
      ...installed.configuration,
      install: {
        executable: installed.executable,
        integrity: "package-manager",
      },
    };
    await expect(
      hasPendingAcpAgentInstallScripts({ configuration: legacyConfig, root }),
    ).resolves.toBe(true);
    await expect(
      hasPendingAcpAgentInstallScripts({
        configuration: { ...legacyConfig, trusted: true },
        root,
      }),
    ).resolves.toBe(false);
  });

  it.skipIf(process.platform !== "darwin")(
    "enforces macOS Seatbelt writes inside the install folder only under Strict and runs natively outside Strict",
    async () => {
      const root = scratch();
      const outside = join(realpathSync(scratch()), "escaped.txt");
      const livePorts = makeAcpAgentInstallPorts({
        fetchesAllowed: () => true,
        confinement: makeProcessConfinementLive(),
      });
      // Under Strict, writing inside the install folder succeeds while writing
      // outside the install folder is denied by macOS Seatbelt.
      const strictInstall = createInstalledNpmPrefix(root, {
        postinstall: "node postinstall.js",
      });
      writeFileSync(
        join(strictInstall.folder, "node_modules", "droid", "postinstall.js"),
        `const fs = require("node:fs");
fs.writeFileSync("inside.txt", "ok");
let escaped = false;
try {
  fs.writeFileSync(${JSON.stringify(outside)}, "nope");
  escaped = true;
} catch {
  escaped = false;
}
if (escaped) process.exit(2);
`,
      );
      const strictResult = await runAcpAgentInstallScripts(
        { configuration: strictInstall.configuration, root, strict: true },
        livePorts,
      );
      expect(strictResult).toMatchObject({ status: "completed", sandboxed: true });
      expect(
        readFileSync(join(strictInstall.folder, "node_modules", "droid", "inside.txt"), "utf8"),
      ).toBe("ok");
      expect(existsSync(outside)).toBe(false);

      // Outside Strict, the script runs natively without Seatbelt.
      const nativeRoot = scratch();
      const nativeOutside = join(realpathSync(scratch()), "native-allowed.txt");
      const nativeInstall = createInstalledNpmPrefix(nativeRoot, {
        postinstall: "node postinstall.js",
      });
      writeFileSync(
        join(nativeInstall.folder, "node_modules", "droid", "postinstall.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(nativeOutside)}, "native");\n`,
      );
      const nativeResult = await runAcpAgentInstallScripts(
        { configuration: nativeInstall.configuration, root: nativeRoot, strict: false },
        livePorts,
      );
      expect(nativeResult).toMatchObject({ status: "completed", sandboxed: false });
      expect(readFileSync(nativeOutside, "utf8")).toBe("native");
    },
  );

  it("never exposes $HOME or shared home directories in Strict toolchain read roots", async () => {
    const fakeHome = realpathSync(scratch());
    const voltaBin = join(fakeHome, ".volta", "bin");
    const localBin = join(fakeHome, ".local", "bin");
    const directBin = join(fakeHome, "bin");
    const nvmBin = join(fakeHome, ".nvm", "versions", "node", "v22.0.0", "bin");
    for (const dir of [voltaBin, localBin, directBin, nvmBin]) {
      mkdirSync(dir, { recursive: true });
    }
    const voltaNode = join(voltaBin, "node");
    const localNode = join(localBin, "node");
    const directNode = join(directBin, "node");
    const nvmNode = join(nvmBin, "node");
    for (const file of [voltaNode, localNode, directNode, nvmNode]) {
      writeFileSync(file, agentBytes);
      chmodSync(file, 0o755);
    }

    const roots = await toolchainReadRoots([], [voltaNode, localNode, directNode, nvmNode], {
      homeDirectory: fakeHome,
    });
    expect(roots).not.toContain(fakeHome);
    expect(roots).not.toContain(dirname(fakeHome));
    expect(roots).not.toContain(join(fakeHome, ".local"));
    expect(roots).not.toContain("/");
    expect(roots).toContain(voltaBin);
    expect(roots).toContain(join(fakeHome, ".volta"));
    expect(roots).toContain(localBin);
    expect(roots).toContain(directBin);
    expect(roots).toContain(nvmBin);
    expect(roots).toContain(join(fakeHome, ".nvm", "versions", "node", "v22.0.0"));
  });

  it.skipIf(process.platform !== "darwin")(
    "keeps unrelated private files in $HOME denied under Strict Seatbelt when node lives under ~/.volta/bin or ~/.local/bin",
    async () => {
      const fakeUsers = realpathSync(scratch());
      const fakeHome = join(fakeUsers, "alice");
      mkdirSync(fakeHome, { recursive: true });
      const installFolder = realpathSync(scratch());
      const tempDir = join(installFolder, ".octant-install-tmp");
      mkdirSync(tempDir, { recursive: true });
      const secretFile = join(fakeHome, "private-secret.txt");
      writeFileSync(secretFile, "top-secret-value");
      const voltaNode = join(fakeHome, ".volta", "bin", "node");
      const localNode = join(fakeHome, ".local", "bin", "node");
      mkdirSync(dirname(voltaNode), { recursive: true });
      mkdirSync(dirname(localNode), { recursive: true });
      writeFileSync(voltaNode, agentBytes);
      writeFileSync(localNode, agentBytes);

      const readRoots = await toolchainReadRoots(
        [installFolder, tempDir],
        [voltaNode, localNode, process.execPath],
        { homeDirectory: fakeHome },
      );
      expect(readRoots).not.toContain(fakeHome);
      expect(readRoots).not.toContain(join(fakeHome, ".local"));

      const confinement = makeProcessConfinementLive({
        homeDirectory: fakeHome,
        usersDirectory: fakeUsers,
      });
      const launch = confinement.prepare({
        executable: process.execPath,
        args: ["-e", `require("node:fs").readFileSync(${JSON.stringify(secretFile)}, "utf8");`],
        boundRoot: installFolder,
        temporaryDirectory: tempDir,
        networkEgress: "allow",
        writeBoundRoot: true,
        allowFileReadStar: true,
        allowProcessExec: true,
        allowProcessFork: true,
        readRoots,
      });
      const attempt = spawnSync(launch.command, [...launch.args], {
        cwd: installFolder,
        env: { ...process.env, HOME: tempDir, TMPDIR: tempDir, ...launch.environment },
        encoding: "utf8",
      });
      expect(attempt.status).not.toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "escalates surviving descendants that ignore SIGTERM to SIGKILL before resolving a timed-out run",
    async () => {
      const work = realpathSync(scratch());
      const childPidFile = join(work, "child.pid");
      const childScript = join(work, "stubborn-child.js");
      const parentScript = join(work, "exiting-parent.js");
      writeFileSync(
        childScript,
        `const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      writeFileSync(
        parentScript,
        `const { spawn } = require("node:child_process");
spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      );

      const livePorts = makeAcpAgentInstallPorts({
        fetchesAllowed: () => true,
        killGraceMs: 120,
      });
      const result = await livePorts.run(process.execPath, [parentScript], {
        cwd: work,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 300,
      });
      expect(result.timedOut).toBe(true);
      expect(existsSync(childPidFile)).toBe(true);
      const childPid = Number.parseInt(readFileSync(childPidFile, "utf8").trim(), 10);
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      let stillAlive = false;
      try {
        process.kill(childPid, 0);
        stillAlive = true;
        process.kill(childPid, "SIGKILL");
      } catch (error) {
        stillAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      expect(stillAlive).toBe(false);
    },
  );
});
