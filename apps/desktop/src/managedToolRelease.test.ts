import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_MANAGED_TOOL_RELEASES,
  MANAGED_TOOLS,
  commitManagedTool,
  isManagedToolRelease,
  isInsideManagedToolLocation,
  latestManagedToolRelease,
  managedToolReleaseFromResponse,
  platformPackageName,
  resolveManagedToolRelease,
  maxSatisfyingVersion,
  planDependencyClosure,
  readInstalledManagedTool,
  stageManagedTool,
  type ManagedFetch,
  type ManagedToolDescriptor,
  type ManagedToolRelease,
} from "./managedToolRelease";

const exec = promisify(execFile);
const serveSim = MANAGED_TOOLS[0];
if (serveSim === undefined) throw new Error("fixture descriptor missing");
const serveSimDescriptor: ManagedToolDescriptor = serveSim;

/** Minimal ustar writer so a test can place a member name the platform tar refuses to create. */
function ustarTarball(members: ReadonlyArray<{ name: string; contents: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const member of members) {
    const header = new Uint8Array(512);
    const write = (offset: number, field: string) =>
      header.set(new TextEncoder().encode(field.slice(0, 100)), offset);
    write(0, member.name);
    header.set(new TextEncoder().encode("0000644\0"), 100);
    header.set(new TextEncoder().encode("0000000\x000000000\x00"), 108);
    header.set(
      new TextEncoder().encode(member.contents.byteLength.toString(8).padStart(11, "0") + "\0"),
      124,
    );
    header.set(new TextEncoder().encode("00000000000\0"), 136);
    header[156] = 48;
    header.set(new TextEncoder().encode("ustar\0"), 257);
    let checksum = 0;
    header.set(new TextEncoder().encode("        "), 148);
    for (const byte of header) checksum += byte;
    header.set(new TextEncoder().encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    chunks.push(header);
    chunks.push(member.contents);
    const padding = 512 - (member.contents.byteLength % 512);
    if (padding < 512) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function makePackageTarball(
  name: string,
  version: string,
  files: Readonly<Record<string, string>>,
): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), "octant-tool-fixture-"));
  try {
    const source = join(root, "package");
    await mkdir(source, { recursive: true });
    for (const [relative, contents] of Object.entries(files)) {
      const path = join(source, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, contents);
    }
    const archive = join(root, `${name}-${version}.tgz`);
    await exec("/usr/bin/tar", ["-czf", archive, "-C", root, "package"]);
    return new Uint8Array(await readFile(archive));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function packageJson(name: string, version: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ name, version, ...extra });
}

function releaseFor(bytes: Uint8Array, version = "0.1.46"): ManagedToolRelease {
  return {
    packageName: "serve-sim",
    version,
    url: `https://registry.npmjs.org/serve-sim/-/serve-sim-${version}.tgz`,
    integrity: sha512Integrity(bytes),
  };
}

