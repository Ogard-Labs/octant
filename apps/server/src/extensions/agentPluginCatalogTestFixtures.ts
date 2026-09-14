import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { ExtensionSource } from "@octant/contracts/extensions";
import { NPM_AGENT_PLUGINS_CATALOG_ID } from "./npmAgentPluginMarketplace";
import { encodeNpmEntryId } from "./npmRegistry";
import type { MarketplaceFetch } from "./marketplaceRequestSignal";

/**
 * Fixtures for npm Agent Plugin tests: a minimal tar writer, conformant and
 * deliberately broken Agent Plugin tarballs, and a stubbed npm registry. Tests
 * never reach the network; every request is served from these in-memory bytes.
 */

export const AGENT_PLUGIN_TEST_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_PLUGIN_TEST_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export interface TarFixtureEntry {
  readonly path: string;
  readonly content?: string | Uint8Array;
  readonly kind?: "file" | "directory" | "symlink";
  readonly linkTarget?: string;
}

export function pluginManifest(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    $schema: AGENT_PLUGIN_TEST_SCHEMA,
    name: "demo-plugin",
    version: "1.2.3",
    description: "Demo Agent Plugin.",
    license: "MIT",
    repository: "https://example.com/demo-plugin",
    ...overrides,
  });
}

export function demoSkill(name = "demo"): string {
  return `---\nname: ${name}\ndescription: Demo skill.\n---\nBody\n`;
}

/** A conformant package with one skill and one plugin-relative stdio server. */
export function pluginTarball(
  options: { readonly name?: string; readonly overrides?: Readonly<Record<string, unknown>> } = {},
): Uint8Array {
  const name = options.name ?? "demo-plugin";
  return buildGzipTar([
    { path: "package/plugin.json", content: pluginManifest({ name, ...options.overrides }) },
    {
      path: "package/mcp.json",
      content: JSON.stringify({
        $schema: AGENT_PLUGIN_TEST_MCP_SCHEMA,
        mcpServers: { demo: { type: "stdio", command: "./server.mjs" } },
      }),
    },
    { path: "package/server.mjs", content: "console.log('demo');\n" },
    { path: "package/skills/demo", kind: "directory" },
    { path: "package/skills/demo/SKILL.md", content: demoSkill() },
  ]);
}

export interface RegistryPackage {
  readonly name: string;
  readonly version: string;
  readonly keywords: ReadonlyArray<string>;
  readonly tarball: Uint8Array | (() => Response);
  readonly integrity?: string;
}

export interface RegistryFetchHarness {
  readonly fetch: MarketplaceFetch;
  readonly calls: Array<string>;
}

/** Stubbed npm registry: keyword search, exact-version metadata, and tarballs. */
export function registryFetch(packages: ReadonlyArray<RegistryPackage>): RegistryFetchHarness {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.pathname === "/-/v1/search") {
      const text = url.searchParams.get("text") ?? "";
      const keyword = text.includes("keywords:agent-plugins") ? "agent-plugins" : "agent-plugin";
      return Response.json({
        objects: packages
          .filter((pkg) => pkg.keywords.includes(keyword))
          .map((pkg) => ({
            package: {
              name: pkg.name,
              version: pkg.version,
              description: `${pkg.name} description`,
              publisher: { username: "publisher" },
            },
          })),
      });
    }
    const pkg = packages.find(
      (candidate) =>
        npmTarballPath(candidate) === url.pathname ||
        `/${encodeURIComponent(candidate.name)}` === url.pathname,
    );
    if (pkg === undefined) return new Response("missing", { status: 404 });
    if (url.pathname.endsWith(".tgz")) {
      if (typeof pkg.tarball === "function") return pkg.tarball();
      return new Response(pkg.tarball as unknown as BodyInit);
    }
    return Response.json({
      "dist-tags": { latest: pkg.version },
      versions: {
        [pkg.version]: {
          _npmUser: { name: "publisher" },
          license: "MIT",
          dist: {
            tarball: `https://registry.npmjs.org${npmTarballPath(pkg)}`,
            integrity: pkg.integrity ?? integrityFor(pkg),
          },
        },
      },
    });
  }) as MarketplaceFetch;
  return { fetch, calls };
}

export function npmAgentPluginSourceFor(name: string, version: string): ExtensionSource {
  return {
    kind: "catalog",
    catalogId: NPM_AGENT_PLUGINS_CATALOG_ID as never,
    entryId: encodeNpmEntryId(name, version) as never,
  };
}

/** Narrow a catalog source to its entry id for identity assertions. */
export function catalogEntryIdOf(source: ExtensionSource): string {
  if (source.kind !== "catalog") throw new Error("Expected a catalog source.");
  return source.entryId;
}

/** Function tarballs are stream fixtures; they must declare their own integrity. */
function integrityFor(pkg: RegistryPackage): string {
  return typeof pkg.tarball === "function"
    ? `sha512-${Buffer.alloc(64).toString("base64")}`
    : `sha512-${createHash("sha512").update(pkg.tarball).digest("base64")}`;
}

function npmTarballPath(pkg: RegistryPackage): string {
  return `/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
}

export function buildGzipTar(entries: ReadonlyArray<TarFixtureEntry>): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const kind = entry.kind ?? "file";
    const content = kind === "file" ? Buffer.from(entry.content ?? "") : Buffer.alloc(0);
    const header = Buffer.alloc(512, 0);
    header.write(entry.path.slice(0, 100), 0, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("0000000\0", 108, "utf8");
    header.write("0000000\0", 116, "utf8");
    header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, "utf8");
    header.write("00000000000\0", 136, "utf8");
    header.write("        ", 148, "utf8");
    header.write(kind === "symlink" ? "2" : kind === "directory" ? "5" : "0", 156, "utf8");
    if (kind === "symlink") header.write(entry.linkTarget ?? "", 157, "utf8");
    header.write("ustar\0", 257, "utf8");
    header.write("00", 263, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
    chunks.push(header);
    if (content.byteLength > 0) {
      chunks.push(content);
      const padding = (512 - (content.byteLength % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}
