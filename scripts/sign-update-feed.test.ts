import { createPublicKey, verify } from "node:crypto";
import { decodeAppUpdateFeed, decodeAppVersion } from "@octant/contracts/app-updates";
import {
  canonicalReleaseBytes,
  canonicalReleaseBytesWithoutProduct,
  resolveNightlyInstallRelease,
  resolveUpdateOffer,
} from "@octant/domain";
import { describe, expect, it } from "vitest";
import {
  buildRelease,
  dryRunFeedDocument,
  feedRelativePath,
  generateFeedKeyPair,
  legacyFeedRelativePath,
  parseFeedCommand,
  printedFeedPath,
  refuseUntrustedSigningKey,
  resolveFeedSigningMaterial,
  sha256Hex,
  signFeed,
  signLegacyFeed,
} from "./sign-update-feed";

const ARTIFACT = new TextEncoder().encode("octant release bytes");

function release(overrides: Partial<Parameters<typeof buildRelease>[0]> = {}) {
  return buildRelease({
    version: "0.2.0",
    ring: "stable",
    flavor: overrides.ring === "preview" ? "nightly" : "stable",
    platform: "darwin",
    arch: "arm64",
    url: "https://github.com/Ogard-Labs/octant/releases/download/v0.2.0/Octant.zip",
    sha256: sha256Hex(ARTIFACT),
    releasedAt: "2026-08-28T09:00:00.000Z",
    ...overrides,
  });
}

