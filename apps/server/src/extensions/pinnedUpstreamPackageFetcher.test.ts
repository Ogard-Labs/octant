import { describe, expect, it } from "vitest";
import {
  fetchPinnedUpstreamPackage,
  PinnedUpstreamFetchError,
  type PinnedUpstreamPackageReference,
} from "./pinnedUpstreamPackageFetcher";

const reference: PinnedUpstreamPackageReference = {
  owner: "openai",
  repository: "plugins",
  packagePath: "plugins/build-ios-apps",
  commit: "cd0fccd4ed62dded584c16246685b232d7bfe7f6",
};

const source = {
  kind: "catalog",
  catalogId: "octant-curated",
  entryId: "build-ios-apps",
} as never;

const textEncoder = new TextEncoder();

function treeJson(paths: ReadonlyArray<string>, truncated = false): unknown {
  return {
    sha: reference.commit,
    truncated,
    tree: paths.map((path) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: "0".repeat(40),
      size: 4,
    })),
  };
}

function fakeFetch(
  files: Readonly<Record<string, string>>,
  options: {
    readonly treeStatus?: number;
    readonly truncated?: boolean;
    readonly missingBlobs?: ReadonlyArray<string>;
  } = {},
) {
  const calls: Array<string> = [];
  const treePaths = Object.keys(files);
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/git/trees/")) {
      if (options.treeStatus !== undefined && options.treeStatus !== 200) {
        return new Response("nope", { status: options.treeStatus });
      }
      return Response.json(treeJson(treePaths, options.truncated ?? false));
    }
    const prefix = `https://raw.githubusercontent.com/${reference.owner}/${reference.repository}/${reference.commit}/`;
    if (!url.startsWith(prefix)) return new Response("unexpected", { status: 400 });
    const path = url.slice(prefix.length);
    const content = files[path];
    if (content === undefined || options.missingBlobs?.includes(path)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(textEncoder.encode(content));
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const completeFiles: Readonly<Record<string, string>> = {
  "plugins/build-ios-apps/.codex-plugin/plugin.json": JSON.stringify({
    name: "build-ios-apps",
    version: "0.1.2",
    author: { name: "OpenAI" },
    repository: "https://github.com/openai/plugins",
    license: "MIT",
    skills: "./skills/",
  }),
  "plugins/build-ios-apps/.mcp.json": JSON.stringify({ mcpServers: {} }),
  "plugins/build-ios-apps/README.md": "# Build iOS Apps\n",
  "plugins/build-ios-apps/assets/app-icon.png": "PNG-BYTES",
  "plugins/build-ios-apps/skills/swiftui-ui-patterns/SKILL.md": "# Patterns\n",
  "plugins/build-ios-apps/skills/swiftui-ui-patterns/references/grids.md": "# Grids\n",
  "plugins/build-ios-apps/skills/ios-memgraph-leaks/scripts/capture_sim_memgraph.sh":
    "#!/bin/bash\n",
  "plugins/build-macos-apps/.codex-plugin/plugin.json": "{}",
};

function input(overrides: Partial<Parameters<typeof fetchPinnedUpstreamPackage>[0]> = {}) {
  return {
    reference,
    source,
    appVersion: "1.0.0",
    platform: "darwin" as NodeJS.Platform,
    ...overrides,
  };
}

describe("pinned upstream package fetcher", () => {
  it("fetches the complete pinned package closure with exact bytes", async () => {
    const { fetch, calls } = fakeFetch(completeFiles);
    const result = await fetchPinnedUpstreamPackage(input({ fetch }));

    expect(result.format).toBe("directory");
    expect(result.source).toEqual(source);
    const paths = result.entries.map((entry) => entry.path).sort();
    // Manifest-relative dependency closure: every blob under the package path is
    // present with exact bytes, and nothing from sibling packages leaks in.
    expect(paths).toEqual(
      [
        ".codex-plugin/plugin.json",
        ".mcp.json",
        "README.md",
        "assets/app-icon.png",
        "skills/ios-memgraph-leaks/scripts/capture_sim_memgraph.sh",
        "skills/swiftui-ui-patterns/SKILL.md",
        "skills/swiftui-ui-patterns/references/grids.md",
      ].sort(),
    );
    expect(paths.some((path) => path.includes("build-macos-apps"))).toBe(false);
    const skill = result.entries.find(
      (entry) => entry.path === "skills/swiftui-ui-patterns/references/grids.md",
    );
    expect(new TextDecoder().decode(skill?.content)).toBe("# Grids\n");
    expect(result.archiveBytes).toBe(
      result.entries.reduce((total, entry) => total + (entry.content?.byteLength ?? 0), 0),
    );
    expect(result.manifest).toMatchObject({ name: "build-ios-apps", version: "0.1.2" });
    const treeCalls = calls.filter((url) => url.includes("/git/trees/"));
    expect(treeCalls).toHaveLength(1);
    expect(treeCalls[0]).toBe(
      `https://api.github.com/repos/openai/plugins/git/trees/${reference.commit}?recursive=1`,
    );
    expect(calls.some((url) => url.includes("build-macos-apps"))).toBe(false);
  });

  it("falls back to a valid Codex manifest when root plugin.json is unrelated or malformed", async () => {
    const malformedRoot = fakeFetch({
      ...completeFiles,
      "plugins/build-ios-apps/plugin.json": "{not-json",
    });
    const malformedResult = await fetchPinnedUpstreamPackage(input({ fetch: malformedRoot.fetch }));
    expect(malformedResult.manifest).toMatchObject({
      name: "build-ios-apps",
      version: "0.1.2",
    });

    const unrelatedRoot = fakeFetch({
      ...completeFiles,
      "plugins/build-ios-apps/plugin.json": JSON.stringify({ name: "unrelated" }),
    });
    const unrelatedResult = await fetchPinnedUpstreamPackage(input({ fetch: unrelatedRoot.fetch }));
    expect(unrelatedResult.manifest).toMatchObject({
      name: "build-ios-apps",
      version: "0.1.2",
    });
  });

  it("fails closed when the tree is unavailable, truncated, or the manifest is missing", async () => {
    const unavailable = fakeFetch(completeFiles, { treeStatus: 404 });
    await expect(
      fetchPinnedUpstreamPackage(input({ fetch: unavailable.fetch })),
    ).rejects.toMatchObject({
      name: "PinnedUpstreamFetchError",
      code: "unavailable",
    });

    const truncated = fakeFetch(completeFiles, { truncated: true });
    await expect(
      fetchPinnedUpstreamPackage(input({ fetch: truncated.fetch })),
    ).rejects.toMatchObject({
      code: "tree-truncated",
    });

    const withoutManifest = fakeFetch({
      "plugins/build-ios-apps/skills/a/SKILL.md": "# A\n",
    });
    await expect(
      fetchPinnedUpstreamPackage(input({ fetch: withoutManifest.fetch })),
    ).rejects.toMatchObject({ code: "manifest-missing" });

    const invalidManifest = fakeFetch({
      "plugins/build-ios-apps/.codex-plugin/plugin.json": "{not-json",
    });
    await expect(
      fetchPinnedUpstreamPackage(input({ fetch: invalidManifest.fetch })),
    ).rejects.toMatchObject({ code: "manifest-invalid" });
  });

  it("fails closed on missing blob bytes and on unsafe tree paths", async () => {
    const missing = fakeFetch(completeFiles, {
      missingBlobs: ["plugins/build-ios-apps/skills/swiftui-ui-patterns/SKILL.md"],
    });
    await expect(fetchPinnedUpstreamPackage(input({ fetch: missing.fetch }))).rejects.toMatchObject(
      {
        code: "unavailable",
      },
    );

    const unsafe = fakeFetch({
      ...completeFiles,
      "plugins/build-ios-apps/skills/../../escape.txt": "x",
      "plugins/build-ios-apps-backdoor/secret.txt": "y",
    });
    const result = await fetchPinnedUpstreamPackage(input({ fetch: unsafe.fetch }));
    // Sibling-prefix paths are out of scope; traversal inside the package is rejected.
    expect(result.entries.some((entry) => entry.path.includes("backdoor"))).toBe(false);
    expect(result.entries.some((entry) => entry.path.includes("escape"))).toBe(false);
    expect(result.entries.some((entry) => entry.path.includes(".."))).toBe(false);
  });

  it("enforces bounded file count, file size, and total size", async () => {
    const { fetch } = fakeFetch(completeFiles);
    await expect(
      fetchPinnedUpstreamPackage(
        input({
          fetch,
          limits: {
            maximumFiles: 2,
            maximumFileBytes: 1_024,
            maximumTotalBytes: 1_024,
            maximumTreeEntries: 1_000,
            concurrency: 4,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "oversize" });
    await expect(
      fetchPinnedUpstreamPackage(
        input({
          fetch,
          limits: {
            maximumFiles: 100,
            maximumFileBytes: 2,
            maximumTotalBytes: 1_024_000,
            maximumTreeEntries: 1_000,
            concurrency: 4,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "oversize" });
    await expect(
      fetchPinnedUpstreamPackage(
        input({
          fetch,
          limits: {
            maximumFiles: 100,
            maximumFileBytes: 1_024,
            maximumTotalBytes: 8,
            maximumTreeEntries: 1_000,
            concurrency: 4,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "oversize" });
    await expect(
      fetchPinnedUpstreamPackage(
        input({
          fetch,
          limits: {
            maximumFiles: 100,
            maximumFileBytes: 1_024,
            maximumTotalBytes: 1_024_000,
            maximumTreeEntries: 2,
            concurrency: 4,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "oversize" });
  });

  it("cancels oversized tree and blob response streams before buffering", async () => {
    let treeCancelled = false;
    let treeChunks = 0;
    const oversizedTreeFetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/git/trees/")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1));
              treeChunks += 1;
              if (treeChunks === 2) controller.close();
            },
            cancel() {
              treeCancelled = true;
            },
          }),
          { headers: { "content-length": String(17 * 1024 * 1024) } },
        );
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    await expect(
      fetchPinnedUpstreamPackage(input({ fetch: oversizedTreeFetch })),
    ).rejects.toMatchObject({ code: "oversize" });
    expect(treeCancelled).toBe(true);

    let blobCancelled = false;
    let blobChunks = 0;
    const manifestPath = "plugins/build-ios-apps/.codex-plugin/plugin.json";
    const oversizedBlobFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return Response.json(treeJson([manifestPath]));
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024));
            blobChunks += 1;
            if (blobChunks === 3) controller.close();
          },
          cancel() {
            blobCancelled = true;
          },
        }),
      );
    }) as typeof fetch;
    await expect(
      fetchPinnedUpstreamPackage(
        input({
          fetch: oversizedBlobFetch,
          limits: { maximumFileBytes: 1024 },
        }),
      ),
    ).rejects.toMatchObject({ code: "oversize" });
    expect(blobCancelled).toBe(true);
  });

  it("rejects unsafe references before any network call", async () => {
    const { fetch, calls } = fakeFetch(completeFiles);
    for (const bad of [
      { ...reference, commit: "main" },
      { ...reference, owner: "evil/owner" },
      { ...reference, packagePath: "../secrets" },
      { ...reference, packagePath: "/etc/passwd" },
    ]) {
      await expect(
        fetchPinnedUpstreamPackage(input({ fetch, reference: bad })),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(calls).toHaveLength(0);
    expect(PinnedUpstreamFetchError.prototype).toBeInstanceOf(Error);
  });
});
