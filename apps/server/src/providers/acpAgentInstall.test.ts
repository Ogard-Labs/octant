import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddedAcpAgentConfiguration } from "@octant/contracts";
import type { AcpRegistryAgent } from "@octant/plugin-host/acp-agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAcpAgent, type AcpAgentInstallPorts } from "./acpAgentInstall";

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
    expect(result).toMatchObject({ status: "installed", integrity: "package-manager" });
    const [, args, options] = run.mock.calls[0] ?? [];
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("@scope/agent@1.0.0");
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