describe("signing an update feed", () => {
  it("produces a feed the app accepts as an offer", () => {
    const keys = generateFeedKeyPair();
    const feed = signFeed(release(), keys.privateKey);
    const publicKey = createPublicKey({
      key: Buffer.from(keys.publicKey, "base64"),
      format: "der",
      type: "spki",
    });

    const offer = resolveUpdateOffer({
      document: JSON.parse(JSON.stringify(feed)),
      app: {
        version: decodeAppVersion("0.1.0"),
        platform: "darwin",
        arch: "arm64",
        product: "octant",
        ring: "stable",
      },
      verifySignature: (message, signature) =>
        verify(null, message, publicKey, Buffer.from(signature, "base64")),
    });

    expect(offer).toEqual({ kind: "offer", release: feed.release });
  });

  it("refuses a candidate feed served where a stable app is looking", () => {
    const keys = generateFeedKeyPair();
    // The stable key may also sign candidates, so this is the check that keeps
    // the rings separate: a genuine candidate release moved to the stable
    // address is still correctly signed, and must still be refused.
    const feed = signFeed(
      release({ version: "0.2.0-candidate.20260828.1", ring: "candidate" }),
      keys.privateKey,
    );
    const publicKey = createPublicKey({
      key: Buffer.from(keys.publicKey, "base64"),
      format: "der",
      type: "spki",
    });

    const offer = resolveUpdateOffer({
      document: JSON.parse(JSON.stringify(feed)),
      app: {
        version: decodeAppVersion("0.1.0"),
        platform: "darwin",
        arch: "arm64",
        product: "octant",
        ring: "stable",
      },
      verifySignature: (message, signature) =>
        verify(null, message, publicKey, Buffer.from(signature, "base64")),
    });

    expect(offer).toEqual({ kind: "refuse", refusal: "wrong-ring" });
  });

  it("signs the ring, so switching it in a published feed breaks the signature", () => {
    const keys = generateFeedKeyPair();
    const feed = signFeed(release(), keys.privateKey);
    const publicKey = createPublicKey({
      key: Buffer.from(keys.publicKey, "base64"),
      format: "der",
      type: "spki",
    });

    const tampered = decodeAppUpdateFeed({
      ...JSON.parse(JSON.stringify(feed)),
      release: { ...JSON.parse(JSON.stringify(feed.release)), ring: "preview" },
    });

    expect(
      verify(
        null,
        canonicalReleaseBytes(tampered.release),
        publicKey,
        Buffer.from(tampered.signature, "base64"),
      ),
    ).toBe(false);
  });

  it("refuses to build a release whose artifact lives somewhere insecure", () => {
    expect(() => release({ url: "http://example.invalid/Octant.zip" })).toThrow();
  });

  it("names the file a ring is published under", () => {
    expect(feedRelativePath(release({ ring: "stable" }))).toBe("stable/darwin-arm64.json");
    // Not the names older installs read: those hold the bridge feed, the last
    // Octant preview, or the candidate's old-shape document.
    expect(feedRelativePath(release({ ring: "preview" }))).toBe(
      "preview/darwin-arm64.octant-nightly.json",
    );
    expect(feedRelativePath(release({ ring: "candidate" }))).toBe(
      "candidate/darwin-arm64.octant.json",
    );
  });

  it("names the linux-x64 dogfood feed the same way as macOS", () => {
    expect(feedRelativePath(release({ ring: "stable", platform: "linux", arch: "x64" }))).toBe(
      "stable/linux-x64.json",
    );
    expect(feedRelativePath(release({ ring: "preview", platform: "linux", arch: "x64" }))).toBe(
      "preview/linux-x64.octant-nightly.json",
    );
  });

  it("dry-runs a linux-x64 feed path without writing a signature", () => {
    const { release: document, feedPath } = dryRunFeedDocument({
      version: "0.2.0",
      ring: "preview",
      flavor: "nightly",
      platform: "linux",
      arch: "x64",
      url: "https://github.com/Ogard-Labs/octant/releases/download/v0.2.0/Octant-0.2.0-linux-x64.AppImage",
      sha256: sha256Hex(ARTIFACT),
      releasedAt: "2026-08-28T09:00:00.000Z",
    });
    expect(feedPath).toBe("preview/linux-x64.octant-nightly.json");
    expect(document.platform).toBe("linux");
    expect(document.arch).toBe("x64");
    expect(document.ring).toBe("preview");
  });

  it("names the app from the build's flavor, inside the signature", () => {
    expect(release().product).toBe("octant");
    expect(release({ ring: "candidate" }).product).toBe("octant");
    expect(release({ ring: "preview", version: "0.2.0-preview.20261106.80" }).product).toBe(
      "octant-nightly",
    );
  });

  it("refuses a flavor published on a ring that is not its own", () => {
    expect(() => release({ ring: "preview", flavor: "stable" })).toThrow(/Octant is not published/);
    expect(() => release({ ring: "candidate", flavor: "nightly" })).toThrow(
      /Octant Nightly is not published/,
    );
  });

  it("signs a Nightly feed that Octant refuses and the Nightly installer accepts", () => {
    const keys = generateFeedKeyPair();
    const feed = signFeed(
      release({ ring: "preview", version: "0.2.0-preview.20261106.80" }),
      keys.privateKey,
    );
    const publicKey = createPublicKey({
      key: Buffer.from(keys.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    const verifySignature = (message: Uint8Array, signature: string) =>
      verify(null, message, publicKey, Buffer.from(signature, "base64"));
    const document = JSON.parse(JSON.stringify(feed));

    expect(
      resolveUpdateOffer({
        document,
        app: {
          version: decodeAppVersion("0.1.0-preview.20261104.71"),
          platform: "darwin",
          arch: "arm64",
          product: "octant",
          ring: "preview",
        },
        verifySignature,
      }),
    ).toEqual({ kind: "refuse", refusal: "wrong-app" });
    expect(
      resolveNightlyInstallRelease({
        document,
        platform: "darwin",
        arch: "arm64",
        verifySignature,
      }),
    ).toEqual({ kind: "offer", release: feed.release });
  });

  it("writes the old shape only for an Octant candidate, verifiable as older installs verify it", () => {
    const keys = generateFeedKeyPair();
    const candidate = release({ ring: "candidate", version: "0.2.0-candidate.20261106.81" });
    const legacy = signLegacyFeed(candidate, keys.privateKey);
    const publicKey = createPublicKey({
      key: Buffer.from(keys.publicKey, "base64"),
      format: "der",
      type: "spki",
    });

    expect(legacy.release).not.toHaveProperty("product");
    expect(legacyFeedRelativePath(candidate)).toBe("candidate/darwin-arm64.preview-key.json");
    expect(
      verify(
        null,
        canonicalReleaseBytesWithoutProduct(legacy.release),
        publicKey,
        Buffer.from(legacy.signature, "base64"),
      ),
    ).toBe(true);
    // The old preview names were read by Octant builds; Nightly never goes there.
    expect(() =>
      signLegacyFeed(
        release({ ring: "preview", version: "0.2.0-preview.20261106.80" }),
        keys.privateKey,
      ),
    ).toThrow(/No old-shape feed/);
    expect(() => signLegacyFeed(release(), keys.privateKey)).toThrow(/No old-shape feed/);
  });

  it("prints the published file name the workflows upload", () => {
    const machine = ["--platform", "linux", "--arch", "x64"];
    expect(printedFeedPath(["--ring", "preview", ...machine])).toBe(
      "preview/linux-x64.octant-nightly.json",
    );
    expect(printedFeedPath(["--ring", "candidate", ...machine])).toBe(
      "candidate/linux-x64.octant.json",
    );
    expect(printedFeedPath(["--ring", "candidate", ...machine, "--legacy-document"])).toBe(
      "candidate/linux-x64.preview-key.json",
    );
    expect(() => printedFeedPath(["--ring", "preview", ...machine, "--legacy-document"])).toThrow();
  });

  it("refuses unsigned feed signing when the private key is missing", () => {
    expect(resolveFeedSigningMaterial("stable", {})).toEqual({
      kind: "unsigned-refuse",
      reason: expect.stringMatching(/OCTANT_UPDATE_FEED_PRIVATE_KEY/),
    });
  });

  it("signs preview and candidate feeds only with the preview secret", () => {
    // The preview workflow must never need the stable key, and an environment
    // that holds only the stable key cannot be mistaken for a preview signer.
    const environment = { OCTANT_UPDATE_FEED_PRIVATE_KEY: "stable-secret" };
    for (const ring of ["preview", "candidate"] as const) {
      expect(resolveFeedSigningMaterial(ring, environment)).toEqual({
        kind: "unsigned-refuse",
        reason: expect.stringMatching(/OCTANT_UPDATE_FEED_PREVIEW_PRIVATE_KEY/),
      });
      expect(
        resolveFeedSigningMaterial(ring, {
          OCTANT_UPDATE_FEED_PREVIEW_PRIVATE_KEY: "preview-secret",
        }),
      ).toEqual({ kind: "ready", privateKey: "preview-secret" });
    }
    expect(
      resolveFeedSigningMaterial("stable", {
        OCTANT_UPDATE_FEED_PREVIEW_PRIVATE_KEY: "preview-secret",
      }),
    ).toMatchObject({ kind: "unsigned-refuse" });
  });
});

describe("refusing a signing key the app does not trust for the ring", () => {
  const stable = generateFeedKeyPair();
  const preview = generateFeedKeyPair();
  const trusted = {
    stable: [stable.publicKey],
    preview: [preview.publicKey, stable.publicKey],
    candidate: [preview.publicKey, stable.publicKey],
  };

  it("refuses to sign a stable feed with the preview key", () => {
    expect(refuseUntrustedSigningKey(preview.privateKey, "stable", trusted)).toMatchObject({
      kind: "refused",
    });
  });

  it("signs each ring with a key that ring trusts", () => {
    expect(refuseUntrustedSigningKey(stable.privateKey, "stable", trusted)).toEqual({
      kind: "trusted",
    });
    expect(refuseUntrustedSigningKey(preview.privateKey, "preview", trusted)).toEqual({
      kind: "trusted",
    });
    expect(refuseUntrustedSigningKey(stable.privateKey, "candidate", trusted)).toEqual({
      kind: "trusted",
    });
  });

  it("refuses a key whose public half was never compiled into the app", () => {
    // What a preview release meets before the preview public key is set: the
    // job fails instead of publishing a feed every install refuses.
    const minted = generateFeedKeyPair();
    for (const ring of ["stable", "preview", "candidate"] as const) {
      expect(refuseUntrustedSigningKey(minted.privateKey, ring)).toMatchObject({
        kind: "refused",
        reason: expect.stringContaining(minted.publicKey),
      });
    }
  });
});

describe("reading the publish command", () => {
  const argv = [
    "--version",
    "0.2.0",
    "--ring=stable",
    "--flavor",
    "stable",
    "--platform",
    "darwin",
    "--arch",
    "arm64",
    "--url",
    "https://example.test/Octant.zip",
    "--artifact",
    "/tmp/Octant.zip",
    "--released-at",
    "2026-08-28T09:00:00.000Z",
    "--out",
    "/tmp/feed.json",
  ];

  it("reads both --flag value and --flag=value forms", () => {
    expect(parseFeedCommand(argv)).toEqual({
      version: "0.2.0",
      ring: "stable",
      flavor: "stable",
      legacyDocument: false,
      platform: "darwin",
      arch: "arm64",
      url: "https://example.test/Octant.zip",
      artifact: "/tmp/Octant.zip",
      releasedAt: "2026-08-28T09:00:00.000Z",
      out: "/tmp/feed.json",
    });
  });

  it("refuses a ring it does not publish", () => {
    expect(() => parseFeedCommand([...argv, "--ring", "nightly"])).toThrow(
      /release ring \(stable, preview, candidate\)/,
    );
  });

  it("accepts the candidate ring a manual run publishes", () => {
    expect(parseFeedCommand([...argv, "--ring", "candidate"]).ring).toBe("candidate");
  });

  it("reads the old-shape switch and refuses an unknown flavor", () => {
    expect(parseFeedCommand([...argv, "--legacy-document"]).legacyDocument).toBe(true);
    expect(() => parseFeedCommand([...argv, "--flavor", "beta"])).toThrow(/--flavor/);
    expect(() => parseFeedCommand(argv.filter((value) => value !== "--flavor"))).toThrow();
  });

  it("refuses a missing field rather than signing a release built from guesses", () => {
    expect(() => parseFeedCommand(argv.filter((value) => value !== "--url"))).toThrow(/--url/);
  });
});
