import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  computerDriverReleaseFromResponse,
  isComputerDriverRelease,
  BUNDLED_CUA_DRIVER,
  stageComputerDriver,
  latestComputerDriverRelease,
} from "./computerUseDriverRelease";

function release(version: string) {
  return {
    tag_name: `cua-driver-rs-v${version}`,
    prerelease: true,
    assets: [
      {
        name: `cua-driver-rs-${version}-darwin-universal-binary.tar.gz`,
        browser_download_url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/cua-driver-rs-${version}-darwin-universal-binary.tar.gz`,
        digest: `sha256:${"a".repeat(64)}`,
      },
    ],
  };
}

describe("Verified Computer use driver releases", () => {
  it("finds driver releases across bounded pages of the upstream monorepo", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          Array.from({ length: 20 }, () => ({ tag_name: "other-package-v1", assets: [] })),
        ),
      )
      .mockResolvedValueOnce(Response.json([release("0.25.0")]));
    vi.stubGlobal("fetch", fetch);
    try {
      expect((await latestComputerDriverRelease(new AbortController().signal)).version).toBe(
        "0.25.0",
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0]?.[0]).toBe(
        "https://api.github.com/repos/trycua/cua/releases?per_page=20&page=1",
      );
      expect(fetch.mock.calls[1]?.[0]).toBe(
        "https://api.github.com/repos/trycua/cua/releases?per_page=20&page=2",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("selects the newest stable driver tag without using the monorepo's prerelease flag", () => {
    expect(
      computerDriverReleaseFromResponse([
        release("0.24.0"),
        release("0.25.0"),
        release("0.26.0-nightly"),
        { ...release("0.27.0"), draft: true },
      ])?.version,
    ).toBe("0.25.0");
    expect(
      isComputerDriverRelease({ ...BUNDLED_CUA_DRIVER, url: "https://example.com/cua-driver" }),
    ).toBe(false);
    expect(isComputerDriverRelease({ ...BUNDLED_CUA_DRIVER, version: "../latest" })).toBe(false);
  });

  it("does not extract or execute downloaded bytes whose release hash does not match", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-driver-verification-"));
    try {
      await expect(
        stageComputerDriver(
          BUNDLED_CUA_DRIVER,
          root,
          new AbortController().signal,
          new Uint8Array([1, 2, 3]),
        ),
      ).rejects.toThrow("hash");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
