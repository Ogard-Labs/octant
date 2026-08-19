import { describe, expect, it, vi } from "vitest";
import type { AppUpdateRelease, AppVersion } from "@octant/contracts/app-updates";
import {
  canonicalReleaseBytes,
  compareAppVersions,
  resolveUpdateInstallReadiness,
  resolveUpdateOffer,
} from "./appUpdatePolicy";

const version = (value: string) => value as AppVersion;
const signature = `${"A".repeat(86)}==`;

function feed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    release: {
      version: "0.3.0",
      platform: "darwin",
      arch: "arm64",
      url: "https://updates.example.test/Octant-0.3.0-arm64.zip",
      sha256: "a".repeat(64),
      releasedAt: "2026-08-19T09:00:00.000Z",
      ...(overrides.release as Record<string, unknown> | undefined),
    },
    signature,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "release")),
  };
}

const app = { version: version("0.2.0"), platform: "darwin", arch: "arm64" };
const accept = () => true;
const reject = () => false;

describe("resolveUpdateOffer", () => {
  it("offers a signed release that is newer and built for this machine", () => {
    const result = resolveUpdateOffer({ document: feed(), app, verifySignature: accept });

    expect(result.kind).toBe("offer");
    expect(result.kind === "offer" ? String(result.release.version) : undefined).toBe("0.3.0");
  });

  it("refuses a release whose signature does not verify", () => {
    const result = resolveUpdateOffer({ document: feed(), app, verifySignature: reject });

    expect(result).toEqual({ kind: "refuse", refusal: "untrusted-signature" });
  });

  it("refuses without believing anything the document claims", () => {
    // An unsigned document's version number is not evidence, so the signature
    // is checked before any field is read. A verifier that says no must not be
    // reachable past by a document that looks appealing.
    const verifySignature = vi.fn(() => false);

    const result = resolveUpdateOffer({
      document: feed({ release: { version: "99.0.0" } }),
      app,
      verifySignature,
    });

    expect(result).toEqual({ kind: "refuse", refusal: "untrusted-signature" });
    expect(verifySignature).toHaveBeenCalledOnce();
  });

  it("treats a verifier that threw as a refusal, not as consent", () => {
    const result = resolveUpdateOffer({
      document: feed(),
      app,
      verifySignature: () => {
        throw new Error("key unavailable");
      },
    });

    expect(result).toEqual({ kind: "refuse", refusal: "untrusted-signature" });
  });

  it("refuses a feed it cannot parse rather than reading what it can", () => {
    expect(
      resolveUpdateOffer({ document: { nonsense: true }, app, verifySignature: accept }),
    ).toEqual({ kind: "refuse", refusal: "malformed" });
    expect(
      resolveUpdateOffer({ document: "not a document", app, verifySignature: accept }),
    ).toEqual({ kind: "refuse", refusal: "malformed" });
  });

  it("refuses a payload served over plain HTTP", () => {
    const result = resolveUpdateOffer({
      document: feed({ release: { url: "http://updates.example.test/Octant.zip" } }),
      app,
      verifySignature: accept,
    });

    expect(result).toEqual({ kind: "refuse", refusal: "malformed" });
  });

  it("refuses a release for another platform or architecture", () => {
    expect(
      resolveUpdateOffer({
        document: feed({ release: { platform: "win32" } }),
        app,
        verifySignature: accept,
      }),
    ).toEqual({ kind: "refuse", refusal: "malformed" });
    expect(
      resolveUpdateOffer({
        document: feed(),
        app: { ...app, arch: "x64" },
        verifySignature: accept,
      }),
    ).toEqual({ kind: "refuse", refusal: "wrong-platform" });
  });

  it("refuses a downgrade and refuses the version already running", () => {
    // Both are how a feed would walk an install back to a version with a known
    // hole, so neither counts as newer.
    expect(
      resolveUpdateOffer({
        document: feed({ release: { version: "0.1.0" } }),
        app,
        verifySignature: accept,
      }),
    ).toEqual({ kind: "refuse", refusal: "not-newer" });
    expect(
      resolveUpdateOffer({
        document: feed({ release: { version: "0.2.0" } }),
        app,
        verifySignature: accept,
      }),
    ).toEqual({ kind: "refuse", refusal: "not-newer" });
  });

  it("refuses a prerelease of the version already running", () => {
    expect(
      resolveUpdateOffer({
        document: feed({ release: { version: "0.2.0-rc.1" } }),
        app,
        verifySignature: accept,
      }),
    ).toEqual({ kind: "refuse", refusal: "not-newer" });
  });
});

