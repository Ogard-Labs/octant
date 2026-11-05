import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppReleaseRing, AppUpdateRelease, AppVersion } from "@octant/contracts/app-updates";
import { canonicalReleaseBytes } from "@octant/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedVerifier } from "./appUpdateFeed";
import {
  createNightlyInstaller,
  NIGHTLY_BUNDLE_IDENTIFIER,
  nightlyInstallerAuthority,
  nightlyInstallLocation,
  type NightlyInstallerRole,
} from "./nightlyInstaller";

const stableKeys = generateKeyPairSync("ed25519");
const previewKeys = generateKeyPairSync("ed25519");
const strangerKeys = generateKeyPairSync("ed25519");
const exported = (pair: typeof stableKeys) =>
  pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const trust = {
  stable: [exported(stableKeys)],
  preview: [exported(previewKeys), exported(stableKeys)],
  candidate: [exported(previewKeys), exported(stableKeys)],
};

const archiveBytes = Buffer.from("octant-nightly-0.3.0-preview-arm64.zip");
const nightlyRelease = {
  version: "0.3.0-preview.20261105.2",
  platform: "darwin",
  arch: "arm64",
  ring: "preview",
  url: "https://downloads.example.test/Octant-Nightly-0.3.0-preview.20261105.2-arm64.zip",
  sha256: createHash("sha256").update(archiveBytes).digest("hex"),
  releasedAt: "2026-11-05T02:00:00.000Z",
};

