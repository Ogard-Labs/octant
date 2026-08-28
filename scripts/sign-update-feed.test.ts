import { createPublicKey, verify } from "node:crypto";
import { decodeAppUpdateFeed, decodeAppVersion } from "@octant/contracts/app-updates";
import { canonicalReleaseBytes, resolveUpdateOffer } from "@octant/domain";
import { describe, expect, it } from "vitest";
import {
  buildRelease,
  dryRunFeedDocument,
  feedRelativePath,
  generateFeedKeyPair,
  parseFeedCommand,
  resolveFeedSigningMaterial,
  sha256Hex,
  signFeed,
} from "./sign-update-feed";

const ARTIFACT = new TextEncoder().encode("octant release bytes");

function release(overrides: Partial<Parameters<typeof buildRelease>[0]> = {}) {
  return buildRelease({
    version: "0.2.0",
    ring: "stable",
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
        ring: "stable",
      },
      verifySignature: (message, signature) =>
        verify(null, message, publicKey, Buffer.from(signature, "base64")),
    });

    expect(offer).toEqual({ kind: "offer", release: feed.release });
  });

  it("refuses a preview feed served where a stable app is looking", () => {
    const keys = generateFeedKeyPair();
    // The same key signs both rings, so this is the check that keeps them
    // separate: a genuine preview release moved to the stable address is still
    // correctly signed, and must still be refused.
    const feed = signFeed(
      release({ version: "0.2.0-preview.20260828", ring: "preview" }),
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
    expect(feedRelativePath(release({ ring: "preview" }))).toBe("preview/darwin-arm64.json");
  });

  it("names the linux-x64 dogfood feed the same way as macOS", () => {
    expect(feedRelativePath(release({ ring: "stable", platform: "linux", arch: "x64" }))).toBe(
      "stable/linux-x64.json",
    );
    expect(feedRelativePath(release({ ring: "preview", platform: "linux", arch: "x64" }))).toBe(
      "preview/linux-x64.json",
    );
  });

  it("dry-runs a linux-x64 feed path without writing a signature", () => {
    const { release: document, feedPath } = dryRunFeedDocument({
      version: "0.2.0",
      ring: "preview",
      platform: "linux",
      arch: "x64",
      url: "https://github.com/Ogard-Labs/octant/releases/download/v0.2.0/Octant-0.2.0-linux-x64.AppImage",
      sha256: sha256Hex(ARTIFACT),
      releasedAt: "2026-08-28T09:00:00.000Z",
    });
    expect(feedPath).toBe("preview/linux-x64.json");
    expect(document.platform).toBe("linux");
    expect(document.arch).toBe("x64");
    expect(document.ring).toBe("preview");
  });

  it("refuses unsigned feed signing when the private key is missing", () => {
    expect(resolveFeedSigningMaterial({})).toEqual({
      kind: "unsigned-refuse",
      reason: expect.stringMatching(/OCTANT_UPDATE_FEED_PRIVATE_KEY/),
    });
  });
});

describe("reading the publish command", () => {
  const argv = [
    "--version",
    "0.2.0",
    "--ring=stable",
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
      platform: "darwin",
      arch: "arm64",
      url: "https://example.test/Octant.zip",
      artifact: "/tmp/Octant.zip",
      releasedAt: "2026-08-28T09:00:00.000Z",
      out: "/tmp/feed.json",
    });
  });

  it("refuses a ring it does not publish", () => {
    expect(() => parseFeedCommand([...argv, "--ring", "nightly"])).toThrow(/stable or preview/);
  });

  it("refuses a missing field rather than signing a release built from guesses", () => {
    expect(() => parseFeedCommand(argv.filter((value) => value !== "--url"))).toThrow(/--url/);
  });
});
