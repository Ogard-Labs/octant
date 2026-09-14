import { describe, expect, it, vi } from "vitest";
import { MarketplaceFetchesDisabledError } from "./marketplaceHttps";
import type { MarketplaceFetch } from "./marketplaceRequestSignal";
import {
  NPM_AGENT_PLUGINS_CATALOG_ID,
  NpmAgentPluginMarketplace,
  extractAgentPluginEntriesFromTarball,
} from "./npmAgentPluginMarketplace";
import { encodeNpmEntryId } from "./npmRegistry";
import { inspectExtensionPackage } from "./packageInspector";
import {
  buildGzipTar,
  catalogEntryIdOf,
  demoSkill,
  npmAgentPluginSourceFor,
  pluginManifest,
  pluginTarball,
  registryFetch,
} from "./agentPluginCatalogTestFixtures";
import { encodeCompactCatalogIdentity } from "./skillPackageBuilder";

/** Serves the `agent-plugins` keyword query and fails the `agent-plugin` one. */
function failingAgentPluginKeywordFetch(fetch: MarketplaceFetch): MarketplaceFetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const isAgentPluginsQuery = (url.searchParams.get("text") ?? "").endsWith(
      "keywords:agent-plugins",
    );
    if (url.pathname === "/-/v1/search" && !isAgentPluginsQuery) {
      return new Response("unavailable", { status: 503 });
    }
    return fetch(input);
  }) as MarketplaceFetch;
}

