import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  encodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  type HeadlessArtifactManifest,
} from "@octant/host-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  HeadlessInstallError,
  installHeadlessArtifact,
  removeHeadlessUserData,
  stageHeadlessArtifact,
  uninstallHeadlessArtifact,
  upgradeHeadlessArtifact,
  type HeadlessUpgradePorts,
} from "./artifactInstall";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const runtime = {
  platform: process.platform === "darwin" ? "darwin" : "linux",
  arch: process.arch === "arm64" ? "arm64" : "x64",
  wireVersion: "1",
} as const;

function writeArtifact(options: {
  readonly version: string;
  readonly storeVersion: number;
  readonly marker?: string;
}): string {
  const root = temporaryRoot("octant-cli-artifact-");
  const contents: ReadonlyArray<readonly [string, string, string]> = [
    ["server", "lib/server/main.mjs", `server-${options.version}-${options.marker ?? ""}`],
    ["cli", "bin/octant", `cli-${options.version}`],
    ["web-assets", "share/web/index.html", "<html></html>"],
    ["native-module", "lib/native/better_sqlite3.node", "native-bytes"],
    ["migrations", "share/migrations.json", `{"storeVersion":${options.storeVersion}}`],
    ["notices", "share/NOTICES.txt", "notices"],
    ["service-template", "share/service/octant.service.template", "[Unit]"],
  ];
  const manifest: HeadlessArtifactManifest = {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: options.version,
    target: { platform: runtime.platform, arch: runtime.arch },
    wireVersion: "1",
    storeVersion: options.storeVersion,
    components: contents.map(([role, path, body]) => ({
      role: role as HeadlessArtifactManifest["components"][number]["role"],
      path,
      sha256: createHash("sha256").update(body).digest("hex"),
      byteLength: Buffer.byteLength(body),
      ...(role === "server" || role === "cli" || role === "web-assets"
        ? { version: options.version }
        : {}),
    })),
  };
  for (const [, path, body] of contents) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  writeFileSync(
    join(root, HEADLESS_ARTIFACT_MANIFEST_FILENAME),
    encodeHeadlessArtifactManifest(manifest),
  );
  return root;
}

interface UpgradeFixture {
  readonly ports: HeadlessUpgradePorts;
  readonly events: string[];
  ownerHealthy: boolean;
  stopAccepted: boolean;
  backupSucceeds: boolean;
  restoreSucceeds: boolean;
}

function upgradeFixture(overrides?: {
  readonly candidateHealthy?: boolean;
  readonly stopAccepted?: boolean;
  readonly backupSucceeds?: boolean;
  readonly restoreSucceeds?: boolean;
}): UpgradeFixture {
  const events: string[] = [];
  const fixture: UpgradeFixture = {
    events,
    ownerHealthy: true,
    stopAccepted: overrides?.stopAccepted ?? true,
    backupSucceeds: overrides?.backupSucceeds ?? true,
    restoreSucceeds: overrides?.restoreSucceeds ?? true,
    ports: {
      requestOwnerBackup: async (label) => {
        events.push(`backup:${label}`);
        if (!fixture.backupSucceeds) return undefined;
        return {
          path: `/data/octant.sqlite3.backup-${label}`,
          migrationVersion: 1,
          journalHead: 4,
          byteLength: 2_048,
        };
      },
      requestOwnerStop: async () => {
        events.push("stop-requested");
        return fixture.stopAccepted;
      },
      acquireMaintenanceOwner: async () => {
        events.push("maintenance-acquired");
        return {
          release: async () => {
            events.push("maintenance-released");
          },
        };
      },
      startService: async () => {
        events.push("service-started");
      },
      stopService: async () => {
        events.push("service-stopped");
      },
      observeHealth: async () => {
        events.push("health-observed");
        return (overrides?.candidateHealthy ?? true) ? "ready" : "unready";
      },
      restoreStore: async (backupPath) => {
        events.push(`store-restored:${backupPath}`);
        if (!fixture.restoreSucceeds) throw new Error("restore failed");
      },
    },
  };
  return fixture;
}

