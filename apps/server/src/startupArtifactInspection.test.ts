import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  encodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  type HeadlessArtifactManifest,
} from "@octant/host-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./persistence/migrations";
import { latestStoreVersion, runStartupArtifactInspection } from "./startupArtifactInspection";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const CONTENTS: ReadonlyArray<readonly [string, string, string]> = [
  ["server", "lib/server/main.mjs", "server-bytes"],
  ["cli", "bin/octant", "cli-bytes"],
  ["web-assets", "share/web/index.html", "<html></html>"],
  ["native-module", "lib/native/better_sqlite3.node", "native-bytes"],
  ["migrations", "share/migrations.json", "{}"],
  ["notices", "share/NOTICES.txt", "notices"],
  ["service-template", "share/service/octant.service.template", "[Unit]"],
];

function writeArtifact(storeVersion: number): string {
  const root = mkdtempSync(join(tmpdir(), "octant-startup-artifact-"));
  directories.push(root);
  const manifest: HeadlessArtifactManifest = {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: "3.0.0",
    target: {
      platform: process.platform === "darwin" ? "darwin" : "linux",
      arch: process.arch === "arm64" ? "arm64" : "x64",
    },
    wireVersion: "1",
    storeVersion,
    components: CONTENTS.map(([role, path, contents]) => ({
      role: role as HeadlessArtifactManifest["components"][number]["role"],
      path,
      sha256: createHash("sha256").update(contents).digest("hex"),
      byteLength: Buffer.byteLength(contents),
      ...(role === "server" || role === "cli" || role === "web-assets" ? { version: "3.0.0" } : {}),
    })),
  };
  for (const [, path, contents] of CONTENTS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  writeFileSync(
    join(root, HEADLESS_ARTIFACT_MANIFEST_FILENAME),
    encodeHeadlessArtifactManifest(manifest),
  );
  return root;
}

describe("startup artifact inspection", () => {
  it("derives the supported store version from the latest migration", () => {
    expect(latestStoreVersion()).toBe(MIGRATIONS.at(-1)!.version);
  });

  it("skips inspection when the runtime is not a packaged headless artifact", async () => {
    await expect(runStartupArtifactInspection({ env: {} })).resolves.toBeUndefined();
  });

  it("accepts a matching artifact before ownership", async () => {
    const root = writeArtifact(latestStoreVersion());
    const result = await runStartupArtifactInspection({
      env: { OCTANT_ARTIFACT_ROOT: root },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a store-version mismatch between artifact manifest and runtime", async () => {
    const root = writeArtifact(latestStoreVersion() + 5);
    const result = await runStartupArtifactInspection({
      env: { OCTANT_ARTIFACT_ROOT: root },
    });
    expect(result).toMatchObject({
      ok: false,
      rejection: { code: "incompatible-store-version" },
    });
  });

  it("rejects tampered components and malformed manifests", async () => {
    const tampered = writeArtifact(latestStoreVersion());
    writeFileSync(join(tampered, "lib/server/main.mjs"), "tampered");
    await expect(
      runStartupArtifactInspection({ env: { OCTANT_ARTIFACT_ROOT: tampered } }),
    ).resolves.toMatchObject({ ok: false, rejection: { code: "component-mismatch" } });

    const malformed = writeArtifact(latestStoreVersion());
    writeFileSync(join(malformed, HEADLESS_ARTIFACT_MANIFEST_FILENAME), "{broken");
    await expect(
      runStartupArtifactInspection({ env: { OCTANT_ARTIFACT_ROOT: malformed } }),
    ).resolves.toMatchObject({ ok: false, rejection: { code: "malformed-manifest" } });
  });

  it("rejects native-module load failures through the injected probe", async () => {
    const root = writeArtifact(latestStoreVersion());
    await expect(
      runStartupArtifactInspection({
        env: { OCTANT_ARTIFACT_ROOT: root },
        loadNativeModule: () => {
          throw new Error("dlopen failure");
        },
      }),
    ).resolves.toMatchObject({ ok: false, rejection: { code: "native-module-failure" } });
  });

  it("rejects a cross-target artifact on this host", async () => {
    const root = writeArtifact(latestStoreVersion());
    const result = await runStartupArtifactInspection({
      env: { OCTANT_ARTIFACT_ROOT: root },
      platform: process.platform === "darwin" ? "linux" : "darwin",
    });
    expect(result).toMatchObject({ ok: false, rejection: { code: "wrong-platform" } });
  });
});
