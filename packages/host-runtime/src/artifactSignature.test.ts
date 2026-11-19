import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HeadlessArtifactManifest } from "./artifactManifest";
import {
  canonicalHeadlessArtifactManifestBytes,
  decodeHeadlessArtifactSignature,
  encodeHeadlessArtifactSignature,
  signHeadlessArtifactManifest,
  verifyHeadlessArtifactSignature,
} from "./artifactSignature";
import { createReleaseFeedVerifier } from "./updateReleaseKeys";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

const manifest: HeadlessArtifactManifest = {
  schemaVersion: 1,
  product: "octant",
  artifactVersion: "0.1.0-preview.20261119.1",
  target: { platform: "linux", arch: "x64" },
  wireVersion: "1",
  storeVersion: 3,
  components: [
    {
      role: "server",
      path: "lib/server/main.mjs",
      sha256: "a".repeat(64),
      byteLength: 10,
      version: "0.1.0-preview.20261119.1",
    },
  ],
};

describe("a headless build's signature", () => {
  it("verifies when a key the ring trusts signed this exact manifest", () => {
    const ringKey = keyPair();
    const verifier = createReleaseFeedVerifier({
      stable: [],
      preview: [ringKey.publicKeyBase64],
      candidate: [],
    });
    const signature = signHeadlessArtifactManifest(manifest, "preview", ringKey.privateKeyBase64);

    expect(
      verifyHeadlessArtifactSignature({
        manifest,
        signatureText: encodeHeadlessArtifactSignature(signature),
        verifier,
      }),
    ).toEqual({ status: "verified", ring: "preview" });
  });

  it("refuses a signature over a manifest that changed after signing", () => {
    const ringKey = keyPair();
    const verifier = createReleaseFeedVerifier({
      stable: [],
      preview: [ringKey.publicKeyBase64],
      candidate: [],
    });
    const signature = signHeadlessArtifactManifest(manifest, "preview", ringKey.privateKeyBase64);
    const changed: HeadlessArtifactManifest = { ...manifest, storeVersion: 4 };

    expect(
      verifyHeadlessArtifactSignature({
        manifest: changed,
        signatureText: encodeHeadlessArtifactSignature(signature),
        verifier,
      }),
    ).toEqual({ status: "refused", reason: "unverified" });
  });

  it("refuses a signature from a key the named ring does not trust", () => {
    const ringKey = keyPair();
    const stranger = keyPair();
    const verifier = createReleaseFeedVerifier({
      stable: [],
      preview: [ringKey.publicKeyBase64],
      candidate: [],
    });
    const signature = signHeadlessArtifactManifest(manifest, "preview", stranger.privateKeyBase64);

    expect(
      verifyHeadlessArtifactSignature({
        manifest,
        signatureText: encodeHeadlessArtifactSignature(signature),
        verifier,
      }),
    ).toEqual({ status: "refused", reason: "unverified" });
  });

  it("refuses a missing or malformed signature document", () => {
    const verifier = createReleaseFeedVerifier();
    expect(
      verifyHeadlessArtifactSignature({ manifest, signatureText: undefined, verifier }),
    ).toEqual({ status: "refused", reason: "missing" });
    for (const text of [
      "not json",
      JSON.stringify({ format: "octant-artifact-signature/1", ring: "nightly", signature: "AA==" }),
      JSON.stringify({ format: "other/1", ring: "preview", signature: "AA==" }),
      JSON.stringify({
        format: "octant-artifact-signature/1",
        ring: "preview",
        signature: "AA==",
        extra: 1,
      }),
    ]) {
      expect(decodeHeadlessArtifactSignature(text)).toBeUndefined();
      expect(verifyHeadlessArtifactSignature({ manifest, signatureText: text, verifier })).toEqual({
        status: "refused",
        reason: "malformed",
      });
    }
  });

  it("signs the manifest's content, not its key order or whitespace", () => {
    const reordered = JSON.parse(
      JSON.stringify({
        components: manifest.components,
        target: { arch: "x64", platform: "linux" },
        storeVersion: 3,
        wireVersion: "1",
        artifactVersion: manifest.artifactVersion,
        product: "octant",
        schemaVersion: 1,
      }),
    ) as HeadlessArtifactManifest;
    expect(canonicalHeadlessArtifactManifestBytes(reordered)).toEqual(
      canonicalHeadlessArtifactManifestBytes(manifest),
    );
  });
});