function signedBy(pair: typeof stableKeys, over: Partial<Record<string, unknown>> = {}): unknown {
  const release = { ...nightlyRelease, ...over } as unknown as AppUpdateRelease;
  return {
    schemaVersion: 1,
    release,
    signature: sign(null, canonicalReleaseBytes(release), pair.privateKey).toString("base64"),
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-nightly-installer-"));
  await mkdir(join(root, "Applications", "Octant.app", "Contents", "MacOS"), { recursive: true });
  await mkdir(join(root, "tmp"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A bundle on disk whose Info.plist stand-in names one bundle id. */
async function bundle(path: string, identifier: string): Promise<void> {
  await mkdir(join(path, "Contents"), { recursive: true });
  await writeFile(join(path, "Contents", "Info.plist"), identifier);
}

function installer(
  options: {
    readonly role?: Partial<NightlyInstallerRole>;
    readonly document?: unknown;
    readonly serves?: Buffer;
    readonly executablePath?: string;
    readonly verdict?: unknown;
    readonly extracts?: string;
  } = {},
) {
  const nightlyPath = join(root, "Applications", "Octant Nightly.app");
  const fetchImpl = vi.fn(async (input: string) => {
    if (input.includes("/preview/darwin-arm64.preview-key.json")) {
      return Response.json(options.document ?? signedBy(previewKeys));
    }
    if (input.startsWith(nightlyRelease.url)) {
      const bytes = options.serves ?? archiveBytes;
      return new Response(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const native = {
    verifyNightly: vi.fn(async (_path: string) => options.verdict ?? { kind: "verified" }),
    openNightly: vi.fn(async (_path: string) => ({ kind: "started" })),
  };
  const extract = vi.fn(async (_archive: string, destination: string) => {
    await bundle(
      join(destination, options.extracts ?? "Octant Nightly.app"),
      NIGHTLY_BUNDLE_IDENTIFIER,
    );
  });
  const trash = vi.fn(async (path: string) => {
    await rm(path, { recursive: true });
  });
  const role: NightlyInstallerRole = {
    packaged: true,
    flavor: "stable",
    platform: "darwin",
    ring: "candidate" as AppReleaseRing,
    ...options.role,
  };
  const subject = createNightlyInstaller({
    role: () => role,
    executablePath:
      options.executablePath ??
      join(root, "Applications", "Octant.app", "Contents", "MacOS", "Octant"),
    feedBaseUrl: "https://updates.example.test",
    app: { version: "0.2.0-candidate.20261101.1" as AppVersion, platform: "darwin", arch: "arm64" },
    temporaryDirectory: join(root, "tmp"),
    native: () => native,
    trash,
    verifier: createFeedVerifier(trust),
    fetchImpl,
    extract,
    readBundleIdentifier: async (path) => {
      try {
        return await readFile(join(path, "Contents", "Info.plist"), "utf8");
      } catch {
        return undefined;
      }
    },
  });
  return { subject, fetchImpl, native, extract, trash, nightlyPath };
}

describe("where Nightly goes", () => {
  it("places Nightly beside the running Octant and nowhere else", () => {
    expect(nightlyInstallLocation("/Applications/Octant.app/Contents/MacOS/Octant")).toEqual({
      kind: "location",
      octant: "/Applications/Octant.app",
      nightly: "/Applications/Octant Nightly.app",
    });
  });

  it("refuses a launch that is not a plain Octant bundle or was translocated", () => {
    for (const path of [
      "/Applications/Other.app/Contents/MacOS/Octant",
      "relative/Octant.app/Contents/MacOS/Octant",
      "/private/var/folders/x/AppTranslocation/ABC/d/Octant.app/Contents/MacOS/Octant",
      "/Applications/../tmp/Octant.app/Contents/MacOS/Octant",
      "/usr/local/bin/octant",
    ]) {
      expect(nightlyInstallLocation(path)).toEqual({
        kind: "refused",
        refusal: "unsupported-install",
      });
    }
  });
});

describe("who may manage Nightly", () => {
  const base: NightlyInstallerRole = {
    packaged: true,
    flavor: "stable",
    platform: "darwin",
    ring: "candidate",
  };

  it("lets only packaged Octant on Preview install, and never Nightly itself", () => {
    expect(nightlyInstallerAuthority(base)).toEqual({ kind: "manage", install: "allowed" });
    expect(nightlyInstallerAuthority({ ...base, ring: "stable" })).toEqual({
      kind: "manage",
      install: "not-on-preview",
    });
    expect(nightlyInstallerAuthority({ ...base, platform: "linux" })).toEqual({
      kind: "manage",
      install: "unsupported-platform",
    });
    expect(nightlyInstallerAuthority({ ...base, flavor: "nightly", ring: "preview" })).toEqual({
      kind: "none",
    });
    expect(nightlyInstallerAuthority({ ...base, packaged: false })).toEqual({ kind: "none" });
  });
});

describe("installing Octant Nightly", () => {
  it("installs a preview-signed, hash-matching, Nightly-signed build beside Octant", async () => {
    const { subject, native, nightlyPath, fetchImpl } = installer();

    expect(await subject.state()).toEqual({ status: "not-installed" });
    expect(await subject.install()).toEqual({ status: "installed" });

    expect(await readFile(join(nightlyPath, "Contents", "Info.plist"), "utf8")).toBe(
      NIGHTLY_BUNDLE_IDENTIFIER,
    );
    // The requirement check ran on the extracted copy, before it was moved.
    const [checked] = native.verifyNightly.mock.calls[0] as [string];
    expect(checked).not.toBe(nightlyPath);
    expect(checked.endsWith("/Octant Nightly.app")).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toContain(
      "https://updates.example.test/preview/darwin-arm64.preview-key.json",
    );
    // No download or staging folder is left behind.
    expect(await readdir(join(root, "tmp"))).toEqual([]);
    expect((await readdir(join(root, "Applications"))).sort()).toEqual([
      "Octant Nightly.app",
      "Octant.app",
    ]);
  });

  it("refuses when Octant is not packaged Octant on Preview, before any request", async () => {
    for (const role of [
      { ring: "stable" as const },
      { packaged: false },
      { flavor: "nightly" as const, ring: "preview" as const },
    ]) {
      const { subject, fetchImpl } = installer({ role });
      const result = await subject.install();
      expect(result.status === "installed").toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    const { subject } = installer({ role: { ring: "stable" } });
    expect(await subject.install()).toMatchObject({
      status: "not-installed",
      refusal: "not-on-preview",
    });
  });

  it("says installing is not supported on Linux and makes no request", async () => {
    const { subject, fetchImpl } = installer({ role: { platform: "linux" } });

    expect(await subject.state()).toEqual({ status: "unavailable" });
    expect(await subject.install()).toMatchObject({ refusal: "unsupported-platform" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a launch outside a plain Octant bundle without writing anywhere", async () => {
    const { subject, fetchImpl } = installer({
      executablePath: join(root, "Elsewhere", "Octant"),
    });

    expect(await subject.install()).toMatchObject({ refusal: "unsupported-install" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a feed signed for another ring, even by the stable key", async () => {
    const { subject, extract } = installer({
      document: signedBy(stableKeys, { version: "0.3.0-candidate.20261105.1", ring: "candidate" }),
    });

    expect(await subject.install()).toMatchObject({
      status: "not-installed",
      refusal: "wrong-ring",
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("refuses a feed signed by a key the preview ring does not trust", async () => {
    const { subject, extract } = installer({ document: signedBy(strangerKeys) });

    expect(await subject.install()).toMatchObject({ refusal: "untrusted-signature" });
    expect(extract).not.toHaveBeenCalled();
  });

  it("discards a download whose bytes do not match the signed hash", async () => {
    const { subject, extract, nightlyPath } = installer({ serves: Buffer.from("substituted") });

    expect(await subject.install()).toMatchObject({ refusal: "corrupt-artifact" });
    expect(extract).not.toHaveBeenCalled();
    await expect(readdir(nightlyPath)).rejects.toThrow();
  });

  it("never moves an app that fails Nightly's code requirement into place", async () => {
    const { subject, nightlyPath } = installer({
      verdict: { kind: "refused", reason: "invalid-peer" },
    });

    expect(await subject.install()).toMatchObject({
      status: "not-installed",
      refusal: "code-signature",
    });
    await expect(readdir(nightlyPath)).rejects.toThrow();
    expect(await readdir(join(root, "Applications"))).toEqual(["Octant.app"]);
  });

  it("says the signature check could not finish rather than blaming the publisher", async () => {
    const { subject } = installer({ verdict: { kind: "refused", reason: "deadline-exceeded" } });

    expect(await subject.install()).toMatchObject({ refusal: "check-unavailable" });
  });

  it("starts one install for two quick clicks", async () => {
    const { subject, fetchImpl } = installer();

    const [first, second] = await Promise.all([subject.install(), subject.install()]);

    expect(first).toEqual({ status: "installed" });
    expect(second.status === "installed" || second.status === "not-installed").toBe(true);
    expect(second.refusal).toBeUndefined();
    expect(
      vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).includes("preview-key")),
    ).toHaveLength(1);
  });

  it("refuses an archive that does not hold exactly Octant Nightly.app", async () => {
    const { subject, native } = installer({ extracts: "Something Else.app" });

    expect(await subject.install()).toMatchObject({ refusal: "code-signature" });
    expect(native.verifyNightly).not.toHaveBeenCalled();
  });

  it("leaves another app at the install location alone", async () => {
    const { subject, nightlyPath, fetchImpl } = installer();
    await bundle(nightlyPath, "com.example.other");

    expect(await subject.install()).toMatchObject({ refusal: "occupied" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(join(nightlyPath, "Contents", "Info.plist"), "utf8")).toBe(
      "com.example.other",
    );
  });

  it("replaces an installed Nightly with the verified one", async () => {
    const { subject, nightlyPath } = installer();
    await bundle(nightlyPath, NIGHTLY_BUNDLE_IDENTIFIER);
    await writeFile(join(nightlyPath, "old-build"), "");

    expect(await subject.install()).toEqual({ status: "installed" });
    expect(await readdir(nightlyPath)).toEqual(["Contents"]);
  });
});

describe("the Octant Nightly row after install", () => {
  it("keeps open and remove on Stable while Nightly is installed, and hides otherwise", async () => {
    const onStable = installer({ role: { ring: "stable" } });
    expect(await onStable.subject.state()).toEqual({ status: "unavailable" });

    await bundle(onStable.nightlyPath, NIGHTLY_BUNDLE_IDENTIFIER);
    expect(await onStable.subject.state()).toEqual({ status: "installed" });

    expect(await onStable.subject.open()).toEqual({ status: "installed" });
    expect(onStable.native.openNightly).toHaveBeenCalledWith(onStable.nightlyPath);

    expect(await onStable.subject.remove()).toEqual({ status: "unavailable" });
    expect(onStable.trash).toHaveBeenCalledWith(onStable.nightlyPath);
  });

  it("never shows the row in Nightly", async () => {
    const { subject, nightlyPath } = installer({ role: { flavor: "nightly", ring: "preview" } });
    await bundle(nightlyPath, NIGHTLY_BUNDLE_IDENTIFIER);

    expect(await subject.state()).toEqual({ status: "unavailable" });
    expect(await subject.remove()).toEqual({ status: "unavailable" });
  });

  it("refuses to open or trash an app that is not Octant Nightly", async () => {
    const { subject, nightlyPath, native, trash } = installer();
    await bundle(nightlyPath, "com.example.other");

    expect(await subject.open()).toMatchObject({ refusal: "not-installed" });
    expect(await subject.remove()).toMatchObject({ refusal: "not-installed" });
    expect(native.openNightly).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
  });
});
