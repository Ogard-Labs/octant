import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveResponse,
  releaseMetadata,
  removeOwnedBrowserDriverCache,
  requireBrowserDriverRedirect,
  requirePinnedBrowserDriverRelease,
} from "./packaged-browser-owner-driver-cache";

const release = () => ({
  tag_name: "cua-driver-rs-v0.38.0",
  draft: false,
  prerelease: true,
  assets: [
    {
      id: 661454894,
      name: "cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
      state: "uploaded",
      size: 53208248,
      digest: "sha256:2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
      browser_download_url:
        "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
      url: "https://api.github.com/repos/trycua/cua/releases/assets/661454894",
    },
  ],
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the owned native Browser driver cache", () => {
  it("authenticates the fixed driver metadata API and retries transient failures", async () => {
    vi.stubEnv("OCTANT_QA_GITHUB_TOKEN", "synthetic-workflow-token");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(Response.json(release()));
    vi.stubGlobal("fetch", fetcher);
    expect(await releaseMetadata(new AbortController().signal)).toEqual(release());
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe(
        "https://api.github.com/repos/trycua/cua/releases/tags/cua-driver-rs-v0.38.0",
      );
      expect(options).toMatchObject({
        redirect: "manual",
        headers: { authorization: "Bearer synthetic-workflow-token" },
      });
    }
  });

  it("keeps the workflow token out of the driver archive redirect", async () => {
    vi.stubEnv("OCTANT_QA_GITHUB_TOKEN", "synthetic-workflow-token");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://release-assets.githubusercontent.com/github-production-release-asset/925270205/owned",
          },
        }),
      )
      .mockResolvedValueOnce(new Response("owned"));
    vi.stubGlobal("fetch", fetcher);
    expect(await (await archiveResponse(new AbortController().signal)).text()).toBe("owned");
    expect(fetcher.mock.calls[0]?.[1].headers.authorization).toBe(
      "Bearer synthetic-workflow-token",
    );
    expect(fetcher.mock.calls[1]?.[1].headers).toEqual({
      accept: "application/octet-stream",
      "user-agent": "Octant native QA",
    });
  });

  it("requires the exact pinned prerelease, asset identity, size and bundled digest", () => {
    expect(() => requirePinnedBrowserDriverRelease(release())).not.toThrow();
    for (const invalid of [
      { ...release(), tag_name: "cua-driver-rs-v0.38.1" },
      { ...release(), draft: true },
      { ...release(), prerelease: false },
      { ...release(), assets: [...release().assets, ...release().assets] },
      { ...release(), assets: release().assets.map((asset) => ({ ...asset, id: 1 })) },
      { ...release(), assets: release().assets.map((asset) => ({ ...asset, size: 1 })) },
      {
        ...release(),
        assets: release().assets.map((asset) => ({ ...asset, digest: "sha256:changed" })),
      },
      {
        ...release(),
        assets: release().assets.map((asset) => ({ ...asset, url: "https://untrusted.invalid" })),
      },
    ])
      expect(() => requirePinnedBrowserDriverRelease(invalid)).toThrow();
  });

  it("permits only a credential-free HTTPS asset redirect for the pinned repository", () => {
    const path = "/github-production-release-asset/925270205/74649bed-0c9d-4725-958e-18639ebe7e83";
    expect(
      requireBrowserDriverRedirect(
        `https://release-assets.githubusercontent.com${path}?signed=synthetic`,
      ).hostname,
    ).toBe("release-assets.githubusercontent.com");
    for (const invalid of [
      `http://release-assets.githubusercontent.com${path}`,
      `https://untrusted.invalid${path}`,
      `https://user:synthetic@release-assets.githubusercontent.com${path}`,
      `https://release-assets.githubusercontent.com:8443${path}`,
      `https://release-assets.githubusercontent.com${path.replace("925270205", "9384267")}`,
      `https://release-assets.githubusercontent.com${path}#fragment`,
    ])
      expect(() => requireBrowserDriverRedirect(invalid)).toThrow();
  });

  it("removes all children of only the matching workflow attempt's private cache", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-driver-cache-test.")));
    const cache = join(root, ".computer-use-driver"),
      owner = "owned-synthetic-attempt";
    try {
      await mkdir(cache, { mode: 0o700 });
      await writeFile(join(cache, "owned-browser-driver-seed.txt"), owner, {
        flag: "wx",
        mode: 0o600,
      });
      await mkdir(join(cache, "0.38.0"), { mode: 0o700 });
      await writeFile(join(cache, "0.38.0", "fixture"), "owned synthetic bytes");
      await expect(removeOwnedBrowserDriverCache(root, "different-attempt")).rejects.toThrow();
      expect(await readFile(join(cache, "0.38.0", "fixture"), "utf8")).toBe(
        "owned synthetic bytes",
      );
      await removeOwnedBrowserDriverCache(root, owner);
      await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(removeOwnedBrowserDriverCache(root, owner)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("refuses an unmarked directory and a linked cache without deleting their contents", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-driver-cache-test.")));
    const cache = join(root, ".computer-use-driver");
    try {
      await mkdir(cache, { mode: 0o700 });
      await writeFile(join(cache, "fixture"), "preserve");
      await expect(
        removeOwnedBrowserDriverCache(root, "owned-synthetic-attempt"),
      ).rejects.toThrow();
      expect(await readFile(join(cache, "fixture"), "utf8")).toBe("preserve");
      await rm(cache, { recursive: true });
      const target = join(root, "other-owned-directory");
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, "fixture"), "preserve");
      await symlink(target, cache);
      await expect(
        removeOwnedBrowserDriverCache(root, "owned-synthetic-attempt"),
      ).rejects.toThrow();
      expect(await readFile(join(target, "fixture"), "utf8")).toBe("preserve");
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