describe("canonicalReleaseBytes", () => {
  it("covers every field the app decides from", () => {
    const release = {
      version: version("0.3.0"),
      platform: "darwin",
      arch: "arm64",
      url: "https://updates.example.test/Octant.zip",
      sha256: "b".repeat(64),
      releasedAt: "2026-08-19T09:00:00.000Z",
    } as unknown as AppUpdateRelease;
    const canonical = new TextDecoder().decode(canonicalReleaseBytes(release));

    // Where the bytes come from and which bytes they must be are both inside
    // the signature; a signature that covered neither would be decoration.
    for (const covered of ["url", "sha256", "version", "platform", "arch", "releasedAt"]) {
      expect(canonical).toContain(`"${covered}"`);
    }
  });

  it("signs the same release identically however the server spaced its JSON", () => {
    const base = {
      version: version("0.3.0"),
      platform: "darwin",
      arch: "arm64",
      url: "https://updates.example.test/Octant.zip",
      sha256: "c".repeat(64),
      releasedAt: "2026-08-19T09:00:00.000Z",
    } as unknown as AppUpdateRelease;
    const reordered = {
      releasedAt: base.releasedAt,
      arch: base.arch,
      sha256: base.sha256,
      version: base.version,
      url: base.url,
      platform: base.platform,
    } as unknown as AppUpdateRelease;

    expect(canonicalReleaseBytes(reordered)).toEqual(canonicalReleaseBytes(base));
  });

  it("distinguishes releases that differ only in where the bytes come from", () => {
    const release = {
      version: version("0.3.0"),
      platform: "darwin",
      arch: "arm64",
      url: "https://updates.example.test/Octant.zip",
      sha256: "d".repeat(64),
      releasedAt: "2026-08-19T09:00:00.000Z",
    } as unknown as AppUpdateRelease;
    const elsewhere = { ...release, url: "https://attacker.invalid/Octant.zip" };

    expect(canonicalReleaseBytes(elsewhere)).not.toEqual(canonicalReleaseBytes(release));
  });
});

describe("compareAppVersions", () => {
  it("orders releases by number rather than by text", () => {
    expect(compareAppVersions(version("0.10.0"), version("0.9.0"))).toBeGreaterThan(0);
    expect(compareAppVersions(version("1.0.0"), version("0.999.999"))).toBeGreaterThan(0);
    expect(compareAppVersions(version("1.2.3"), version("1.2.3"))).toBe(0);
  });

  it("sorts a prerelease below the release it leads to", () => {
    expect(compareAppVersions(version("1.0.0-rc.1"), version("1.0.0"))).toBeLessThan(0);
    expect(compareAppVersions(version("1.0.0"), version("1.0.0-rc.1"))).toBeGreaterThan(0);
  });

  it("counts numeric prerelease identifiers as numbers", () => {
    expect(compareAppVersions(version("1.0.0-rc.2"), version("1.0.0-rc.10"))).toBeLessThan(0);
  });
});

describe("resolveUpdateInstallReadiness", () => {
  it("applies an update when nothing is running", () => {
    expect(
      resolveUpdateInstallReadiness({ activeAgentCount: 0, attentionRequired: false }),
    ).toEqual({ kind: "ready" });
  });

  it("waits while an agent is still running, and says what it is waiting for", () => {
    // Relaunching under live work loses whatever had not been journaled, so the
    // person lets it finish or checkpoints it.
    expect(
      resolveUpdateInstallReadiness({ activeAgentCount: 2, attentionRequired: false }),
    ).toEqual({ kind: "wait", activeAgentCount: 2, attentionRequired: false });
  });

  it("waits on an unanswered approval even when nothing is running", () => {
    // A question the person has not answered is work in flight; restarting
    // throws the question away.
    expect(resolveUpdateInstallReadiness({ activeAgentCount: 0, attentionRequired: true })).toEqual(
      {
        kind: "wait",
        activeAgentCount: 0,
        attentionRequired: true,
      },
    );
  });
});