describe("stageHeadlessArtifact", () => {
  it("stages and verifies an artifact into an immutable version directory", async () => {
    const installRoot = join(temporaryRoot("octant-install-"), "install");
    const artifact = writeArtifact({ version: "1.0.0", storeVersion: 1 });
    const staged = await stageHeadlessArtifact({ artifactRoot: artifact, installRoot, runtime });
    expect(staged.manifest.artifactVersion).toBe("1.0.0");
    expect(staged.versionRoot).toBe(join(installRoot, "versions", "1.0.0"));
    expect(existsSync(join(staged.versionRoot, "lib/server/main.mjs"))).toBe(true);
    expect(existsSync(join(staged.versionRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME))).toBe(true);
    // No staging debris remains.
    expect(readdirSync(join(installRoot, "versions"))).toEqual(["1.0.0"]);
  });

  it("rejects a tampered artifact without installing anything", async () => {
    const installRoot = join(temporaryRoot("octant-install-"), "install");
    const artifact = writeArtifact({ version: "1.0.0", storeVersion: 1 });
    writeFileSync(join(artifact, "lib/server/main.mjs"), "tampered");
    await expect(
      stageHeadlessArtifact({ artifactRoot: artifact, installRoot, runtime }),
    ).rejects.toMatchObject({ code: "artifact-rejected" });
    expect(existsSync(join(installRoot, "versions", "1.0.0"))).toBe(false);
  });

  it("rejects an artifact staged for a different target", async () => {
    const installRoot = join(temporaryRoot("octant-install-"), "install");
    const artifact = writeArtifact({ version: "1.0.0", storeVersion: 1 });
    await expect(
      stageHeadlessArtifact({
        artifactRoot: artifact,
        installRoot,
        runtime: { ...runtime, platform: runtime.platform === "darwin" ? "linux" : "darwin" },
      }),
    ).rejects.toMatchObject({ code: "artifact-rejected" });
  });

  it("refuses to overwrite an already-installed version", async () => {
    const installRoot = join(temporaryRoot("octant-install-"), "install");
    const artifact = writeArtifact({ version: "1.0.0", storeVersion: 1 });
    await stageHeadlessArtifact({ artifactRoot: artifact, installRoot, runtime });
    await expect(
      stageHeadlessArtifact({ artifactRoot: artifact, installRoot, runtime }),
    ).rejects.toMatchObject({ code: "version-already-installed" });
  });
});

describe("installHeadlessArtifact", () => {
  it("atomically activates the staged version through the current link", async () => {
    const installRoot = join(temporaryRoot("octant-install-"), "install");
    const artifact = writeArtifact({ version: "1.0.0", storeVersion: 1 });
    const report = await installHeadlessArtifact({
      artifactRoot: artifact,
      installRoot,
      runtime,
    });
    expect(report).toMatchObject({ outcome: "installed", version: "1.0.0" });
    expect(readlinkSync(join(installRoot, "current"))).toBe(join(installRoot, "versions", "1.0.0"));
  });
});

