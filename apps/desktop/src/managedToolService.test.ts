import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManagedToolService } from "./managedToolService";
import { BUNDLED_MANAGED_TOOL_RELEASES, MANAGED_TOOLS } from "./managedToolRelease";

const execFile = promisify(execFileCallback);

async function makePackageTarball(
  name: string,
  version: string,
  files: Record<string, string>,
): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), `octant-tool-pkg-${name}-`));
  try {
    const packageDirectory = join(root, "package");
    for (const [relative, contents] of Object.entries(files)) {
      const target = join(packageDirectory, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    const tarball = join(root, `${name}.tgz`);
    await execFile("tar", ["-czf", tarball, "-C", packageDirectory, "."]);
    const { stdout } = await execFile("base64", ["-i", tarball]);
    return new Uint8Array(Buffer.from(stdout.toString(), "base64"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function latestDocument(
  name: string,
  version: string,
  tarballBytes: Uint8Array,
  url: string,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      name,
      "dist-tags": { latest: version },
      versions: {
        [version]: {
          name,
          version,
          dist: { tarball: url, integrity: sha512Integrity(tarballBytes) },
        },
      },
    }),
  );
}

const platformTools = MANAGED_TOOLS.filter((descriptor) =>
  descriptor.platforms.includes(process.platform),
);

describe("managed tool service", () => {
  let directory: string;
  let bundledDirectory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "octant-managed-tools-data-"));
    bundledDirectory = await mkdtemp(join(tmpdir(), "octant-managed-tools-bundled-"));
    for (const descriptor of platformTools) {
      const tool = join(bundledDirectory, descriptor.tool);
      await mkdir(join(tool, "dist"), { recursive: true });
      await writeFile(join(tool, descriptor.entrypoint), "process.exit(0);\n");
    }
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(bundledDirectory, { recursive: true, force: true });
  });

  function makeService(fetchBytes?: (url: string, signal: AbortSignal) => Promise<Uint8Array>) {
    return createManagedToolService({
      bundledToolsDirectory: bundledDirectory,
      dataDirectory: directory,
      execPath: process.execPath,
      smokeTimeoutMs: 250,
      ...(fetchBytes === undefined ? {} : { fetchBytes }),
    });
  }

  it("reports every platform tool as available from the bundled copy", async () => {
    const service = makeService();
    try {
      const status = await service.status();
      expect(status.supported).toBe(true);
      expect(status.automaticUpdates).toBe(true);
      expect(status.tools.map((tool) => tool.tool)).toEqual(
        platformTools.map((descriptor) => descriptor.tool),
      );
      for (const tool of status.tools) {
        expect(tool.available).toBe(true);
        expect(tool.installed).toBe(false);
        expect(tool.channel).toBe("npm");
        expect(tool.version).toBe(
          BUNDLED_MANAGED_TOOL_RELEASES.find((release) => release.packageName === tool.packageName)
            ?.version,
        );
      }
    } finally {
      await service.close();
    }
  });

  it("launches a tool under the desktop runtime, never a system node", async () => {
    const descriptor = platformTools[0];
    if (descriptor === undefined) throw new Error("expected a platform tool");
    const service = makeService();
    try {
      const spec = await service.launchSpec(descriptor.tool, ["--help"]);
      expect(spec).toBeDefined();
      expect(spec?.command).toBe(process.execPath);
      expect(spec?.args[0]).toBe(join(bundledDirectory, descriptor.tool, descriptor.entrypoint));
      expect(spec?.args[1]).toBe("--help");
      expect(spec?.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(await service.launchSpec("not-a-managed-tool", [])).toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it("remembers the update preference across restarts", async () => {
    let service = makeService();
    try {
      await service.configure({ automaticUpdates: false });
    } finally {
      await service.close();
    }
    service = makeService();
    try {
      const status = await service.status();
      expect(status.automaticUpdates).toBe(false);
    } finally {
      await service.close();
    }
  });

  it("stages and installs a verified registry update", async () => {
    const descriptor = platformTools[0];
    if (descriptor === undefined) throw new Error("expected a platform tool");
    const nextVersion = "99.0.1";
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: descriptor.packageName,
        version: nextVersion,
        bin: { [descriptor.tool]: descriptor.entrypoint },
      }),
      [descriptor.entrypoint]: "setInterval(() => {}, 1000);\n",
    };
    const tarball = await makePackageTarball(descriptor.packageName, nextVersion, files);
    const tarballUrl = `https://registry.npmjs.org/${descriptor.packageName}/-/${descriptor.packageName}-${nextVersion}.tgz`;
    const document = latestDocument(descriptor.packageName, nextVersion, tarball, tarballUrl);
    const service = makeService(async (url: string) => {
      if (url === `https://registry.npmjs.org/${descriptor.packageName}`) return document;
      if (url === tarballUrl) return tarball;
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const status = await service.checkUpdates();
      const tool = status.tools.find((entry) => entry.tool === descriptor.tool);
      expect(tool?.installed).toBe(true);
      expect(tool?.version).toBe(nextVersion);
      expect(tool?.update).toBe("current");
      const spec = await service.launchSpec(descriptor.tool, []);
      expect(spec?.args[0]).toBe(
        join(directory, "managed-tools", descriptor.tool, nextVersion, descriptor.entrypoint),
      );
      expect(existsSync(spec?.args[0] ?? "")).toBe(true);
    } finally {
      await service.close();
    }
  });

  it("keeps the bundled release when the registry cannot be reached", async () => {
    const descriptor = platformTools[0];
    if (descriptor === undefined) throw new Error("expected a platform tool");
    const service = makeService(async () => {
      throw new Error("registry offline");
    });
    try {
      const status = await service.checkUpdates();
      const tool = status.tools.find((entry) => entry.tool === descriptor.tool);
      expect(tool?.installed).toBe(false);
      expect(tool?.update).toBe("failed");
      const spec = await service.launchSpec(descriptor.tool, []);
      expect(spec?.args[0]).toBe(join(bundledDirectory, descriptor.tool, descriptor.entrypoint));
    } finally {
      await service.close();
    }
  });

  it("restores an already installed release instead of the bundled one", async () => {
    const descriptor = platformTools[0];
    if (descriptor === undefined) throw new Error("expected a platform tool");
    const version = "98.0.1";
    const toolRoot = join(directory, "managed-tools", descriptor.tool);
    const releaseDirectory = join(toolRoot, version);
    await mkdir(join(releaseDirectory, "dist"), { recursive: true });
    await writeFile(
      join(releaseDirectory, "package.json"),
      JSON.stringify({
        name: descriptor.packageName,
        version,
        bin: { [descriptor.tool]: descriptor.entrypoint },
      }),
    );
    const entrypoint = join(releaseDirectory, descriptor.entrypoint);
    await writeFile(entrypoint, "process.exit(0);\n");
    await chmod(entrypoint, 0o755);
    await mkdir(toolRoot, { recursive: true });
    await writeFile(join(toolRoot, "current.json"), JSON.stringify({ version }));

    const service = makeService();
    try {
      const status = await service.status();
      const tool = status.tools.find((entry) => entry.tool === descriptor.tool);
      expect(tool?.installed).toBe(true);
      expect(tool?.version).toBe(version);
      const spec = await service.launchSpec(descriptor.tool, []);
      expect(spec?.args[0]).toBe(entrypoint);
    } finally {
      await service.close();
    }
  });
});
