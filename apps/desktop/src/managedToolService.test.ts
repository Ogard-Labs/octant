import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManagedToolService } from "./managedToolService";
import {
  BUNDLED_MANAGED_TOOL_RELEASES,
  MANAGED_TOOLS,
  platformPackageName,
} from "./managedToolRelease";

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
      await mkdir(dirname(join(tool, descriptor.entrypoint)), { recursive: true });
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

  it("keeps the previous OpenCode release when the new one does not start", async () => {
    const descriptor = MANAGED_TOOLS.find((entry) => entry.tool === "opencode");
    if (descriptor === undefined) throw new Error("OpenCode descriptor missing");
    const platformPackage = platformPackageName(descriptor, process.platform, process.arch);
    if (platformPackage === undefined) throw new Error("OpenCode has no build for this host");
    const nextVersion = "2.0.23";
    const fileBase = platformPackage.slice(platformPackage.lastIndexOf("/") + 1);
    const tarball = await makePackageTarball(fileBase, nextVersion, {
      "package.json": JSON.stringify({ name: platformPackage, version: nextVersion }),
      "bin/opencode": "#!/bin/sh\nexit 1\n",
    });
    const tarballUrl = `https://registry.npmjs.org/${platformPackage}/-/${fileBase}-${nextVersion}.tgz`;
    const metaUrl = `https://registry.npmjs.org/@opencode/cli/-/cli-${nextVersion}.tgz`;
    const outside = join(directory, "user-opencode");
    await writeFile(outside, "user-installed\n");
    const versionDocument = () => {
      const encoded = latestDocument(platformPackage, nextVersion, tarball, tarballUrl);
      const parsed = JSON.parse(new TextDecoder().decode(encoded)) as {
        versions: Record<string, unknown>;
      };
      const version = parsed.versions[nextVersion];
      if (version === undefined) throw new Error("fixture version missing");
      return new TextEncoder().encode(JSON.stringify(version));
    };
    const service = makeService(async (url: string) => {
      if (url === "https://registry.npmjs.org/@opencode/cli")
        return latestDocument("@opencode/cli", nextVersion, tarball, metaUrl);
      if (url === `https://registry.npmjs.org/${platformPackage}/${nextVersion}`)
        return versionDocument();
      if (url === tarballUrl) return tarball;
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      await service.configure({ automaticUpdates: false });
      const status = await service.checkUpdates("opencode");
      const tool = status.tools.find((entry) => entry.tool === "opencode");
      expect(tool?.update).toBe("failed");
      expect(tool?.message).toBe(
        "The new tool did not start. The previous verified tool is retained.",
      );
      expect(tool?.version).toBe(
        BUNDLED_MANAGED_TOOL_RELEASES.find((release) => release.packageName === "@opencode/cli")
          ?.version,
      );
      expect(tool?.installed).toBe(false);
      const spec = await service.launchSpec("opencode", ["--version"]);
      expect(spec?.command).toBe(join(bundledDirectory, "opencode", descriptor.entrypoint));
      expect(spec?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(await readFile(outside, "utf8")).toBe("user-installed\n");
    } finally {
      await service.close();
      await rm(outside, { force: true });
    }
  });

  it("keeps the previous OpenCode release when verification fails and says why", async () => {
    const descriptor = MANAGED_TOOLS.find((entry) => entry.tool === "opencode");
    if (descriptor === undefined) throw new Error("OpenCode descriptor missing");
    const platformPackage = platformPackageName(descriptor, process.platform, process.arch);
    if (platformPackage === undefined) throw new Error("OpenCode has no build for this host");
    const nextVersion = "2.0.24";
    const fileBase = platformPackage.slice(platformPackage.lastIndexOf("/") + 1);
    const tarball = await makePackageTarball(fileBase, nextVersion, {
      "package.json": JSON.stringify({ name: platformPackage, version: nextVersion }),
      "bin/opencode": "#!/bin/sh\nexit 0\n",
    });
    const tarballUrl = `https://registry.npmjs.org/${platformPackage}/-/${fileBase}-${nextVersion}.tgz`;
    const metaUrl = `https://registry.npmjs.org/@opencode/cli/-/cli-${nextVersion}.tgz`;
    const lying = latestDocument(platformPackage, nextVersion, tarball, tarballUrl);
    const document = JSON.parse(new TextDecoder().decode(lying)) as {
      versions: Record<string, { dist: { integrity: string } }>;
    };
    const versionDoc = document.versions[nextVersion];
    if (versionDoc === undefined) throw new Error("fixture version missing");
    versionDoc.dist.integrity = "sha512-AAAA";
    const outside = join(directory, "user-opencode");
    await writeFile(outside, "user-installed\n");
    const service = makeService(async (url: string) => {
      if (url === "https://registry.npmjs.org/@opencode/cli")
        return latestDocument("@opencode/cli", nextVersion, tarball, metaUrl);
      if (url === `https://registry.npmjs.org/${platformPackage}/${nextVersion}`)
        return new TextEncoder().encode(JSON.stringify(versionDoc));
      if (url === tarballUrl) return tarball;
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      await service.configure({ automaticUpdates: false });
      const status = await service.checkUpdates("opencode");
      const tool = status.tools.find((entry) => entry.tool === "opencode");
      expect(tool?.update).toBe("failed");
      expect(tool?.message).toBe("Tool archive hash does not match.");
      expect(tool?.installed).toBe(false);
      expect(await readFile(outside, "utf8")).toBe("user-installed\n");
    } finally {
      await service.close();
      await rm(outside, { force: true });
    }
  });
});