describe("upgradeHeadlessArtifact", () => {
  async function installedRoot(version: string, storeVersion: number): Promise<string> {
    const installRoot = join(temporaryRoot("octant-install-"), "install");
    const artifact = writeArtifact({ version, storeVersion });
    await installHeadlessArtifact({ artifactRoot: artifact, installRoot, runtime });
    return installRoot;
  }

  it("stages and verifies, backs up, stops, switches atomically, restarts, and reports upgraded", async () => {
    const installRoot = await installedRoot("1.0.0", 1);
    const candidate = writeArtifact({ version: "1.1.0", storeVersion: 2 });
    const fixture = upgradeFixture();
    const report = await upgradeHeadlessArtifact({
      artifactRoot: candidate,
      installRoot,
      runtime,
      ports: fixture.ports,
    });
    expect(report).toMatchObject({
      outcome: "upgraded",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      storeMigration: true,
    });
    expect(readlinkSync(join(installRoot, "current"))).toBe(join(installRoot, "versions", "1.1.0"));
    // The verified backup and stop precede the switch; maintenance ownership
    // brackets the switch; restart and health follow.
    const order = fixture.events;
    expect(order.indexOf("backup:pre-upgrade")).toBeLessThan(order.indexOf("stop-requested"));
    expect(order.indexOf("stop-requested")).toBeLessThan(order.indexOf("maintenance-acquired"));
    expect(order.indexOf("maintenance-acquired")).toBeLessThan(
      order.indexOf("maintenance-released"),
    );
    expect(order.indexOf("maintenance-released")).toBeLessThan(order.indexOf("service-started"));
    expect(order.indexOf("service-started")).toBeLessThan(order.indexOf("health-observed"));
  });

  it("skips the store backup when the candidate does not migrate the store", async () => {
    const installRoot = await installedRoot("1.0.0", 1);
    const candidate = writeArtifact({ version: "1.0.1", storeVersion: 1 });
    const fixture = upgradeFixture();
    const report = await upgradeHeadlessArtifact({
      artifactRoot: candidate,
      installRoot,
      runtime,
      ports: fixture.ports,
    });
    expect(report).toMatchObject({ outcome: "upgraded", storeMigration: false });
    expect(fixture.events.some((event) => event.startsWith("backup:"))).toBe(false);
  });

  it("fails closed before any stop when the verified backup is unavailable", async () => {
    const installRoot = await installedRoot("1.0.0", 1);
    const candidate = writeArtifact({ version: "1.1.0", storeVersion: 2 });
    const fixture = upgradeFixture({ backupSucceeds: false });
    await expect(
      upgradeHeadlessArtifact({
        artifactRoot: candidate,
        installRoot,
        runtime,
        ports: fixture.ports,
      }),
    ).rejects.toMatchObject({ code: "backup-required" });
    expect(fixture.events).not.toContain("stop-requested");
    expect(readlinkSync(join(installRoot, "current"))).toBe(join(installRoot, "versions", "1.0.0"));
  });

  it("refuses an incompatible store downgrade before stopping anything", async () => {
    const installRoot = await installedRoot("2.0.0", 5);
    const candidate = writeArtifact({ version: "2.1.0", storeVersion: 3 });
    const fixture = upgradeFixture();
    await expect(
      upgradeHeadlessArtifact({
        artifactRoot: candidate,
        installRoot,
        runtime,
        ports: fixture.ports,
      }),
    ).rejects.toMatchObject({ code: "incompatible-downgrade" });
    expect(fixture.events).not.toContain("stop-requested");
  });

  it("refuses to proceed when the owner rejects the graceful stop", async () => {
    const installRoot = await installedRoot("1.0.0", 1);
    const candidate = writeArtifact({ version: "1.0.1", storeVersion: 1 });
    const fixture = upgradeFixture({ stopAccepted: false });
    await expect(
      upgradeHeadlessArtifact({
        artifactRoot: candidate,
        installRoot,
        runtime,
        ports: fixture.ports,
      }),
    ).rejects.toMatchObject({ code: "owner-stop-refused" });
    expect(readlinkSync(join(installRoot, "current"))).toBe(join(installRoot, "versions", "1.0.0"));
  });

  it("rolls back on failed health: restores the verified backup, switches back, restarts", async () => {
    const installRoot = await installedRoot("1.0.0", 1);
    const candidate = writeArtifact({ version: "1.1.0", storeVersion: 2 });
    const fixture = upgradeFixture({ candidateHealthy: false });
    const report = await upgradeHeadlessArtifact({
      artifactRoot: candidate,
      installRoot,
      runtime,
      ports: fixture.ports,
    });
    expect(report).toMatchObject({
      outcome: "rolled-back",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      storeRestored: true,
    });
    expect(readlinkSync(join(installRoot, "current"))).toBe(join(installRoot, "versions", "1.0.0"));
    const order = fixture.events;
    expect(order).toContain("service-stopped");
    expect(order.indexOf("service-stopped")).toBeLessThan(
      order.indexOf("store-restored:/data/octant.sqlite3.backup-pre-upgrade"),
    );
  });

  it("leaves the host stopped with recovery guidance when the rollback restore fails", async () => {
    const installRoot = await installedRoot("1.0.0", 1);
    const candidate = writeArtifact({ version: "1.1.0", storeVersion: 2 });
    const fixture = upgradeFixture({ candidateHealthy: false, restoreSucceeds: false });
    const report = await upgradeHeadlessArtifact({
      artifactRoot: candidate,
      installRoot,
      runtime,
      ports: fixture.ports,
    });
    expect(report).toMatchObject({ outcome: "recovery-required" });
    // The older binary is never restarted against a possibly-migrated store.
    const restartsAfterRestoreFailure = fixture.events.filter(
      (event, index) =>
        event === "service-started" &&
        index > fixture.events.indexOf("store-restored:/data/octant.sqlite3.backup-pre-upgrade"),
    );
    expect(restartsAfterRestoreFailure).toEqual([]);
  });

  it("rolls back without a store restore when no migration was involved", async () => {
    const installRoot = await installedRoot("1.0.0", 1);
    const candidate = writeArtifact({ version: "1.0.1", storeVersion: 1 });
    const fixture = upgradeFixture({ candidateHealthy: false });
    const report = await upgradeHeadlessArtifact({
      artifactRoot: candidate,
      installRoot,
      runtime,
      ports: fixture.ports,
    });
    expect(report).toMatchObject({ outcome: "rolled-back", storeRestored: false });
    expect(fixture.events.some((event) => event.startsWith("store-restored:"))).toBe(false);
    expect(readlinkSync(join(installRoot, "current"))).toBe(join(installRoot, "versions", "1.0.0"));
  });
});

