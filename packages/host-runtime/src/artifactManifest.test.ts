import { describe, expect, it } from "vitest";
import {
  decodeHeadlessArtifactManifest,
  encodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  HeadlessArtifactManifestError,
  type HeadlessArtifactManifest,
} from "./artifactManifest";

function validManifest(): HeadlessArtifactManifest {
  return {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: "1.2.3",
    target: { platform: "linux", arch: "x64" },
    wireVersion: "1",
    storeVersion: 12,
    components: [
      {
        role: "server",
        path: "lib/server/main.mjs",
        sha256: "a".repeat(64),
        byteLength: 10,
        version: "1.2.3",
      },
      {
        role: "cli",
        path: "bin/octant",
        sha256: "b".repeat(64),
        byteLength: 11,
        version: "1.2.3",
      },
      {
        role: "web-assets",
        path: "share/web/index.html",
        sha256: "c".repeat(64),
        byteLength: 12,
        version: "1.2.3",
      },
      {
        role: "native-module",
        path: "lib/native/better_sqlite3.node",
        sha256: "d".repeat(64),
        byteLength: 13,
      },
      {
        role: "migrations",
        path: "share/migrations.json",
        sha256: "e".repeat(64),
        byteLength: 14,
      },
      {
        role: "notices",
        path: "share/NOTICES.txt",
        sha256: "f".repeat(64),
        byteLength: 15,
      },
      {
        role: "service-template",
        path: "share/service/octant.service.template",
        sha256: "0".repeat(64),
        byteLength: 16,
      },
    ],
  };
}

describe("headless artifact manifest", () => {
  it("uses a stable manifest filename", () => {
    expect(HEADLESS_ARTIFACT_MANIFEST_FILENAME).toBe("octant-artifact.json");
  });

  it("round-trips a valid manifest for every supported target", () => {
    for (const target of [
      { platform: "darwin", arch: "arm64" },
      { platform: "linux", arch: "x64" },
      { platform: "linux", arch: "arm64" },
    ] as const) {
      const manifest = { ...validManifest(), target };
      const decoded = decodeHeadlessArtifactManifest(encodeHeadlessArtifactManifest(manifest));
      expect(decoded).toEqual(manifest);
      expect(Object.isFrozen(decoded)).toBe(true);
    }
  });

  it("encodes deterministically for identical manifests", () => {
    expect(encodeHeadlessArtifactManifest(validManifest())).toBe(
      encodeHeadlessArtifactManifest(validManifest()),
    );
  });

  it("rejects invalid JSON and oversized manifests", () => {
    expect(() => decodeHeadlessArtifactManifest("not json")).toThrow(HeadlessArtifactManifestError);
    const oversized = `${" ".repeat(300_000)}{}`;
    expect(() => decodeHeadlessArtifactManifest(oversized)).toThrow(HeadlessArtifactManifestError);
  });

  it("rejects unknown schema versions and foreign products", () => {
    for (const patch of [{ schemaVersion: 2 }, { product: "other-product" }]) {
      const raw = JSON.stringify({ ...validManifest(), ...patch });
      expect(() => decodeHeadlessArtifactManifest(raw)).toThrow(HeadlessArtifactManifestError);
    }
  });

  it("rejects unsupported platforms and architectures", () => {
    for (const target of [
      { platform: "win32", arch: "x64" },
      { platform: "darwin", arch: "x64" },
      { platform: "linux", arch: "ia32" },
    ]) {
      const raw = JSON.stringify({ ...validManifest(), target });
      expect(() => decodeHeadlessArtifactManifest(raw)).toThrow(HeadlessArtifactManifestError);
    }
  });

  it("rejects manifests with unexpected extra keys", () => {
    const raw = JSON.stringify({ ...validManifest(), extra: true });
    expect(() => decodeHeadlessArtifactManifest(raw)).toThrow(HeadlessArtifactManifestError);
  });

  it("requires every mandatory component role", () => {
    for (const role of [
      "server",
      "cli",
      "web-assets",
      "native-module",
      "migrations",
      "notices",
      "service-template",
    ]) {
      const manifest = validManifest();
      const raw = JSON.stringify({
        ...manifest,
        components: manifest.components.filter((component) => component.role !== role),
      });
      expect(() => decodeHeadlessArtifactManifest(raw)).toThrow(HeadlessArtifactManifestError);
    }
  });

  it("requires component versions on versioned roles", () => {
    const manifest = validManifest();
    const raw = JSON.stringify({
      ...manifest,
      components: manifest.components.map((component) =>
        component.role === "server" ? { ...component, version: undefined } : component,
      ),
    });
    expect(() => decodeHeadlessArtifactManifest(raw)).toThrow(HeadlessArtifactManifestError);
  });

  it("rejects unsafe or duplicate component paths", () => {
    const unsafePaths = [
      "/etc/octant",
      "../escape",
      "lib/../../escape",
      "lib\\windows",
      "lib/\0null",
      "",
    ];
    for (const path of unsafePaths) {
      const manifest = validManifest();
      const raw = JSON.stringify({
        ...manifest,
        components: manifest.components.map((component, index) =>
          index === 0 ? { ...component, path } : component,
        ),
      });
      expect(() => decodeHeadlessArtifactManifest(raw)).toThrow(HeadlessArtifactManifestError);
    }
    const manifest = validManifest();
    const duplicated = JSON.stringify({
      ...manifest,
      components: manifest.components.map((component, index) =>
        index === 1 ? { ...component, path: manifest.components[0]?.path } : component,
      ),
    });
    expect(() => decodeHeadlessArtifactManifest(duplicated)).toThrow(HeadlessArtifactManifestError);
  });

  it("rejects malformed digests, byte lengths, and store versions", () => {
    const manifest = validManifest();
    const withBadDigest = JSON.stringify({
      ...manifest,
      components: manifest.components.map((component, index) =>
        index === 0 ? { ...component, sha256: "zz".repeat(32) } : component,
      ),
    });
    expect(() => decodeHeadlessArtifactManifest(withBadDigest)).toThrow(
      HeadlessArtifactManifestError,
    );
    const withBadLength = JSON.stringify({
      ...manifest,
      components: manifest.components.map((component, index) =>
        index === 0 ? { ...component, byteLength: -1 } : component,
      ),
    });
    expect(() => decodeHeadlessArtifactManifest(withBadLength)).toThrow(
      HeadlessArtifactManifestError,
    );
    for (const storeVersion of [-1, 1.5, "12"]) {
      const raw = JSON.stringify({ ...manifest, storeVersion });
      expect(() => decodeHeadlessArtifactManifest(raw)).toThrow(HeadlessArtifactManifestError);
    }
  });

  it("refuses to encode an invalid manifest", () => {
    const manifest = { ...validManifest(), wireVersion: "" };
    expect(() => encodeHeadlessArtifactManifest(manifest)).toThrow(HeadlessArtifactManifestError);
  });
});
