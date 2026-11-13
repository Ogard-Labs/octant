import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGzipTar } from "./agentPluginCatalogTestFixtures";
import { createConnectorPackageInstaller } from "./connectorPackageInstall";
import type { MarketplaceFetch } from "./marketplaceHttps";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const NAME = "@scope/demo-mcp";
const TARBALL_URL = "https://registry.npmjs.org/@scope/demo-mcp/-/demo-mcp-1.0.0.tgz";

function tarballWith(entryText: string): Uint8Array {
  return buildGzipTar([
    { path: "package/package.json", content: '{"name":"@scope/demo-mcp","version":"1.0.0"}' },
    { path: "package/dist/stdio.bundle.mjs", content: entryText },
  ]);
}

function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function registry(served: Uint8Array): { fetch: MarketplaceFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === TARBALL_URL) return new Response(served as unknown as BodyInit);
    return Response.json({
      versions: { "1.0.0": { version: "1.0.0", dist: { tarball: TARBALL_URL, shasum: "x" } } },
    });
  }) as MarketplaceFetch;
  return { fetch, calls };
}

async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "octant-connector-install-"));
  folders.push(path);
  return path;
}

describe("installing a connector's pinned package", () => {
  it("unpacks the exact tarball the catalog pinned and nothing else", async () => {
    const pinned = tarballWith("export {};\n");
    const { fetch } = registry(pinned);
    const destination = await folder();
    await createConnectorPackageInstaller({ fetch, isFetchAllowed: () => true })({
      package: { name: NAME, version: "1.0.0", integrity: integrityOf(pinned) },
      folder: destination,
    });
    expect(
      await readFile(
        join(destination, "node_modules/@scope/demo-mcp/dist/stdio.bundle.mjs"),
        "utf8",
      ),
    ).toBe("export {};\n");
  });

  it("installs nothing when the registry serves other bytes than the pin", async () => {
    const pinned = tarballWith("export {};\n");
    const { fetch } = registry(tarballWith("process.exit(1);\n"));
    const destination = await folder();
    await expect(
      createConnectorPackageInstaller({ fetch, isFetchAllowed: () => true })({
        package: { name: NAME, version: "1.0.0", integrity: integrityOf(pinned) },
        folder: destination,
      }),
    ).rejects.toThrow(/integrity/);
    expect(await readdir(destination)).toEqual([]);
  });

  it("sends no request when marketplace fetches are off", async () => {
    const pinned = tarballWith("export {};\n");
    const { fetch, calls } = registry(pinned);
    await expect(
      createConnectorPackageInstaller({ fetch, isFetchAllowed: () => false })({
        package: { name: NAME, version: "1.0.0", integrity: integrityOf(pinned) },
        folder: await folder(),
      }),
    ).rejects.toThrow(/turned off/);
    expect(calls).toEqual([]);
  });
});
