import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHeadlessArtifact, type HeadlessComponentSource } from "./package-headless";
import { signHeadlessArtifactDirectory } from "./sign-headless-artifact";
import {
  findNodeModulesAncestor,
  verifyDownloadedBuild,
  installedCliEnvironment,
  serviceDescriptorPath,
} from "./smoke-headless-install";

describe("headless install smoke isolation", () => {
  it("finds a node_modules directory anywhere above the prefix", () => {
    const present = new Set(["/home/person/checkout/node_modules"]);
    const exists = (path: string) => present.has(path);
    expect(findNodeModulesAncestor("/home/person/checkout/out/prefix", exists)).toBe(
      "/home/person/checkout",
    );
    expect(findNodeModulesAncestor("/home/person/prefix", exists)).toBeUndefined();
  });

  it("names the service descriptor that server start would replace", () => {
    expect(serviceDescriptorPath("linux", "/home/person")).toBe(
      "/home/person/.config/systemd/user/octant.service",
    );
    expect(serviceDescriptorPath("darwin", "/Users/person")).toBe(
      "/Users/person/Library/LaunchAgents/app.octant.server.plist",
    );
  });

  it("gives the installed CLI no module search path from the caller's shell", () => {
    const environment = installedCliEnvironment({
      source: {
        HOME: "/home/person",
        NODE_PATH: "/home/person/checkout/node_modules",
        OCTANT_SERVER_ROOT: "/home/person/checkout/apps/server",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      bunDirectory: "/home/person/.bun/bin",
      dataDirectory: "/tmp/prefix/data",
      port: 14_001,
    });
    expect(environment).toEqual({
      HOME: "/home/person",
      PATH: "/home/person/.bun/bin:/usr/bin:/bin",
      OCTANT_DATA_DIR: "/tmp/prefix/data",
      OCTANT_SERVER_PORT: "14001",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });
});

describe("headless install smoke on a downloaded build", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  async function builtArtifact() {
    const base = mkdtempSync(join(tmpdir(), "octant-headless-smoke-check-"));
    roots.push(base);
    const files: ReadonlyArray<readonly [HeadlessComponentSource["role"], string]> = [
      ["server", "lib/server/main.mjs"],
      ["cli", "bin/octant"],
      ["web-assets", "share/web/index.html"],
      ["native-module", "lib/native/better_sqlite3.node"],
      ["migrations", "share/migrations.json"],
      ["notices", "share/NOTICES.txt"],
      ["service-template", "share/service/octant.service.template"],
    ];
    const components = files.map(([role, path]) => {
      const source = join(base, "sources", path.replaceAll("/", "_"));
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, `${role}\n`);
      return { role, path, source };
    });
    return await buildHeadlessArtifact({
      version: "1.2.3",
      target: { platform: "linux", arch: "arm64" },
      wireVersion: "1",
      storeVersion: 1,
      components,
      outputDirectory: join(base, "out"),
    });
  }

  it("refuses to run a downloaded build that the release keys did not sign", async () => {
    const built = await builtArtifact();
    expect(await verifyDownloadedBuild(built.artifactRoot)).toMatchObject({ status: "refused" });
  });

  it("accepts a downloaded build signed by a key trusted for its ring", async () => {
    const built = await builtArtifact();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trust = {
      stable: [],
      preview: [publicKey.export({ format: "der", type: "spki" }).toString("base64")],
      candidate: [],
    };
    await signHeadlessArtifactDirectory({
      artifactRoot: built.artifactRoot,
      ring: "preview",
      privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      trustedKeys: trust,
    });
    expect(await verifyDownloadedBuild(built.artifactRoot, trust)).toEqual({ status: "verified" });
  });

  it("refuses a signed build that carries files its manifest does not list", async () => {
    const built = await builtArtifact();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trust = {
      stable: [],
      preview: [publicKey.export({ format: "der", type: "spki" }).toString("base64")],
      candidate: [],
    };
    await signHeadlessArtifactDirectory({
      artifactRoot: built.artifactRoot,
      ring: "preview",
      privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      trustedKeys: trust,
    });
    mkdirSync(join(built.artifactRoot, "lib", "server", "node_modules"), { recursive: true });
    writeFileSync(join(built.artifactRoot, "lib", "server", "node_modules", "planted.js"), "x");
    expect(await verifyDownloadedBuild(built.artifactRoot, trust)).toMatchObject({
      status: "refused",
    });
  });
});