describe("Managed tool release channel", () => {
  it("reads the latest release from the package document's dist-tags", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        "dist-tags": { latest: "0.1.46", beta: "0.1.47-beta.1" },
        versions: {
          "0.1.46": {
            version: "0.1.46",
            dist: {
              tarball: "https://registry.npmjs.org/serve-sim/-/serve-sim-0.1.46.tgz",
              integrity: "sha512-AAAA",
            },
          },
        },
      }),
    );
    const fetchJson: ManagedFetch = (url, signal) => {
      void signal;
      expect(url).toBe("https://registry.npmjs.org/serve-sim");
      return Promise.resolve(bytes);
    };
    const release = await latestManagedToolRelease(
      "serve-sim",
      fetchJson,
      new AbortController().signal,
    );
    expect(release.version).toBe("0.1.46");
    expect(isManagedToolRelease(release)).toBe(true);
  });

  it("refuses a release whose tarball address or integrity does not match the package", () => {
    const base = managedToolReleaseFromResponse("serve-sim", {
      version: "0.1.46",
      dist: {
        tarball: "https://registry.npmjs.org/serve-sim/-/serve-sim-0.1.46.tgz",
        integrity: "sha512-AAAA",
      },
    });
    expect(base).toBeDefined();
    expect(
      managedToolReleaseFromResponse("serve-sim", {
        version: "0.1.46",
        dist: { tarball: "https://example.com/serve-sim.tgz", integrity: "sha512-AAAA" },
      }),
    ).toBeUndefined();
    expect(
      managedToolReleaseFromResponse("serve-sim", {
        version: "../0.1.46",
        dist: {
          tarball: "https://registry.npmjs.org/serve-sim/-/serve-sim-0.1.46.tgz",
          integrity: "sha512-AAAA",
        },
      }),
    ).toBeUndefined();
    const bundled = BUNDLED_MANAGED_TOOL_RELEASES[0];
    expect(bundled).toBeDefined();
    if (bundled !== undefined)
      expect(isManagedToolRelease({ ...bundled, integrity: "md5-AAAA" })).toBe(false);
  });

  it("picks the highest version satisfying a caret, tilde, or exact range", () => {
    const versions = ["8.21.0", "8.22.0", "9.0.0", "0.9.9", "8.22.0-beta"];
    expect(maxSatisfyingVersion("^8.21.0", versions)).toBe("8.22.0");
    expect(maxSatisfyingVersion("~8.21.0", versions)).toBe("8.21.0");
    expect(maxSatisfyingVersion("8.21.0", versions)).toBe("8.21.0");
    expect(maxSatisfyingVersion("^9.1.0", versions)).toBeUndefined();
    expect(maxSatisfyingVersion("^0.9.0", versions)).toBe("0.9.9");
  });

  it("stages a pinned tool release with its registry-verified dependency closure", async () => {
    const toolTarball = await makePackageTarball("serve-sim", "0.1.46", {
      "package.json": packageJson("serve-sim", "0.1.46", {
        bin: { "serve-sim": "dist/serve-sim.js" },
        dependencies: { ws: "^8.21.0" },
      }),
      "dist/serve-sim.js": "#!/usr/bin/env node\n",
    });
    const wsTarball = await makePackageTarball("ws", "8.22.0", {
      "package.json": packageJson("ws", "8.22.0", {}),
      "index.js": "module.exports = {};",
    });
    const wsPackument = new TextEncoder().encode(
      JSON.stringify({
        versions: {
          "8.22.0": {
            version: "8.22.0",
            dist: {
              tarball: "https://registry.npmjs.org/ws/-/ws-8.22.0.tgz",
              integrity: sha512Integrity(wsTarball),
            },
            dependencies: {},
          },
        },
      }),
    );
    const fetchBytes: ManagedFetch = (url, signal) => {
      void signal;
      if (url.endsWith("/serve-sim-0.1.46.tgz")) return Promise.resolve(toolTarball);
      if (url.endsWith("/ws-8.22.0.tgz")) return Promise.resolve(wsTarball);
      if (url === "https://registry.npmjs.org/ws") return Promise.resolve(wsPackument);
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    };
    const root = await mkdtemp(join(tmpdir(), "octant-managed-tool-"));
    try {
      const staged = await stageManagedTool(
        serveSimDescriptor,
        releaseFor(toolTarball),
        root,
        fetchBytes,
        new AbortController().signal,
      );
      expect(staged.version).toBe("0.1.46");
      expect(await readFile(staged.entrypoint, "utf8")).toContain("node");
      expect(await readdir(join(staged.path, "node_modules"))).toEqual(["ws"]);
      await commitManagedTool(root, staged);
      const installed = await readInstalledManagedTool(serveSimDescriptor, root);
      expect(installed?.version).toBe("0.1.46");
      expect(installed?.entrypoint).toBe(staged.entrypoint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to extract a release whose archive hash does not match", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-managed-tool-"));
    try {
      const forged = { ...releaseFor(new Uint8Array([1, 2, 3])), integrity: "sha512-BBBB" };
      await expect(
        stageManagedTool(
          serveSimDescriptor,
          forged,
          root,
          async () => new Uint8Array([1, 2, 3]),
          new AbortController().signal,
        ),
      ).rejects.toThrow("hash");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a tarball whose members escape the package root", async () => {
    const tools = await mkdtemp(join(tmpdir(), "octant-managed-tool-"));
    try {
      const tarball = ustarTarball([
        {
          name: "package/package.json",
          contents: new TextEncoder().encode(packageJson("serve-sim", "0.1.46", {})),
        },
        { name: "package/../escape.txt", contents: new TextEncoder().encode("out") },
      ]);
      const gzipped = new Uint8Array(gzipSync(Buffer.from(tarball)));
      const release = releaseFor(gzipped);
      await expect(
        stageManagedTool(
          serveSimDescriptor,
          release,
          tools,
          async () => gzipped,
          new AbortController().signal,
        ),
      ).rejects.toThrow("unsafe");
    } finally {
      await rm(tools, { recursive: true, force: true });
    }
  });

  it("nests a dependency under its owner when the flat layer carries another version", async () => {
    const manifest = {
      name: "serve-sim",
      version: "0.1.46",
      bin: "dist/serve-sim.js",
      dependencies: { a: "^1.0.0", b: "^1.0.0" },
    };
    const releases: Record<string, Record<string, { deps: Record<string, string> }>> = {
      a: { "1.2.0": { deps: { shared: "^2.0.0" } } },
      b: { "1.0.0": { deps: { shared: "^1.0.0" } } },
      shared: { "1.5.0": { deps: {} }, "2.1.0": { deps: {} } },
    };
    const fetchPackument: ManagedFetch = (url, signal) => {
      void signal;
      const name = url.replace("https://registry.npmjs.org/", "");
      const versions = releases[name];
      if (versions === undefined) return Promise.reject(new Error(`unexpected ${url}`));
      const doc = {
        versions: Object.fromEntries(
          Object.entries(versions).map(([version, row]) => [
            version,
            {
              version,
              dist: {
                tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
                integrity: "sha512-AAAA",
              },
              dependencies: row.deps,
            },
          ]),
        ),
      };
      return Promise.resolve(new TextEncoder().encode(JSON.stringify(doc)));
    };
    const planned = await planDependencyClosure(
      manifest,
      fetchPackument,
      new AbortController().signal,
    );
    const destinations = Object.fromEntries(planned.map((row) => [row.destination, row.version]));
    expect(destinations["node_modules/a"]).toBe("1.2.0");
    expect(destinations["node_modules/b"]).toBe("1.0.0");
    expect(destinations["node_modules/shared"]).toBeDefined();
    // `a` wants ^2 (flat owns it once planned first); `b` wants ^1 → nested.
    const nested = planned.filter((row) => row.name === "shared");
    expect(nested.map((row) => row.destination).sort()).toEqual(
      ["node_modules/shared", "node_modules/b/node_modules/shared"].sort(),
    );
  });

  it("puts OpenCode on the managed channel and resolves the host platform package", async () => {
    const descriptor = MANAGED_TOOLS.find((entry) => entry.tool === "opencode");
    expect(descriptor?.packageName).toBe("@opencode/cli");
    expect(descriptor?.runtime).toBe("executable");
    expect(descriptor?.shipInApp).toBe(false);
    expect(descriptor?.entrypoint).toBe("bin/opencode");
    const platformPackage = platformPackageName(
      descriptor ?? serveSimDescriptor,
      "darwin",
      "arm64",
    );
    expect(platformPackage).toBe("@opencode/cli-darwin-arm64");
    const pinned = BUNDLED_MANAGED_TOOL_RELEASES.find(
      (release) => release.packageName === "@opencode/cli",
    );
    expect(pinned).toBeDefined();
    if (pinned !== undefined) expect(isManagedToolRelease(pinned)).toBe(true);
    if (descriptor === undefined) throw new Error("OpenCode descriptor missing");
    const upstream = {
      packageName: "@opencode/cli",
      version: "2.0.22",
      url: "https://registry.npmjs.org/@opencode/cli/-/cli-2.0.22.tgz",
      integrity: "sha512-AAAA",
    };
    const fetchJson: ManagedFetch = (url, signal) => {
      void signal;
      expect(url).toBe("https://registry.npmjs.org/@opencode/cli-darwin-arm64/2.0.22");
      return Promise.resolve(
        new TextEncoder().encode(
          JSON.stringify({
            version: "2.0.22",
            dist: {
              tarball:
                "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.0.22.tgz",
              integrity: "sha512-AAAA",
            },
          }),
        ),
      );
    };
    const resolved = await resolveManagedToolRelease(
      descriptor,
      upstream,
      fetchJson,
      new AbortController().signal,
      { platform: "darwin", arch: "arm64" },
    );
    expect(resolved.packageName).toBe("@opencode/cli-darwin-arm64");
    expect(resolved.version).toBe("2.0.22");
    expect(isManagedToolRelease(resolved)).toBe(true);
  });

  it("refuses a release whose hash does not match and keeps the installed copy", async () => {
    const descriptor = MANAGED_TOOLS.find((entry) => entry.tool === "opencode");
    if (descriptor === undefined) throw new Error("OpenCode descriptor missing");
    const platformPackage =
      platformPackageName(descriptor, "darwin", "arm64") ?? "@opencode/cli-darwin-arm64";
    const good = await makePackageTarball("cli-darwin-arm64", "2.0.21", {
      "package.json": packageJson(platformPackage, "2.0.21", {}),
      "bin/opencode": "#!/bin/sh\nprintf '2.0.21\\n'\n",
    });
    const bad = await makePackageTarball("cli-darwin-arm64", "2.0.22", {
      "package.json": packageJson(platformPackage, "2.0.22", {}),
      "bin/opencode": "#!/bin/sh\nprintf '2.0.22\\n'\n",
    });
    const fileBase = platformPackage.slice(platformPackage.lastIndexOf("/") + 1);
    const root = await mkdtemp(join(tmpdir(), "octant-opencode-release-"));
    const outside = join(tmpdir(), `octant-opencode-outside-${Date.now()}`);
    await writeFile(outside, "user-installed\n");
    try {
      const staged = await stageManagedTool(
        descriptor,
        {
          packageName: platformPackage,
          version: "2.0.21",
          url: `https://registry.npmjs.org/${platformPackage}/-/${fileBase}-2.0.21.tgz`,
          integrity: sha512Integrity(good),
        },
        root,
        async (url) => {
          if (url.endsWith("2.0.21.tgz")) return good;
          throw new Error(`unexpected fetch ${url}`);
        },
        new AbortController().signal,
      );
      await commitManagedTool(root, staged);
      await expect(
        stageManagedTool(
          descriptor,
          {
            packageName: platformPackage,
            version: "2.0.22",
            url: `https://registry.npmjs.org/${platformPackage}/-/${fileBase}-2.0.22.tgz`,
            integrity: "sha512-AAAA",
          },
          root,
          async () => bad,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Tool archive hash does not match.");
      expect((await readInstalledManagedTool(descriptor, root))?.version).toBe("2.0.21");
      expect(await readFile(outside, "utf8")).toBe("user-installed\n");
      expect(isInsideManagedToolLocation(root, outside)).toBe(false);
      await expect(
        commitManagedTool(root, {
          version: "2.0.22",
          path: outside,
          entrypoint: outside,
        }),
      ).rejects.toThrow("Tool activation path is invalid.");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });
});
