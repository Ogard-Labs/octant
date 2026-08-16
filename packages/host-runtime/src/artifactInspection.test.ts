import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  type HeadlessArtifactManifest,
  type HeadlessArtifactTarget,
} from "./artifactManifest";
import { inspectHeadlessArtifact } from "./artifactInspection";

const ARTIFACT_VERSION = "2.0.0";
const CONTENTS: Record<string, string> = {
  "lib/server/main.mjs": "server-bundle",
  "bin/octant": "cli-bundle",
  "share/web/index.html": "<html></html>",
  "lib/native/better_sqlite3.node": "native-bytes",
  "share/migrations.json": '{"versions":[1,2]}',
  "share/NOTICES.txt": "notices",
  "share/service/octant.service.template": "[Unit]",
};

const ROLES: Record<
  string,
  "server" | "cli" | "web-assets" | "native-module" | "migrations" | "notices" | "service-template"
> = {
  "lib/server/main.mjs": "server",
  "bin/octant": "cli",
  "share/web/index.html": "web-assets",
  "lib/native/better_sqlite3.node": "native-module",
  "share/migrations.json": "migrations",
  "share/NOTICES.txt": "notices",
  "share/service/octant.service.template": "service-template",
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function manifestFor(target: HeadlessArtifactTarget): HeadlessArtifactManifest {
  return {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: ARTIFACT_VERSION,
    target,
    wireVersion: "1",
    storeVersion: 2,
    components: Object.entries(CONTENTS).map(([path, contents]) => {
      const role = ROLES[path] ?? "notices";
      return {
        role,
        path,
        sha256: createHash("sha256").update(contents).digest("hex"),
        byteLength: Buffer.byteLength(contents),
        ...(role === "server" || role === "cli" || role === "web-assets"
          ? { version: ARTIFACT_VERSION }
          : {}),
      };
    }),
  };
}

function writeArtifact(
  target: HeadlessArtifactTarget,
  mutate?: (manifest: HeadlessArtifactManifest) => HeadlessArtifactManifest,
): string {
  const root = mkdtempSync(join(tmpdir(), "octant-artifact-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(CONTENTS)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  const manifest = mutate === undefined ? manifestFor(target) : mutate(manifestFor(target));
  writeFileSync(
    join(root, HEADLESS_ARTIFACT_MANIFEST_FILENAME),
    encodeHeadlessArtifactManifest(manifest),
  );
  return root;
}

const linuxRuntime = {
  platform: "linux",
  arch: "x64",
  wireVersion: "1",
  storeVersion: 2,
} as const;

describe("headless artifact inspection", () => {
  it("accepts a matching artifact and reports its manifest", async () => {
    const root = writeArtifact({ platform: "linux", arch: "x64" });
    const loaded: string[] = [];
    const result = await inspectHeadlessArtifact({
      artifactRoot: root,
      runtime: linuxRuntime,
      loadNativeModule: (path) => {
        loaded.push(path);
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.artifactVersion).toBe(ARTIFACT_VERSION);
    expect(loaded).toEqual([join(root, "lib/native/better_sqlite3.node")]);
  });

  it("rejects a missing or malformed manifest", async () => {
    const missing = mkdtempSync(join(tmpdir(), "octant-artifact-"));
    roots.push(missing);
    const missingResult = await inspectHeadlessArtifact({
      artifactRoot: missing,
      runtime: linuxRuntime,
    });
    expect(missingResult).toMatchObject({ ok: false, rejection: { code: "malformed-manifest" } });

    const malformed = mkdtempSync(join(tmpdir(), "octant-artifact-"));
    roots.push(malformed);
    writeFileSync(join(malformed, HEADLESS_ARTIFACT_MANIFEST_FILENAME), "{}");
    const malformedResult = await inspectHeadlessArtifact({
      artifactRoot: malformed,
      runtime: linuxRuntime,
    });
    expect(malformedResult).toMatchObject({
      ok: false,
      rejection: { code: "malformed-manifest" },
    });
  });

  it("rejects the wrong platform and the wrong architecture", async () => {
    const macArtifact = writeArtifact({ platform: "darwin", arch: "arm64" });
    expect(
      await inspectHeadlessArtifact({ artifactRoot: macArtifact, runtime: linuxRuntime }),
    ).toMatchObject({ ok: false, rejection: { code: "wrong-platform" } });

    const armArtifact = writeArtifact({ platform: "linux", arch: "arm64" });
    expect(
      await inspectHeadlessArtifact({ artifactRoot: armArtifact, runtime: linuxRuntime }),
    ).toMatchObject({ ok: false, rejection: { code: "wrong-architecture" } });
  });

  it("rejects incompatible wire and store versions", async () => {
    const root = writeArtifact({ platform: "linux", arch: "x64" });
    expect(
      await inspectHeadlessArtifact({
        artifactRoot: root,
        runtime: { ...linuxRuntime, wireVersion: "2" },
      }),
    ).toMatchObject({ ok: false, rejection: { code: "incompatible-wire-version" } });
    expect(
      await inspectHeadlessArtifact({
        artifactRoot: root,
        runtime: { ...linuxRuntime, storeVersion: 9 },
      }),
    ).toMatchObject({ ok: false, rejection: { code: "incompatible-store-version" } });
  });

  it("skips the store-version comparison when the runtime does not pin one", async () => {
    const root = writeArtifact({ platform: "linux", arch: "x64" });
    const { storeVersion: _ignored, ...unpinned } = linuxRuntime;
    expect(await inspectHeadlessArtifact({ artifactRoot: root, runtime: unpinned })).toMatchObject({
      ok: true,
    });
  });

  it("rejects missing, altered, truncated, and symlinked components", async () => {
    const missingRoot = writeArtifact({ platform: "linux", arch: "x64" });
    rmSync(join(missingRoot, "bin/octant"));
    expect(
      await inspectHeadlessArtifact({ artifactRoot: missingRoot, runtime: linuxRuntime }),
    ).toMatchObject({
      ok: false,
      rejection: { code: "component-mismatch", component: "bin/octant", reason: "missing" },
    });

    const alteredRoot = writeArtifact({ platform: "linux", arch: "x64" });
    writeFileSync(join(alteredRoot, "lib/server/main.mjs"), "tampered-bytes");
    expect(
      await inspectHeadlessArtifact({ artifactRoot: alteredRoot, runtime: linuxRuntime }),
    ).toMatchObject({
      ok: false,
      rejection: { code: "component-mismatch", component: "lib/server/main.mjs" },
    });

    const symlinkRoot = writeArtifact({ platform: "linux", arch: "x64" });
    rmSync(join(symlinkRoot, "share/NOTICES.txt"));
    writeFileSync(join(symlinkRoot, "share/other.txt"), "notices");
    symlinkSync(join(symlinkRoot, "share/other.txt"), join(symlinkRoot, "share/NOTICES.txt"));
    expect(
      await inspectHeadlessArtifact({ artifactRoot: symlinkRoot, runtime: linuxRuntime }),
    ).toMatchObject({
      ok: false,
      rejection: { code: "component-mismatch", component: "share/NOTICES.txt" },
    });
  });

  it("rejects version-mismatched embedded components", async () => {
    const root = writeArtifact({ platform: "linux", arch: "x64" }, (manifest) => ({
      ...manifest,
      components: manifest.components.map((component) =>
        component.role === "cli" ? { ...component, version: "1.0.0" } : component,
      ),
    }));
    expect(
      await inspectHeadlessArtifact({ artifactRoot: root, runtime: linuxRuntime }),
    ).toMatchObject({
      ok: false,
      rejection: {
        code: "component-mismatch",
        component: "bin/octant",
        reason: "version-mismatch",
      },
    });
  });

  it("rejects native-module load failures", async () => {
    const root = writeArtifact({ platform: "linux", arch: "x64" });
    expect(
      await inspectHeadlessArtifact({
        artifactRoot: root,
        runtime: linuxRuntime,
        loadNativeModule: () => {
          throw new Error("dlopen failed");
        },
      }),
    ).toMatchObject({
      ok: false,
      rejection: {
        code: "native-module-failure",
        component: "lib/native/better_sqlite3.node",
      },
    });
  });
});
