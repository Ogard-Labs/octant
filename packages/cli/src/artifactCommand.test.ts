import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  encodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  type HeadlessArtifactManifest,
  type HostRuntimeControlResponse,
} from "@octant/host-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalHeadlessUpgradePorts,
  resolveHeadlessArtifactCliCommand,
  runHeadlessArtifactCliCommand,
} from "./artifactCommand";
import type { HeadlessUpgradePorts } from "./artifactInstall";

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

const defaults = { installRoot: "/default/install", dataDirectory: "/default/data" } as const;

function writeArtifact(options: {
  readonly version: string;
  readonly storeVersion: number;
}): string {
  const root = temporaryRoot("octant-cmd-artifact-");
  const contents: ReadonlyArray<readonly [string, string, string]> = [
    ["server", "lib/server/main.mjs", `server-${options.version}`],
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

function fixturePorts(overrides?: {
  readonly candidateHealthy?: boolean;
  readonly restoreSucceeds?: boolean;
}): HeadlessUpgradePorts {
  return {
    requestOwnerBackup: async (label) => ({
      path: `/data/octant.sqlite3.backup-${label}`,
      migrationVersion: 1,
      journalHead: 1,
      byteLength: 1_024,
    }),
    requestOwnerStop: async () => true,
    acquireMaintenanceOwner: async () => ({ release: async () => undefined }),
    startService: async () => undefined,
    stopService: async () => undefined,
    observeHealth: async () => ((overrides?.candidateHealthy ?? true) ? "ready" : "unready"),
    restoreStore: async () => {
      if (overrides?.restoreSucceeds === false) throw new Error("restore failed");
    },
  };
}

function collector(): { readonly write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { write: (chunk) => void chunks.push(chunk), text: () => chunks.join("") };
}

describe("resolveHeadlessArtifactCliCommand", () => {
  it("parses install with defaults and explicit overrides", () => {
    expect(resolveHeadlessArtifactCliCommand(["install"], { artifact: "/a" }, defaults)).toEqual({
      action: "install",
      artifactRoot: "/a",
      installRoot: "/default/install",
    });
    expect(
      resolveHeadlessArtifactCliCommand(
        ["install"],
        { artifact: "/a", "install-root": "/opt/atlas" },
        defaults,
      ),
    ).toEqual({ action: "install", artifactRoot: "/a", installRoot: "/opt/atlas" });
  });

  it("rejects install without an artifact and with unknown flags", () => {
    expect(resolveHeadlessArtifactCliCommand(["install"], {}, defaults)).toBeUndefined();
    expect(
      resolveHeadlessArtifactCliCommand(["install"], { artifact: "/a", force: true }, defaults),
    ).toBeUndefined();
    expect(
      resolveHeadlessArtifactCliCommand(["install", "extra"], { artifact: "/a" }, defaults),
    ).toBeUndefined();
  });

  it("parses upgrade like install", () => {
    expect(resolveHeadlessArtifactCliCommand(["upgrade"], { artifact: "/a" }, defaults)).toEqual({
      action: "upgrade",
      artifactRoot: "/a",
      installRoot: "/default/install",
    });
  });

  it("parses uninstall and requires exact confirmation for data removal", () => {
    expect(resolveHeadlessArtifactCliCommand(["uninstall"], {}, defaults)).toEqual({
      action: "uninstall",
      installRoot: "/default/install",
      dataDirectory: "/default/data",
      removeData: false,
    });
    expect(
      resolveHeadlessArtifactCliCommand(
        ["uninstall"],
        { "remove-data": true, confirm: "/default/data" },
        defaults,
      ),
    ).toEqual({
      action: "uninstall",
      installRoot: "/default/install",
      dataDirectory: "/default/data",
      removeData: true,
      confirmation: "/default/data",
    });
    // remove-data without a confirmation string never parses.
    expect(
      resolveHeadlessArtifactCliCommand(["uninstall"], { "remove-data": true }, defaults),
    ).toBeUndefined();
  });
});

describe("runHeadlessArtifactCliCommand", () => {
  it("installs an artifact and reports the activated version", async () => {
    const installRoot = join(temporaryRoot("octant-cmd-install-"), "install");
    const artifact = writeArtifact({ version: "1.0.0", storeVersion: 1 });
    const stdout = collector();
    const stderr = collector();
    const code = await runHeadlessArtifactCliCommand({
      command: { action: "install", artifactRoot: artifact, installRoot },
      runtime,
      dataDirectory: join(installRoot, "..", "data"),
      ports: fixturePorts(),
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("1.0.0");
    expect(readlinkSync(join(installRoot, "current"))).toBe(join(installRoot, "versions", "1.0.0"));
  });

  it("maps a rejected artifact to a non-zero exit and stderr guidance", async () => {
    const installRoot = join(temporaryRoot("octant-cmd-install-"), "install");
    const artifact = writeArtifact({ version: "1.0.0", storeVersion: 1 });
    writeFileSync(join(artifact, "lib/server/main.mjs"), "tampered");
    const stdout = collector();
    const stderr = collector();
    const code = await runHeadlessArtifactCliCommand({
      command: { action: "install", artifactRoot: artifact, installRoot },
      runtime,
      dataDirectory: join(installRoot, "..", "data"),
      ports: fixturePorts(),
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("rejected");
  });

  it("reports a successful upgrade with exit code zero", async () => {
    const base = temporaryRoot("octant-cmd-upgrade-");
    const installRoot = join(base, "install");
    await runHeadlessArtifactCliCommand({
      command: {
        action: "install",
        artifactRoot: writeArtifact({ version: "1.0.0", storeVersion: 1 }),
        installRoot,
      },
      runtime,
      dataDirectory: join(base, "data"),
      ports: fixturePorts(),
      stdout: collector(),
      stderr: collector(),
    });
    const stdout = collector();
    const code = await runHeadlessArtifactCliCommand({
      command: {
        action: "upgrade",
        artifactRoot: writeArtifact({ version: "1.1.0", storeVersion: 2 }),
        installRoot,
      },
      runtime,
      dataDirectory: join(base, "data"),
      ports: fixturePorts(),
      stdout,
      stderr: collector(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("1.1.0");
  });

  it("reports a rollback as a failure with recovery detail on stderr", async () => {
    const base = temporaryRoot("octant-cmd-upgrade-");
    const installRoot = join(base, "install");
    await runHeadlessArtifactCliCommand({
      command: {
        action: "install",
        artifactRoot: writeArtifact({ version: "1.0.0", storeVersion: 1 }),
        installRoot,
      },
      runtime,
      dataDirectory: join(base, "data"),
      ports: fixturePorts(),
      stdout: collector(),
      stderr: collector(),
    });
    const stderr = collector();
    const code = await runHeadlessArtifactCliCommand({
      command: {
        action: "upgrade",
        artifactRoot: writeArtifact({ version: "1.1.0", storeVersion: 2 }),
        installRoot,
      },
      runtime,
      dataDirectory: join(base, "data"),
      ports: fixturePorts({ candidateHealthy: false }),
      stdout: collector(),
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("rolled back");
    expect(readlinkSync(join(installRoot, "current"))).toBe(join(installRoot, "versions", "1.0.0"));
  });

  it("surfaces recovery guidance when the rollback restore fails", async () => {
    const base = temporaryRoot("octant-cmd-upgrade-");
    const installRoot = join(base, "install");
    await runHeadlessArtifactCliCommand({
      command: {
        action: "install",
        artifactRoot: writeArtifact({ version: "1.0.0", storeVersion: 1 }),
        installRoot,
      },
      runtime,
      dataDirectory: join(base, "data"),
      ports: fixturePorts(),
      stdout: collector(),
      stderr: collector(),
    });
    const stderr = collector();
    const code = await runHeadlessArtifactCliCommand({
      command: {
        action: "upgrade",
        artifactRoot: writeArtifact({ version: "1.1.0", storeVersion: 2 }),
        installRoot,
      },
      runtime,
      dataDirectory: join(base, "data"),
      ports: fixturePorts({ candidateHealthy: false, restoreSucceeds: false }),
      stdout: collector(),
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("Restore the store manually");
  });

  it("uninstalls while preserving data, and removes data only with exact confirmation", async () => {
    const base = temporaryRoot("octant-cmd-uninstall-");
    const installRoot = join(base, "install");
    const dataDirectory = join(base, "data");
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(join(dataDirectory, "octant.sqlite3"), "store-bytes");
    await runHeadlessArtifactCliCommand({
      command: {
        action: "install",
        artifactRoot: writeArtifact({ version: "1.0.0", storeVersion: 1 }),
        installRoot,
      },
      runtime,
      dataDirectory,
      ports: fixturePorts(),
      stdout: collector(),
      stderr: collector(),
    });

    const preserved = await runHeadlessArtifactCliCommand({
      command: { action: "uninstall", installRoot, dataDirectory, removeData: false },
      runtime,
      dataDirectory,
      ports: fixturePorts(),
      stdout: collector(),
      stderr: collector(),
    });
    expect(preserved).toBe(0);
    expect(existsSync(installRoot)).toBe(false);
    expect(existsSync(join(dataDirectory, "octant.sqlite3"))).toBe(true);

    const wrongConfirmation = await runHeadlessArtifactCliCommand({
      command: {
        action: "uninstall",
        installRoot,
        dataDirectory,
        removeData: true,
        confirmation: "/wrong",
      },
      runtime,
      dataDirectory,
      ports: fixturePorts(),
      stdout: collector(),
      stderr: collector(),
    });
    expect(wrongConfirmation).toBe(1);
    expect(existsSync(join(dataDirectory, "octant.sqlite3"))).toBe(true);

    const removed = await runHeadlessArtifactCliCommand({
      command: {
        action: "uninstall",
        installRoot,
        dataDirectory,
        removeData: true,
        confirmation: dataDirectory,
      },
      runtime,
      dataDirectory,
      ports: fixturePorts(),
      stdout: collector(),
      stderr: collector(),
    });
    expect(removed).toBe(0);
    expect(existsSync(dataDirectory)).toBe(false);
  });
});

describe("createLocalHeadlessUpgradePorts", () => {
  function localPorts(options: {
    readonly responses: Partial<
      Record<"backup" | "stop" | "status", HostRuntimeControlResponse | undefined>
    >;
    readonly maintenance?: "owner" | "attached";
  }): { readonly ports: HeadlessUpgradePorts; readonly serviceEvents: string[] } {
    const serviceEvents: string[] = [];
    const ports = createLocalHeadlessUpgradePorts({
      control: {
        request: async (request) => options.responses[request.type as "backup" | "stop" | "status"],
      },
      serviceManager: {
        start: async () => void serviceEvents.push("start"),
        stop: async () => void serviceEvents.push("stop"),
      },
      acquireMaintenance: async () =>
        (options.maintenance ?? "owner") === "owner"
          ? { kind: "owner", release: async () => void serviceEvents.push("release") }
          : { kind: "attached" },
      sleep: async () => undefined,
      healthAttempts: 2,
    });
    return { ports, serviceEvents };
  }

  it("maps owner backup outcomes onto verified receipts and fails closed otherwise", async () => {
    const created = localPorts({
      responses: {
        backup: {
          ok: true,
          backup: {
            outcome: "created",
            path: "/data/b",
            migrationVersion: 3,
            journalHead: 9,
            byteLength: 512,
          },
        },
      },
    });
    await expect(created.ports.requestOwnerBackup("pre-upgrade")).resolves.toEqual({
      path: "/data/b",
      migrationVersion: 3,
      journalHead: 9,
      byteLength: 512,
    });
    const failed = localPorts({
      responses: { backup: { ok: true, backup: { outcome: "failed", code: "backup-failed" } } },
    });
    await expect(failed.ports.requestOwnerBackup("pre-upgrade")).resolves.toBeUndefined();
    const absent = localPorts({ responses: {} });
    await expect(absent.ports.requestOwnerBackup("pre-upgrade")).resolves.toBeUndefined();
  });

  it("treats a missing owner as already stopped and a refusal as refused", async () => {
    await expect(localPorts({ responses: {} }).ports.requestOwnerStop()).resolves.toBe(true);
    await expect(
      localPorts({ responses: { stop: { ok: true } } }).ports.requestOwnerStop(),
    ).resolves.toBe(true);
    await expect(
      localPorts({ responses: { stop: { ok: false } } }).ports.requestOwnerStop(),
    ).resolves.toBe(false);
  });

  it("observes health from owner status and reports unready when no owner appears", async () => {
    await expect(
      localPorts({ responses: { status: { ok: true, owner: {} } } }).ports.observeHealth(),
    ).resolves.toBe("ready");
    await expect(localPorts({ responses: {} }).ports.observeHealth()).resolves.toBe("unready");
  });

  it("fails closed on restore and refuses maintenance when an owner is still attached", async () => {
    const fixture = localPorts({ responses: {}, maintenance: "attached" });
    await expect(fixture.ports.restoreStore("/data/b")).rejects.toThrow();
    await expect(fixture.ports.acquireMaintenanceOwner()).rejects.toMatchObject({
      code: "owner-stop-refused",
    });
  });
});
