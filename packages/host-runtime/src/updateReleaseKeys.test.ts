import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReleaseFeedVerifier, RELEASE_TRUSTED_KEYS } from "./updateReleaseKeys";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const everyRing = { stable: [publicKey], preview: [publicKey], candidate: [publicKey] };
const message = new TextEncoder().encode("release bytes");

describe("the release keys a host checks a feed against", () => {
  it("verifies a feed signed by a trusted key and refuses a changed one", () => {
    const verifier = createReleaseFeedVerifier(everyRing);
    const signature = sign(null, message, pair.privateKey).toString("base64");

    expect(verifier.verify(message, signature, "stable")).toBe(true);
    expect(verifier.verify(new TextEncoder().encode("tampered"), signature, "stable")).toBe(false);
  });

  it("refuses a signature from a key the ring does not trust", () => {
    const other = generateKeyPairSync("ed25519");
    const verifier = createReleaseFeedVerifier(everyRing);

    expect(
      verifier.verify(message, sign(null, message, other.privateKey).toString("base64"), "preview"),
    ).toBe(false);
  });

  it("refuses everything when a ring has no usable key", () => {
    const verifier = createReleaseFeedVerifier({
      stable: [""],
      preview: ["nonsense"],
      candidate: [],
    });
    const signature = sign(null, message, pair.privateKey).toString("base64");

    expect(verifier.configured("stable")).toBe(false);
    expect(verifier.configured("preview")).toBe(false);
    expect(verifier.verify(message, signature, "candidate")).toBe(false);
  });

  it("ships a usable stable key and lets only the stable key sign stable", () => {
    expect(createReleaseFeedVerifier().configured("stable")).toBe(true);
    expect(RELEASE_TRUSTED_KEYS.stable).toHaveLength(1);
    expect(RELEASE_TRUSTED_KEYS.preview).toEqual(
      expect.arrayContaining([...RELEASE_TRUSTED_KEYS.stable]),
    );
  });
});
