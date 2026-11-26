import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isComputerDriverRelease,
  BUNDLED_CUA_DRIVER,
  stageComputerDriver,
  latestCompatibleComputerDriverRelease,
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

/** Answers the release listing and each release's published contract manifest. */
function upstream(versions: ReadonlyArray<string>, contracts: Readonly<Record<string, string>>) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("https://api.github.com/repos/trycua/cua/releases?"))
      return Response.json(url.endsWith("page=1") ? versions.map(release) : []);
    const tag = /\?ref=cua-driver-rs-v([0-9.]+)$/.exec(url)?.[1];
    const contract = tag === undefined ? undefined : contracts[tag];
    if (contract === undefined) return new Response("Not Found", { status: 404 });
    const manifest = JSON.stringify({ contract_version: contract, tools: [] });
    return Response.json({ encoding: "base64", content: Buffer.from(manifest).toString("base64") });
  });
}

describe("Verified Computer use driver releases", () => {
  it("offers the newest driver that speaks this build's contract and names the one that needs a newer Octant", async () => {
    const fetch = upstream(["0.62.1", "0.63.0", "0.64.0", "0.65.0"], {
      "0.63.0": "0.9.0",
      "0.64.0": "0.10.0",
      "0.65.0": "0.10.0",
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const found = await latestCompatibleComputerDriverRelease(
        "0.62.1",
        new AbortController().signal,
      );
      expect(found.release?.version).toBe("0.63.0");
      expect(found.needsNewerOctant).toBe("0.65.0");
      // Nothing is downloaded while choosing: only listings and manifests are read.
      expect(fetch.mock.calls.every(([url]) => url.startsWith("https://api.github.com/"))).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers no driver when every newer release speaks another contract", async () => {
    vi.stubGlobal("fetch", upstream(["0.62.1", "0.63.0"], { "0.63.0": "0.10.0" }));
    try {
      expect(
        await latestCompatibleComputerDriverRelease("0.62.1", new AbortController().signal),
      ).toEqual({ needsNewerOctant: "0.63.0" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to offer a driver whose contract manifest cannot be read", async () => {
    vi.stubGlobal("fetch", upstream(["0.62.1", "0.63.0"], {}));
    try {
      await expect(
        latestCompatibleComputerDriverRelease("0.62.1", new AbortController().signal),
      ).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("finds driver releases across bounded pages of the upstream monorepo", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          Array.from({ length: 20 }, () => ({ tag_name: "other-package-v1", assets: [] })),
        ),
      )
      .mockResolvedValueOnce(Response.json([release("0.25.0")]));
    fetch.mockResolvedValueOnce(
      Response.json({
        encoding: "base64",
        content: Buffer.from(JSON.stringify({ contract_version: "0.9.0" })).toString("base64"),
      }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      expect(
        (await latestCompatibleComputerDriverRelease("0.24.0", new AbortController().signal))
          .release?.version,
      ).toBe("0.25.0");
      expect(fetch).toHaveBeenCalledTimes(3);
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
  it("selects the newest stable driver tag without using the monorepo's prerelease flag", async () => {
    const listing = [
      release("0.24.0"),
      release("0.25.0"),
      release("0.26.0-nightly"),
      { ...release("0.27.0"), draft: true },
    ];
    const fetch = upstream([], { "0.25.0": "0.9.0", "0.27.0": "0.9.0" });
    fetch.mockResolvedValueOnce(Response.json(listing));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(
        (await latestCompatibleComputerDriverRelease("0.24.0", new AbortController().signal))
          .release?.version,
      ).toBe("0.25.0");
    } finally {
      vi.unstubAllGlobals();
    }
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
