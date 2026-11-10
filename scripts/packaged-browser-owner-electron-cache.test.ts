import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  officialAsset,
  requestOfficialQaApi,
  readRelease,
  requireOfficialElectronRedirect,
  requirePinnedElectronRelease,
  writeVerifiedElectronFile,
} from "./packaged-browser-owner-electron-cache";

const pinnedRelease = () => ({
  tag_name: "v43.7.11",
  draft: false,
  prerelease: false,
  assets: [
    {
      id: 638764792,
      name: "electron-v43.7.11-darwin-arm64.zip",
      state: "uploaded",
      size: 123515515,
      digest: "sha256:e60ad7fb9c030ddfb5005a6bc54712bc78c2d3e760f7f010fa5b997e956aaefa",
      url: "https://api.github.com/repos/electron/electron/releases/assets/638764792",
      browser_download_url:
        "https://github.com/electron/electron/releases/download/v43.7.11/electron-v43.7.11-darwin-arm64.zip",
    },
    {
      id: 638792834,
      name: "SHASUMS256.txt",
      state: "uploaded",
      size: 7680,
      digest: "sha256:511bcd0f740c686d5f4dab62ccb95d3b48db8ee2ad7ce5f943527fbca7e8735a",
      url: "https://api.github.com/repos/electron/electron/releases/assets/638792834",
      browser_download_url:
        "https://github.com/electron/electron/releases/download/v43.7.11/SHASUMS256.txt",
    },
  ],
});
const bytes = new TextEncoder().encode("owned synthetic archive bytes");
const proof = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the owned Browser QA Electron cache", () => {
  it("refuses non-release API destinations before sending the workflow token", async () => {
    vi.stubEnv("OCTANT_QA_GITHUB_TOKEN", "synthetic-workflow-token");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const url of [
      "https://untrusted.invalid/releases",
      "https://api.github.com/user",
      "https://api.github.com/repos/untrusted/repo/releases/assets/1",
      "https://api.github.com/repos/electron/electron/releases/assets/1?redirect=elsewhere",
    ]) {
      await expect(
        requestOfficialQaApi(url, "application/json", new AbortController().signal),
      ).rejects.toThrow("official release API");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries transient metadata failures with the workflow token on the fixed API only", async () => {
    vi.stubEnv("OCTANT_QA_GITHUB_TOKEN", "synthetic-workflow-token");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(Response.json(pinnedRelease()));
    vi.stubGlobal("fetch", fetcher);
    expect(await readRelease(new AbortController().signal)).toEqual(pinnedRelease());
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe("https://api.github.com/repos/electron/electron/releases/tags/v43.7.11");
      expect(options).toMatchObject({
        redirect: "manual",
        headers: { authorization: "Bearer synthetic-workflow-token" },
      });
    }
  });

  it("never forwards the workflow token to redirected release storage", async () => {
    vi.stubEnv("OCTANT_QA_GITHUB_TOKEN", "synthetic-workflow-token");
    const location =
      "https://release-assets.githubusercontent.com/github-production-release-asset/9384267/owned";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
      .mockResolvedValueOnce(new Response("owned"));
    vi.stubGlobal("fetch", fetcher);
    const response = await officialAsset(638764792, new AbortController().signal);
    expect(await response.text()).toBe("owned");
    expect(fetcher.mock.calls[0]?.[1].headers.authorization).toBe(
      "Bearer synthetic-workflow-token",
    );
    expect(fetcher.mock.calls[1]?.[1].headers).toEqual({ accept: "application/octet-stream" });
  });

  it("bounds retries and reports the HTTP status without response contents", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("private diagnostic", { status: 503 })),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(readRelease(new AbortController().signal)).rejects.toThrow(
      "unavailable (HTTP 503)",
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("requires the exact stable official release, assets and checksums", () => {
    expect(() => requirePinnedElectronRelease(pinnedRelease())).not.toThrow();
    for (const invalid of [
      { ...pinnedRelease(), tag_name: "v43.7.12" },
      { ...pinnedRelease(), draft: true },
      { ...pinnedRelease(), assets: [...pinnedRelease().assets, pinnedRelease().assets[0]] },
      { ...pinnedRelease(), assets: pinnedRelease().assets.map((asset) => ({ ...asset, id: 1 })) },
      {
        ...pinnedRelease(),
        assets: pinnedRelease().assets.map((asset) => ({ ...asset, size: 1 })),
      },
      {
        ...pinnedRelease(),
        assets: pinnedRelease().assets.map((asset) => ({ ...asset, digest: "sha256:changed" })),
      },
    ])
      expect(() => requirePinnedElectronRelease(invalid)).toThrow();
  });

  it("allows only the official repository asset redirect without credentials or alternate hosts", () => {
    const path = "/github-production-release-asset/9384267/be70749f-e61f-4cb2-b39a-cdfe9a60b310";
    expect(
      requireOfficialElectronRedirect(
        `https://release-assets.githubusercontent.com${path}?signed=synthetic`,
      ).hostname,
    ).toBe("release-assets.githubusercontent.com");
    for (const invalid of [
      `http://release-assets.githubusercontent.com${path}`,
      `https://untrusted.invalid${path}`,
      `https://user:secret@release-assets.githubusercontent.com${path}`,
      `https://release-assets.githubusercontent.com:8443${path}`,
      `https://release-assets.githubusercontent.com${path.replace("9384267", "1")}`,
      `https://release-assets.githubusercontent.com${path}#fragment`,
    ])
      expect(() => requireOfficialElectronRedirect(invalid)).toThrow();
  });

  it("writes only complete matching bytes and removes refused partial files", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-electron-cache-test."));
    try {
      const valid = join(root, "verified");
      await writeVerifiedElectronFile(
        new Response(bytes),
        valid,
        proof,
        new AbortController().signal,
      );
      expect(await readFile(valid)).toEqual(Buffer.from(bytes));
      for (const [name, changed] of [
        ["overflow", { ...proof, bytes: bytes.length - 1 }],
        ["short", { ...proof, bytes: bytes.length + 1 }],
        ["checksum", { ...proof, sha256: "0".repeat(64) }],
      ] as const) {
        const path = join(root, name);
        await expect(
          writeVerifiedElectronFile(
            new Response(bytes),
            path,
            changed,
            new AbortController().signal,
          ),
        ).rejects.toThrow();
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(
        writeVerifiedElectronFile(new Response(bytes), valid, proof, new AbortController().signal),
      ).rejects.toMatchObject({ code: "EEXIST" });
      const alias = join(root, "existing-alias");
      await symlink(valid, alias);
      await expect(
        writeVerifiedElectronFile(new Response(bytes), alias, proof, new AbortController().signal),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(valid)).toEqual(Buffer.from(bytes));
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("cancels a stalled owned response and removes its unfinished file", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-electron-cache-test."));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Error("Owned synthetic deadline.")), 20);
    try {
      const path = join(root, "stalled");
      await expect(
        writeVerifiedElectronFile(
          new Response(new ReadableStream()),
          path,
          proof,
          controller.signal,
        ),
      ).rejects.toThrow("Owned synthetic deadline.");
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearTimeout(timer);
      await rm(root, { recursive: true });
    }
  });
});
