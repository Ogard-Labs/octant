import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  electronDownloadApi,
  ensureCiElectron,
  fetchElectronAsset,
  installedElectron,
  isUpstreamElectronDownloadFailure,
  recoverCiElectron,
  recoveryTargetFromEnvironment,
  requireCiInstallerHost,
  runElectronInstaller,
} from "./ensure-ci-electron";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const version = "43.7.11";
const archive = `electron-v${version}-darwin-arm64.zip`;
const payload = Buffer.from("owned archive fixture; never an executable");
const checksum = createHash("sha256").update(payload).digest("hex");
const target = installedElectron({ version }, { [archive]: checksum }, "darwin", "arm64");
const assetUrl = "https://api.github.com/repos/electron/electron/releases/assets/123";
const release = {
  tag_name: `v${version}`,
  draft: false,
  assets: [
    {
      id: 123,
      name: archive,
      url: assetUrl,
      browser_download_url: `https://github.com/electron/electron/releases/download/v${version}/${archive}`,
    },
  ],
};
const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "octant-electron-recovery-test-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const responseFixture = (
  options: {
    readonly metadata?: unknown;
    readonly redirect?: string;
    readonly bytes?: Uint8Array;
  } = {},
) =>
  vi.fn(async (url: string, _init: RequestInit): Promise<Response> => {
    if (url.includes("/releases/tags/")) return Response.json(options.metadata ?? release);
    if (url === assetUrl)
      return new Response(null, {
        status: 302,
        headers: {
          location:
            options.redirect ??
            "https://release-assets.githubusercontent.com/owned/asset?fixture=1",
        },
      });
    if (url.startsWith("https://release-assets.githubusercontent.com/"))
      return new Response(new Uint8Array(options.bytes ?? payload).buffer);
    throw Error("Unexpected fixture request.");
  });

