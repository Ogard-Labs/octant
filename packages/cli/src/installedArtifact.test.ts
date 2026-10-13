import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { HEADLESS_ARTIFACT_MANIFEST_FILENAME } from "@octant/host-runtime";
import {
  installedArtifactServerStartCommand,
  resolveInstalledArtifactRoot,
} from "./installedArtifact";

describe("installed artifact layout", () => {
  it("recognises an artifact only by the manifest beside bin/", () => {
    const moduleUrl = pathToFileURL("/opt/octant/versions/1.0.0/bin/octant").href;
    const withManifest = (path: string) =>
      path === "/opt/octant/versions/1.0.0/octant-artifact.json";
    expect(resolveInstalledArtifactRoot(moduleUrl, withManifest)).toBe(
      "/opt/octant/versions/1.0.0",
    );
    expect(resolveInstalledArtifactRoot(moduleUrl, () => false)).toBeUndefined();
  });

  it("starts the artifact's own server and points it at the artifact to verify and serve", () => {
    expect(
      installedArtifactServerStartCommand("/opt/octant/versions/1.0.0", "/usr/local/bin/bun"),
    ).toEqual({
      command: "/usr/local/bin/bun",
      args: ["/opt/octant/versions/1.0.0/lib/server/main.mjs"],
      env: {
        OCTANT_ARTIFACT_ROOT: "/opt/octant/versions/1.0.0",
        OCTANT_WEB_DIST_PATH: "/opt/octant/versions/1.0.0/share/web",
      },
    });
  });

  it("passes the artifact's stamped version to the host it starts", () => {
    const root = mkdtempSync(join(tmpdir(), "octant-artifact-version-"));
    try {
      writeFileSync(
        join(root, HEADLESS_ARTIFACT_MANIFEST_FILENAME),
        JSON.stringify({ artifactVersion: " 1.2.3 " }),
      );
      expect(installedArtifactServerStartCommand(root, "/usr/local/bin/bun").env).toMatchObject({
        OCTANT_ARTIFACT_ROOT: root,
        OCTANT_ARTIFACT_VERSION: "1.2.3",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