describe("npm Agent Plugin marketplace", () => {
  it("merges and deduplicates the agent-plugin keyword queries", async () => {
    const { fetch, calls } = registryFetch([
      {
        name: "dual-keyword-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "dual-keyword-plugin" }),
      },
      {
        name: "single-keyword-plugin",
        version: "2.0.0",
        keywords: ["agent-plugins"],
        tarball: pluginTarball({ name: "single-keyword-plugin" }),
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    const search = await marketplace.search("plugin");

    expect(search.entries.map((entry) => entry.displayName)).toEqual([
      "dual-keyword-plugin",
      "single-keyword-plugin",
    ]);
    expect(calls.filter((call) => call.includes("/-/v1/search"))).toHaveLength(2);
  });

  it("lists the real identity and digest that inspection reuses", async () => {
    const { fetch } = registryFetch([
      {
        name: "demo-plugin",
        version: "1.2.3",
        keywords: ["agent-plugin"],
        tarball: pluginTarball(),
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    const [entry] = (await marketplace.search("demo")).entries;
    expect(entry).toBeDefined();
    const resolved = await marketplace.resolve(entry!.source);
    const inspection = inspectExtensionPackage(resolved);

    expect(inspection.manifest.extensionId).toBe(entry!.extensionId);
    expect(inspection.manifest.packageId).toBe(entry!.packageId);
    expect(inspection.manifest.digest).toBe(entry!.digest);
    expect(inspection.manifest.version).toBe("1.2.3");
    expect(inspection.manifest.slug).toBe("demo-plugin");
    expect(inspection.manifest.source).toEqual({
      kind: "plugin-package",
      sourceRef: `catalog:${NPM_AGENT_PLUGINS_CATALOG_ID}:${catalogEntryIdOf(entry!.source)}`,
    });
    const kinds = inspection.manifest.components.map((component) => component.kind).sort();
    expect(kinds).toEqual(["mcp-server", "skill-instructions"]);
  });

  it("caches inspected bytes by name@version so a preview does not refetch", async () => {
    const { fetch, calls } = registryFetch([
      {
        name: "cached-plugin",
        version: "3.1.4",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "cached-plugin" }),
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    const [entry] = (await marketplace.search("cached")).entries;
    const afterSearch = calls.length;
    const resolved = await marketplace.resolve(entry!.source);

    expect(calls).toHaveLength(afterSearch);
    expect(inspectExtensionPackage(resolved).manifest.digest).toBe(entry!.digest);
  });

  it("rejects an entry id that is not pinned to an exact npm version", async () => {
    const { fetch } = registryFetch([]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    await expect(
      marketplace.resolve({
        kind: "catalog",
        catalogId: NPM_AGENT_PLUGINS_CATALOG_ID as never,
        entryId: encodeNpmEntryId("demo-plugin") as never,
      }),
    ).rejects.toThrow(/cannot resolve/i);
  });

  it("refuses an entry id whose decoded name would resolve a different package", async () => {
    // `@a/b/c` has no npm identity; without the grammar check the resolver
    // would drop the third segment and fetch `@a/b` under a `@a/b/c` source.
    const craftedEntryId = `n${encodeCompactCatalogIdentity("@a/b/c\n1.0.0")}` as never;
    const { fetch, calls } = registryFetch([
      {
        name: "@a/b",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "@a/b" }),
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    await expect(
      marketplace.resolve({
        kind: "catalog",
        catalogId: NPM_AGENT_PLUGINS_CATALOG_ID as never,
        entryId: craftedEntryId,
      }),
    ).rejects.toThrow(/cannot resolve/i);
    expect(calls).toHaveLength(0);
  });

  it("skips candidates whose root plugin.json is not a canonical Agent Plugin", async () => {
    const { fetch } = registryFetch([
      {
        name: "wrong-schema-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({
          name: "wrong-schema-plugin",
          overrides: { $schema: "https://agent-plugins.org/schemas/0.9.0/plugin.schema.json" },
        }),
      },
      {
        name: "missing-manifest-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: buildGzipTar([{ path: "package/mcp.json", content: "{}" }]),
      },
      {
        name: "good-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "good-plugin" }),
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    const search = await marketplace.search("plugin");

    expect(search.entries.map((entry) => entry.displayName)).toEqual(["good-plugin"]);
    await expect(
      marketplace.resolve(npmAgentPluginSourceFor("wrong-schema-plugin", "1.0.0")),
    ).rejects.toThrow(/canonical Agent Plugins schema/i);
    await expect(
      marketplace.resolve(npmAgentPluginSourceFor("missing-manifest-plugin", "1.0.0")),
    ).rejects.toThrow(/root plugin\.json/i);
  });

  it("keeps a package when an individual skill entry is invalid", async () => {
    const tarball = buildGzipTar([
      { path: "package/plugin.json", content: pluginManifest({ name: "partial-plugin" }) },
      { path: "package/skills/broken/SKILL.md", content: "not frontmatter" },
      {
        path: "package/mcp.json",
        content: JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { demo: { type: "stdio", command: "./server.mjs" } },
        }),
      },
      { path: "package/server.mjs", content: "console.log('demo');\n" },
    ]);
    const { fetch } = registryFetch([
      {
        name: "partial-plugin",
        version: "1.2.3",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball,
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    const [entry] = (await marketplace.search("partial")).entries;
    expect(entry).toBeDefined();
    const inspection = inspectExtensionPackage(await marketplace.resolve(entry!.source));

    expect(inspection.manifest.components.map((component) => component.kind)).toEqual([
      "mcp-server",
    ]);
    expect(inspection.diagnostics?.some((diagnostic) => diagnostic.code === "skill-skipped")).toBe(
      true,
    );
  });

  it("bounds the number of listed packages", async () => {
    const packages = Array.from({ length: 30 }, (_, index) => ({
      name: `bounded-plugin-${index}`,
      version: "1.0.0",
      keywords: ["agent-plugin", "agent-plugins"],
      tarball: pluginTarball({ name: `bounded-plugin-${index}` }),
    }));
    const { fetch } = registryFetch(packages);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    const search = await marketplace.search("bounded");

    expect(search.entries).toHaveLength(25);
  });

  it("returns the plugins it finished inspecting when the search budget runs out", async () => {
    const { fetch: registry } = registryFetch([
      {
        name: "fast-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "fast-plugin" }),
      },
      {
        name: "stalled-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "stalled-plugin" }),
      },
    ]);
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("stalled-plugin-1.0.0.tgz")) {
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) return;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return registry(input, init);
    }) as MarketplaceFetch;
    const marketplace = new NpmAgentPluginMarketplace({
      fetch,
      platform: "darwin",
      searchBudgetMs: 1_000,
    });

    const search = await marketplace.search("plugin");

    expect(search.entries.map((entry) => entry.displayName)).toEqual(["fast-plugin"]);
  });

  it("keeps result order stable while inspecting packages in parallel", async () => {
    const { fetch: registry } = registryFetch([
      {
        name: "first-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "first-plugin" }),
      },
      {
        name: "second-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "second-plugin" }),
      },
    ]);
    let markSecondTarballServed: () => void = () => {};
    const secondTarballServed = new Promise<void>((resolve) => {
      markSecondTarballServed = resolve;
    });
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("first-plugin-1.0.0.tgz")) {
        await secondTarballServed;
      }
      const response = await registry(input, init);
      if (url.pathname.endsWith("second-plugin-1.0.0.tgz")) {
        markSecondTarballServed();
      }
      return response;
    }) as MarketplaceFetch;
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    const search = await marketplace.search("plugin");

    expect(search.entries.map((entry) => entry.displayName)).toEqual([
      "first-plugin",
      "second-plugin",
    ]);
  });

  it("rethrows when the caller cancels a search", async () => {
    const { fetch: registry } = registryFetch([
      {
        name: "stalled-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "stalled-plugin" }),
      },
    ]);
    const caller = new AbortController();
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(".tgz")) {
        caller.abort();
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) return;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return registry(input, init);
    }) as MarketplaceFetch;
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    await expect(marketplace.search("plugin", caller.signal)).rejects.toThrow(/abort/i);
  });

  it("skips a candidate whose tarball exceeds the bounded fetch and cancels the stream", async () => {
    let cancelled = false;
    let chunks = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        chunks += 1;
        if (chunks === 12) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = registryFetch([
      {
        name: "oversized-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: () => new Response(oversized),
      },
      {
        name: "healthy-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "healthy-plugin" }),
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    const search = await marketplace.search("plugin");

    expect(search.entries.map((entry) => entry.displayName)).toEqual(["healthy-plugin"]);
    expect(cancelled).toBe(true);
  });

  it("skips a candidate whose tarball integrity does not match npm metadata", async () => {
    const { fetch } = registryFetch([
      {
        name: "tampered-plugin",
        version: "1.0.0",
        keywords: ["agent-plugin", "agent-plugins"],
        tarball: pluginTarball({ name: "tampered-plugin" }),
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({ fetch, platform: "darwin" });

    await expect(marketplace.search("tampered")).resolves.toEqual({ entries: [] });
    await expect(
      marketplace.resolve(npmAgentPluginSourceFor("tampered-plugin", "1.0.0")),
    ).rejects.toThrow(/integrity check failed/i);
  });

  it("keeps keyword results when one keyword query fails", async () => {
    const { fetch } = registryFetch([
      {
        name: "single-keyword-plugin",
        version: "1.0.0",
        keywords: ["agent-plugins"],
        tarball: pluginTarball({ name: "single-keyword-plugin" }),
      },
    ]);
    const marketplace = new NpmAgentPluginMarketplace({
      fetch: failingAgentPluginKeywordFetch(fetch),
      platform: "darwin",
    });

    const search = await marketplace.search("plugin");

    expect(search.entries.map((entry) => entry.displayName)).toEqual(["single-keyword-plugin"]);
  });

  it("surfaces a failed keyword query when no listing can be shown", async () => {
    const { fetch } = registryFetch([]);
    const marketplace = new NpmAgentPluginMarketplace({
      fetch: failingAgentPluginKeywordFetch(fetch),
      platform: "darwin",
    });

    await expect(marketplace.search("plugin")).rejects.toThrow(/npm Agent Plugin search/i);
  });

  it("fails closed with no listings when the registry is unreachable", async () => {
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const marketplace = new NpmAgentPluginMarketplace({
      fetch: fetch as unknown as MarketplaceFetch,
      platform: "darwin",
    });

    await expect(marketplace.search("demo")).rejects.toThrow(/unavailable/i);
  });

  it("makes no request when marketplace fetches are turned off", async () => {
    const fetch = vi.fn(async () => Response.json({ objects: [] }));
    const marketplace = new NpmAgentPluginMarketplace({
      fetch: fetch as unknown as MarketplaceFetch,
      isMarketplaceFetchAllowed: () => false,
      platform: "darwin",
    });

    await expect(marketplace.search("demo")).rejects.toBeInstanceOf(
      MarketplaceFetchesDisabledError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("npm Agent Plugin tarball extraction", () => {
  it("rejects members outside the npm package root and traversal", () => {
    expect(() =>
      extractAgentPluginEntriesFromTarball(
        buildGzipTar([{ path: "package/../escape.json", content: "{}" }]),
      ),
    ).toThrow(/unsafe path/i);
    expect(() =>
      extractAgentPluginEntriesFromTarball(
        buildGzipTar([{ path: "/etc/passwd", content: "root" }]),
      ),
    ).toThrow(/unsafe path/i);
    expect(() =>
      extractAgentPluginEntriesFromTarball(
        buildGzipTar([{ path: "other/plugin.json", content: "{}" }]),
      ),
    ).toThrow(/unsafe path/i);
  });

  it("rejects duplicate members and link members", () => {
    expect(() =>
      extractAgentPluginEntriesFromTarball(
        buildGzipTar([
          { path: "package/plugin.json", content: "{}" },
          { path: "package/plugin.json", content: "{}" },
        ]),
      ),
    ).toThrow(/duplicate path/i);
    expect(() =>
      extractAgentPluginEntriesFromTarball(
        buildGzipTar([
          { path: "package/plugin.json", content: "{}" },
          { path: "package/link.json", kind: "symlink", linkTarget: "plugin.json" },
        ]),
      ),
    ).toThrow(/unsupported entry/i);
  });

  it("rejects a single file that exceeds the per-file bound", () => {
    expect(() =>
      extractAgentPluginEntriesFromTarball(
        buildGzipTar([
          { path: "package/plugin.json", content: "{}" },
          { path: "package/blob.bin", content: new Uint8Array(4 * 1024 * 1024 + 1) },
        ]),
      ),
    ).toThrow(/size limits/i);
  });

  it("returns plugin-relative files and directories", () => {
    const entries = extractAgentPluginEntriesFromTarball(
      buildGzipTar([
        { path: "package", kind: "directory" },
        { path: "package/plugin.json", content: "{}" },
        { path: "package/skills/demo", kind: "directory" },
        { path: "package/skills/demo/SKILL.md", content: demoSkill() },
      ]),
    );

    expect(entries).toEqual([
      { path: "plugin.json", kind: "file", content: Buffer.from("{}") },
      { path: "skills/demo", kind: "directory" },
      { path: "skills/demo/SKILL.md", kind: "file", content: Buffer.from(demoSkill()) },
    ]);
  });
});