describe("pinned Electron CI recovery", () => {
  it("supports only hosts with an owned installer termination route", () => {
    expect(() => requireCiInstallerHost("win32")).not.toThrow();
    expect(() => requireCiInstallerHost("freebsd")).toThrow(/unsupported/);
    expect(() => requireCiInstallerHost("darwin")).not.toThrow();
    expect(() => requireCiInstallerHost("linux")).not.toThrow();
  });

  it("joins an owned installer on cancellation without selecting a Windows PID or process group", async () => {
    const root = await temporary();
    const ready = join(root, "ready");
    const fixture = join(root, "installer.cjs");
    await writeFile(
      fixture,
      `require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid) + "\\n"); process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 8000);`,
    );
    const owner = new AbortController();
    const running = runElectronInstaller(fixture, owner.signal);
    try {
      const deadline = Date.now() + 6000;
      // The installer creates the ready file before it writes its pid into it,
      // so a read can land in between and see an empty or partial file. A
      // Windows runner read "" there and compared it with the pid. Only the
      // closing newline says the pid is whole.
      let pid: string | undefined;
      while (pid === undefined && Date.now() < deadline) {
        const written = await readFile(ready, "utf8").catch(() => undefined);
        if (written?.endsWith("\n") === true) pid = written.trimEnd();
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (pid === undefined) throw Error("Owned installer did not become ready.");
      const captured = vi.mocked(spawn).mock.results.at(-1);
      if (captured?.type !== "return") throw Error("Owned installer was not spawned.");
      const child = captured.value;
      expect(String(child.pid)).toBe(pid);
      const killed = vi.spyOn(child, "kill");
      owner.abort();
      expect(await running).toEqual({ ok: false, upstreamFailure: false });
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(spawn).toHaveBeenLastCalledWith(
        "node",
        [fixture],
        expect.objectContaining({ detached: process.platform !== "win32" }),
      );
      if (process.platform === "win32") expect(killed).toHaveBeenCalledWith("SIGTERM");
      else expect(killed).not.toHaveBeenCalled();
    } finally {
      owner.abort();
      await running.catch(() => undefined);
    }
  }, 12000);

  it("cancels refused HTTP bodies and an accepted body whose destination cannot be opened", async () => {
    const root = await temporary();
    for (const stage of ["metadata", "asset", "destination"] as const) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
        },
        cancel,
      });
      const destination = join(root, stage);
      if (stage === "destination") await writeFile(destination, "existing fixture");
      const fetcher = async (url: string): Promise<Response> => {
        if (url.includes("/releases/tags/") && stage !== "metadata") return Response.json(release);
        return new Response(stream, { status: stage === "destination" ? 200 : 503 });
      };
      await expect(
        fetchElectronAsset({
          target,
          destination,
          signal: new AbortController().signal,
          fetch: fetcher,
        }),
      ).rejects.toThrow();
      expect(cancel).toHaveBeenCalledTimes(1);
      if (stage === "destination")
        expect(await readFile(destination, "utf8")).toBe("existing fixture");
      else await expect(stat(destination)).rejects.toThrow();
    }
  });

  it("recognizes upstream failures without treating checksum, extraction or missing assets as network errors", () => {
    expect(
      isUpstreamElectronDownloadFailure("HTTPError: Response code 504 (Gateway Timeout)"),
    ).toBe(true);
    expect(isUpstreamElectronDownloadFailure("RequestError: connect ETIMEDOUT")).toBe(true);
    for (const message of [
      "SHA256 checksum mismatch",
      "Cannot load native extraction binding",
      "HTTPError: Response code 404 for electron-v43.7.504.zip",
      "The installer exceeded its deadline.",
    ])
      expect(isUpstreamElectronDownloadFailure(message)).toBe(false);
  });

  it("keeps a successful normal installation independent of recovery", async () => {
    const recover = vi.fn();
    const install = vi.fn(async () => ({ ok: true, upstreamFailure: false }));
    expect(await ensureCiElectron({ signal: new AbortController().signal, install, recover })).toBe(
      "normal",
    );
    expect(install).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not retry extraction failures or cancellation through another download", async () => {
    for (const aborted of [false, true]) {
      const owner = new AbortController();
      if (aborted) owner.abort();
      const recover = vi.fn();
      const install = vi.fn(async () => ({ ok: false, upstreamFailure: aborted }));
      await expect(ensureCiElectron({ signal: owner.signal, install, recover })).rejects.toThrow();
      expect(recover).not.toHaveBeenCalled();
    }
  });

  it("uses the official asset without forwarding API authorization to its CDN", async () => {
    const root = await temporary();
    const fetcher = responseFixture();
    const destination = join(root, archive);
    await fetchElectronAsset({
      target,
      destination,
      signal: new AbortController().signal,
      token: "owned-fixture-token",
      fetch: fetcher,
    });
    expect(await readFile(destination)).toEqual(payload);
    expect(
      fetcher.mock.calls.map(([, init]) => new Headers(init.headers).get("authorization")),
    ).toEqual(["Bearer owned-fixture-token", "Bearer owned-fixture-token", null]);
    expect(fetcher.mock.calls.every(([, init]) => init.redirect !== "follow")).toBe(true);
  });

  it("refuses changed version, name, asset identity and off-site redirects before writing bytes", async () => {
    const root = await temporary();
    for (const options of [
      { metadata: { ...release, tag_name: "v43.7.12" } },
      { metadata: { ...release, assets: [{ ...release.assets[0], name: "another.zip" }] } },
      {
        metadata: {
          ...release,
          assets: [
            { ...release.assets[0], url: "https://api.github.com/repos/another/release/123" },
          ],
        },
      },
      { redirect: "https://example.com/untrusted" },
      { redirect: "http://release-assets.githubusercontent.com/untrusted" },
    ]) {
      const destination = join(root, archive);
      await expect(
        fetchElectronAsset({
          target,
          destination,
          signal: new AbortController().signal,
          fetch: responseFixture(options),
        }),
      ).rejects.toThrow();
      await expect(stat(destination)).rejects.toThrow();
    }
    expect(() =>
      installedElectron({ version: "43.7.12" }, { [archive]: checksum }, "darwin", "arm64"),
    ).toThrow();
    expect(() =>
      installedElectron({ version }, { [archive]: checksum }, "darwin", "x64"),
    ).toThrow();
    expect(() =>
      recoveryTargetFromEnvironment({ ELECTRON_MIRROR: "https://example.com" }),
    ).toThrow();
    expect(() => recoveryTargetFromEnvironment({ ELECTRON_INSTALL_ARCH: "x64" })).toThrow();
  });

  it("never runs the installer again after a checksum mismatch and removes the rejected bytes", async () => {
    const root = await temporary();
    const destination = join(root, archive);
    const install = vi.fn(async () => ({ ok: false, upstreamFailure: true }));
    await expect(
      ensureCiElectron({
        signal: new AbortController().signal,
        install,
        recover: () =>
          fetchElectronAsset({
            target,
            destination,
            signal: new AbortController().signal,
            fetch: responseFixture({ bytes: Buffer.from("wrong archive") }),
          }),
      }),
    ).rejects.toThrow(/checksum/);
    expect(install).toHaveBeenCalledTimes(1);
    await expect(stat(destination)).rejects.toThrow();
  });

  it("populates the normal public cache and checksum manifest before normal installer verification", async () => {
    const root = await temporary();
    const get = await electronDownloadApi(resolve("../node_modules/electron/package.json"));
    const signal = new AbortController().signal;
    const fetcher = responseFixture();
    const standard = `https://github.com/electron/electron/releases/download/v${version}/`;
    let attempts = 0;
    const install = async () => {
      if (++attempts === 1) return { ok: false, upstreamFailure: true };
      const downloader = {
        download: async () => {
          throw Error("A normal cache read unexpectedly downloaded bytes.");
        },
      };
      const common = { version, cacheMode: 0, cacheRoot: root, tempDirectory: root, downloader };
      const cached = await get.downloadArtifact({
        ...common,
        artifactName: "electron",
        platform: "darwin",
        arch: "arm64",
        checksums: target.checksums,
        mirrorOptions: { resolveAssetURL: async () => `${standard}${archive}` },
      });
      expect(await readFile(cached)).toEqual(payload);
      const manifest = await get.downloadArtifact({
        ...common,
        artifactName: "SHASUMS256.txt",
        isGeneric: true,
        mirrorOptions: { resolveAssetURL: async () => `${standard}SHASUMS256.txt` },
      });
      expect(await readFile(manifest, "utf8")).toBe(`${checksum} *${archive}\n`);
      return { ok: true, upstreamFailure: false };
    };
    expect(
      await ensureCiElectron({
        signal,
        install,
        recover: () => recoverCiElectron({ target, get, signal, cacheRoot: root, fetch: fetcher }),
      }),
    ).toBe("recovered");
    expect(attempts).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not report success if normal verification still fails after verified recovery", async () => {
    const install = vi.fn(async () => ({ ok: false, upstreamFailure: true }));
    const recover = vi.fn(async () => undefined);
    await expect(
      ensureCiElectron({ signal: new AbortController().signal, install, recover }),
    ).rejects.toThrow(/did not verify/);
    expect(install).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(1);
  });
});
