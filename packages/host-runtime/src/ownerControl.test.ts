import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireHostRuntimeOwner,
  prepareHostRuntimePaths,
  requestHostRuntimeControl,
  resolveHostRuntimePaths,
  type HostRuntimeLocalControlRequest,
  type HostRuntimeOwner,
} from "./index";

const roots: string[] = [];
const owners: HostRuntimeOwner[] = [];

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.release()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("owner lifecycle control protocol", () => {
  it("accepts bounded diagnostics only from the local principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-owner-control-"));
    roots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "darwin" ? "darwin" : "linux",
      home: join(root, "home"),
      temporaryDirectory: tmpdir(),
      uid: process.getuid?.() ?? 0,
    });
    await prepareHostRuntimePaths(paths);
    const onStopRequested = vi.fn();
    const owner = await acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      serverVersion: "1.0.0",
      wireVersion: "1",
      serviceMode: "service",
      processStart: "fixture-start",
      onStopRequested,
      onControlRequest: (request) =>
        request.type === "diagnostics"
          ? {
              diagnostics: {
                identity: {
                  hostId: "11111111-1111-4111-8111-111111111111",
                  instanceId: "22222222-2222-4222-8222-222222222222",
                  endpoint: paths.socketPath,
                  serviceMode: "service",
                },
                version: { server: "1.0.0", wire: "1" },
                store: { state: "current", integrity: "ok" },
                replay: { journalHead: 2, projections: 1 },
                clients: { connected: 0 },
                capabilities: ["local-loopback"],
                work: { active: 0, attentionRequired: false },
              },
            }
          : undefined,
    });
    expect(owner.kind).toBe("owner");
    if (owner.kind !== "owner") throw new Error("expected owner");
    owners.push(owner);

    await expect(
      requestHostRuntimeControl(paths, { type: "diagnostics", principal: "local" }),
    ).resolves.toMatchObject({ ok: true, diagnostics: { replay: { journalHead: 2 } } });

    const secret = (await readFile(paths.controlSecretPath, "utf8")).trim();
    const remoteRequest = {
      version: 1,
      secret,
      principal: "remote",
      type: "stop",
    } as unknown as HostRuntimeLocalControlRequest;
    await expect(requestHostRuntimeControl(paths, remoteRequest)).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(onStopRequested).not.toHaveBeenCalled();
  });

  it("routes online backup and restore requests through the owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-owner-control-"));
    roots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "darwin" ? "darwin" : "linux",
      home: join(root, "home"),
      temporaryDirectory: tmpdir(),
      uid: process.getuid?.() ?? 0,
    });
    await prepareHostRuntimePaths(paths);
    const backupLabels: Array<string | undefined> = [];
    const owner = await acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      serverVersion: "1.0.0",
      wireVersion: "1",
      serviceMode: "service",
      processStart: "fixture-start",
      onControlRequest: (request) => {
        if (request.type === "backup") {
          backupLabels.push(request.label);
          return {
            backup: {
              outcome: "created",
              path: join(paths.dataDirectory, "octant.sqlite3.backup-manual"),
              migrationVersion: 4,
              journalHead: 17,
              byteLength: 4_096,
            },
          };
        }
        if (request.type === "restore") {
          return {
            restore: {
              outcome: "refused-online",
              guidance: "Stop the Octant host, then run the offline restore command.",
            },
          };
        }
        return undefined;
      },
    });
    expect(owner.kind).toBe("owner");
    if (owner.kind !== "owner") throw new Error("expected owner");
    owners.push(owner);

    await expect(
      requestHostRuntimeControl(paths, { type: "backup", principal: "local", label: "manual" }),
    ).resolves.toMatchObject({
      ok: true,
      backup: { outcome: "created", migrationVersion: 4, journalHead: 17 },
    });
    expect(backupLabels).toEqual(["manual"]);

    await expect(
      requestHostRuntimeControl(paths, {
        type: "backup",
        principal: "local",
        label: "../escape",
      } as unknown as HostRuntimeLocalControlRequest),
    ).resolves.toEqual({ ok: false, error: "invalid-request" });

    await expect(
      requestHostRuntimeControl(paths, { type: "restore", principal: "local" }),
    ).resolves.toMatchObject({ ok: true, restore: { outcome: "refused-online" } });
  });

  it("fails closed when the owner has no backup handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-owner-control-"));
    roots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "darwin" ? "darwin" : "linux",
      home: join(root, "home"),
      temporaryDirectory: tmpdir(),
      uid: process.getuid?.() ?? 0,
    });
    await prepareHostRuntimePaths(paths);
    const owner = await acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "33333333-3333-4333-8333-333333333333",
      serverVersion: "1.0.0",
      wireVersion: "1",
      serviceMode: "service",
      processStart: "fixture-start",
      onControlRequest: (request) => {
        if (request.type === "backup") throw new Error("store unavailable");
        return undefined;
      },
    });
    expect(owner.kind).toBe("owner");
    if (owner.kind !== "owner") throw new Error("expected owner");
    owners.push(owner);

    await expect(
      requestHostRuntimeControl(paths, { type: "backup", principal: "local" }),
    ).resolves.toEqual({ ok: false, error: "handler-failed" });
    await expect(
      requestHostRuntimeControl(paths, { type: "restore", principal: "local" }),
    ).resolves.toEqual({ ok: false, error: "restore-unavailable" });
  });
});