describe("uninstallHeadlessArtifact", () => {
  it("removes installed versions but preserves user data by default", async () => {
    const base = temporaryRoot("octant-uninstall-");
    const installRoot = join(base, "install");
    const dataDirectory = join(base, "data");
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(join(dataDirectory, "octant.sqlite3"), "store-bytes");
    const artifact = writeArtifact({ version: "1.0.0", storeVersion: 1 });
    await installHeadlessArtifact({ artifactRoot: artifact, installRoot, runtime });

    const report = await uninstallHeadlessArtifact({ installRoot, dataDirectory });

    expect(report).toMatchObject({ outcome: "uninstalled", dataPreserved: true });
    expect(existsSync(installRoot)).toBe(false);
    expect(existsSync(join(dataDirectory, "octant.sqlite3"))).toBe(true);
  });

  it("refuses an install root that contains the data directory", async () => {
    const base = temporaryRoot("octant-uninstall-");
    const installRoot = join(base, "install");
    const dataDirectory = join(installRoot, "data");
    mkdirSync(dataDirectory, { recursive: true });
    await expect(uninstallHeadlessArtifact({ installRoot, dataDirectory })).rejects.toMatchObject({
      code: "data-confinement",
    });
    expect(existsSync(dataDirectory)).toBe(true);
  });
});

describe("removeHeadlessUserData", () => {
  it("requires the exact canonical confirmation before deleting anything", async () => {
    const base = temporaryRoot("octant-remove-data-");
    const dataDirectory = join(base, "data");
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(join(dataDirectory, "octant.sqlite3"), "store-bytes");
    await expect(
      removeHeadlessUserData({ dataDirectory, confirmation: "yes" }),
    ).rejects.toMatchObject({ code: "confirmation-mismatch" });
    expect(existsSync(join(dataDirectory, "octant.sqlite3"))).toBe(true);

    const report = await removeHeadlessUserData({ dataDirectory, confirmation: dataDirectory });
    expect(report).toMatchObject({ outcome: "removed" });
    expect(existsSync(dataDirectory)).toBe(false);
    expect(existsSync(base)).toBe(true);
  });

  it("cannot escape the canonical data directory through a symlink", async () => {
    const base = temporaryRoot("octant-remove-data-");
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "kept");
    const dataDirectory = join(base, "data");
    symlinkSync(outside, dataDirectory);
    await expect(
      removeHeadlessUserData({ dataDirectory, confirmation: dataDirectory }),
    ).rejects.toMatchObject({ code: "data-confinement" });
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(lstatSync(dataDirectory).isSymbolicLink()).toBe(true);
  });
});
