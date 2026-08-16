import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { inspectHeadlessArtifact } from "@octant/host-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHeadlessArtifact,
  HEADLESS_ARTIFACT_TARGETS,
  headlessMigrationsMetadata,
  renderHeadlessServiceTemplate,
  type HeadlessComponentSource,
} from "./package-headless";

const execFileAsync = promisify(execFile);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fixtureSources(root: string): ReadonlyArray<HeadlessComponentSource> {
  const sources: ReadonlyArray<readonly [HeadlessComponentSource["role"], string, string]> = [
    ["server", "lib/server/main.mjs", "console.log('server');\n"],
    ["cli", "bin/octant", "#!/usr/bin/env bun\nconsole.log('cli');\n"],
    ["web-assets", "share/web/index.html", "<html></html>\n"],
    ["native-module", "lib/native/better_sqlite3.node", "native-bytes"],
    ["migrations", "share/migrations.json", '{"storeVersion":1}\n'],
    ["notices", "share/NOTICES.txt", "third-party notices\n"],
    ["service-template", "share/service/octant.service.template", "[Unit]\n"],
  ];
  return sources.map(([role, path, body]) => {
    const source = join(root, "sources", path.replaceAll("/", "_"));
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, body);
    return { role, path, source };
  });
}

describe("buildHeadlessArtifact", () => {
  it("builds a verified artifact tree and tarball for every supported target", async () => {
    expect(HEADLESS_ARTIFACT_TARGETS).toEqual([
      { platform: "darwin", arch: "arm64" },
      { platform: "linux", arch: "x64" },
      { platform: "linux", arch: "arm64" },
    ]);
    for (const target of HEADLESS_ARTIFACT_TARGETS) {
      const base = temporaryRoot("octant-headless-build-");
      const built = await buildHeadlessArtifact({
        version: "1.2.3",
        target,
        wireVersion: "1",
        storeVersion: 4,
        components: fixtureSources(base),
        outputDirectory: join(base, "out"),
      });
      expect(built.artifactRoot).toBe(
        join(base, "out", `octant-1.2.3-${target.platform}-${target.arch}`),
      );
      expect(existsSync(built.tarPath)).toBe(true);
      const inspection = await inspectHeadlessArtifact({
        artifactRoot: built.artifactRoot,
        runtime: {
          platform: target.platform,
          arch: target.arch,
          wireVersion: "1",
          storeVersion: 4,
        },
      });
      expect(inspection).toMatchObject({ ok: true });
      expect(built.manifest.artifactVersion).toBe("1.2.3");
      for (const component of built.manifest.components) {
        if (
          component.role === "server" ||
          component.role === "cli" ||
          component.role === "web-assets"
        ) {
          expect(component.version).toBe("1.2.3");
        }
      }
    }
  });

  it("produces byte-identical tarballs across independent rebuilds", async () => {
    const digests: string[] = [];
    for (let build = 0; build < 2; build += 1) {
      const base = temporaryRoot("octant-headless-repro-");
      const built = await buildHeadlessArtifact({
        version: "2.0.0",
        target: { platform: "linux", arch: "x64" },
        wireVersion: "1",
        storeVersion: 2,
        components: fixtureSources(base),
        outputDirectory: join(base, "out"),
      });
      digests.push(createHash("sha256").update(readFileSync(built.tarPath)).digest("hex"));
    }
    expect(digests[0]).toBe(digests[1]);
  });

  it("extracts through system tar into an artifact that passes inspection", async () => {
    const base = temporaryRoot("octant-headless-extract-");
    const built = await buildHeadlessArtifact({
      version: "3.0.0",
      target: { platform: "linux", arch: "x64" },
      wireVersion: "1",
      storeVersion: 1,
      components: fixtureSources(base),
      outputDirectory: join(base, "out"),
    });
    const extracted = join(base, "extracted");
    mkdirSync(extracted, { recursive: true });
    await execFileAsync("tar", ["-xzf", built.tarPath, "-C", extracted]);
    const extractedRoot = join(extracted, "octant-3.0.0-linux-x64");
    const inspection = await inspectHeadlessArtifact({
      artifactRoot: extractedRoot,
      runtime: { platform: "linux", arch: "x64", wireVersion: "1", storeVersion: 1 },
    });
    expect(inspection).toMatchObject({ ok: true });
    // Executable roles keep their execute bit through the tarball.
    expect(statSync(join(extractedRoot, "bin/octant")).mode & 0o111).not.toBe(0);
  });

  it("fails closed when a required component role is missing", async () => {
    const base = temporaryRoot("octant-headless-missing-");
    const components = fixtureSources(base).filter((component) => component.role !== "notices");
    await expect(
      buildHeadlessArtifact({
        version: "1.0.0",
        target: { platform: "linux", arch: "x64" },
        wireVersion: "1",
        storeVersion: 1,
        components,
        outputDirectory: join(base, "out"),
      }),
    ).rejects.toThrow(/notices/);
  });

  it("fails closed when a component source does not exist", async () => {
    const base = temporaryRoot("octant-headless-missing-source-");
    const components = fixtureSources(base).map((component) =>
      component.role === "server" ? { ...component, source: join(base, "absent") } : component,
    );
    await expect(
      buildHeadlessArtifact({
        version: "1.0.0",
        target: { platform: "linux", arch: "x64" },
        wireVersion: "1",
        storeVersion: 1,
        components,
        outputDirectory: join(base, "out"),
      }),
    ).rejects.toThrow();
  });
});

describe("renderHeadlessServiceTemplate", () => {
  it("renders a systemd user unit template bound to the current link", () => {
    const template = renderHeadlessServiceTemplate("linux");
    expect(template).toContain("[Unit]");
    expect(template).toContain("[Service]");
    expect(template).toContain("{{OCTANT_INSTALL_ROOT}}/current");
    expect(template).toContain("Restart=on-failure");
    // Only OCTANT_* environment variables appear in the template.
    for (const match of template.matchAll(/Environment=([A-Z0-9_]+)=/g)) {
      expect(match[1]).toMatch(/^OCTANT_/);
    }
  });

  it("renders a launchd agent template with the Octant label", () => {
    const template = renderHeadlessServiceTemplate("darwin");
    expect(template).toContain("<key>Label</key><string>app.octant.host</string>");
    expect(template).toContain("{{OCTANT_INSTALL_ROOT}}/current");
    expect(template).toContain("KeepAlive");
  });
});

describe("headlessMigrationsMetadata", () => {
  it("records the latest store version and per-migration checksums", () => {
    const metadata = JSON.parse(
      headlessMigrationsMetadata([
        { version: 1, name: "initial-event-store", sql: "CREATE TABLE t (id INTEGER);" },
        { version: 2, name: "add-index", sql: "CREATE INDEX i ON t (id);" },
      ]),
    ) as {
      readonly storeVersion: number;
      readonly migrations: ReadonlyArray<{
        readonly version: number;
        readonly name: string;
        readonly checksum: string;
      }>;
    };
    expect(metadata.storeVersion).toBe(2);
    expect(metadata.migrations).toHaveLength(2);
    expect(metadata.migrations[0]).toMatchObject({ version: 1, name: "initial-event-store" });
    expect(metadata.migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
