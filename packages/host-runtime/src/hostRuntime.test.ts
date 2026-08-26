import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const openMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  openMock.mockImplementation(actual.open);
  return { ...actual, open: openMock };
});

import {
  clearHostRuntimeProjections,
  HostRuntimePathError,
  acquireHostRuntimeOwner,
  decodeOwnerReceipt,
  decodeHostInfoReceipt,
  encodeOwnerReceipt,
  encodeHostInfoReceipt,
  formatHostRuntimeError,
  prepareHostRuntimePaths,
  readHostInfoReceipt,
  readHostRuntimeProcessStart,
  redactHostRuntimeText,
  resolveHostRuntimePaths,
  writeHostInfoReceipt,
  type HostRuntimeOwner,
} from "./index";

const owners: HostRuntimeOwner[] = [];
const temporaryRoots: string[] = [];
const filesystemTestPlatform: NodeJS.Platform = process.platform === "darwin" ? "darwin" : "linux";

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.release()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("host runtime paths", () => {
  it("preserves the canonical macOS desktop data directory", () => {
    const paths = resolveHostRuntimePaths({
      env: {},
      platform: "darwin",
      home: "/Users/example",
      temporaryDirectory: "/private/var/folders/runtime",
      uid: 501,
    });

    expect(paths.dataDirectory).toBe("/Users/example/Library/Application Support/Octant");
    expect(paths.configDirectory).toBe("/Users/example/Library/Application Support/Octant/config");
    expect(paths.stateDirectory).toBe("/Users/example/Library/Application Support/Octant");
    expect(paths.logsDirectory).toBe("/Users/example/Library/Logs/Octant");
    expect(paths.ownerReceiptPath).toBe(
      "/Users/example/Library/Application Support/Octant/run/owner.json",
    );
    expect(paths.runtimeDirectory).toBe("/private/tmp/octant-501");
    expect(paths.socketPath.startsWith("/private/tmp/octant-501/")).toBe(true);
    expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(103);
  });

  it("uses safe Linux XDG defaults without requiring OCTANT_DATA_DIR", () => {
    const paths = resolveHostRuntimePaths({
      env: {},
      platform: "linux",
      home: "/home/example",
      temporaryDirectory: "/tmp",
      uid: 1000,
    });

    expect(paths.dataDirectory).toBe("/home/example/.local/share/octant");
    expect(paths.configDirectory).toBe("/home/example/.config/octant");
    expect(paths.stateDirectory).toBe("/home/example/.local/state/octant");
    expect(paths.logsDirectory).toBe("/home/example/.local/state/octant/logs");
    expect(paths.runtimeDirectory).toBe("/tmp/octant-1000");
    expect(paths.ownerReceiptPath).toBe("/home/example/.local/share/octant/run/owner.json");
  });

  it("keeps owner identity and receipt placement stable for the same implicit or explicit data directory", () => {
    const implicit = resolveHostRuntimePaths({
      env: { XDG_DATA_HOME: "/home/example/.local/share" },
      platform: "linux",
      home: "/home/example",
      temporaryDirectory: "/tmp",
      uid: 1000,
    });
    const explicit = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: implicit.dataDirectory },
      platform: "linux",
      home: "/home/example",
      temporaryDirectory: "/tmp",
      uid: 1000,
    });

    expect(explicit.socketPath).toBe(implicit.socketPath);
    expect(explicit.ownerReceiptPath).toBe(implicit.ownerReceiptPath);
  });

  it.runIf(process.platform === "darwin")(
    "creates and canonicalizes a missing macOS data directory before deriving owner identity",
    async () => {
      const runtimeBase = await realpath(tmpdir());
      const root = await mkdtemp(join(runtimeBase, "Octant-Path-Case-"));
      temporaryRoots.push(root);
      const canonicalData = join(root, "CanonicalData");
      const aliasData = join(root, "canonicaldata");
      const canonical = resolveHostRuntimePaths({
        env: { OCTANT_DATA_DIR: canonicalData },
        platform: "darwin",
        home: "/Users/example",
        temporaryDirectory: runtimeBase,
        uid: process.getuid?.() ?? 501,
      });
      const aliased = resolveHostRuntimePaths({
        env: { OCTANT_DATA_DIR: aliasData },
        platform: "darwin",
        home: "/Users/example",
        temporaryDirectory: runtimeBase,
        uid: process.getuid?.() ?? 501,
      });

      expect(aliased.dataDirectory).toBe(canonical.dataDirectory);
      expect(aliased.socketPath).toBe(canonical.socketPath);
    },
  );

  it("uses a stable per-user Linux runtime root instead of caller XDG state", () => {
    const paths = resolveHostRuntimePaths({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      platform: "linux",
      home: "/home/example",
      temporaryDirectory: "/tmp",
      uid: 1000,
    });
    expect(paths.runtimeBaseDirectory).toBe("/tmp");
    expect(paths.runtimeDirectory).toBe("/tmp/octant-1000");
    expect(paths.runtimeBaseIsExternal).toBe(false);
  });

  it("derives one per-user runtime root across different caller environments", () => {
    const shared = {
      platform: "linux" as const,
      home: "/home/example",
      uid: 1000,
    };
    const desktop = resolveHostRuntimePaths({
      ...shared,
      env: { OCTANT_DATA_DIR: "/home/example/octant-data" },
      temporaryDirectory: "/tmp/desktop-environment",
    });
    const foregroundServer = resolveHostRuntimePaths({
      ...shared,
      env: {
        OCTANT_DATA_DIR: "/home/example/octant-data",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      temporaryDirectory: "/tmp/server-environment",
    });

    expect(foregroundServer.runtimeDirectory).toBe(desktop.runtimeDirectory);
    expect(foregroundServer.socketPath).toBe(desktop.socketPath);
    expect(foregroundServer.controlSecretPath).toBe(desktop.controlSecretPath);
  });

  it.each([
    ["OCTANT_DATA_DIR", "relative/data"],
    ["XDG_DATA_HOME", "relative/data"],
    ["XDG_CONFIG_HOME", " /home/example/.config"],
    ["XDG_STATE_HOME", ""],
  ])("rejects an unsafe %s path", (name, value) => {
    expect(() =>
      resolveHostRuntimePaths({
        env: { [name]: value },
        platform: "linux",
        home: "/home/example",
        temporaryDirectory: "/tmp",
        uid: 1000,
      }),
    ).toThrow(HostRuntimePathError);
  });

  it.runIf(process.platform === "darwin")(
    "accepts existing Octant state in the canonical macOS directory",
    async () => {
      const runtimeBase = await realpath(tmpdir());
      const root = await mkdtemp(join(runtimeBase, ".octant-host-paths-"));
      temporaryRoots.push(root);
      const home = join(root, "home");
      const canonical = join(home, "Library", "Application Support", "Octant");
      await mkdir(canonical, { recursive: true, mode: 0o700 });
      await writeFile(join(canonical, "octant.sqlite3"), "octant");
      const paths = resolveHostRuntimePaths({
        env: {},
        platform: "darwin",
        home,
        temporaryDirectory: runtimeBase,
        uid: process.getuid?.() ?? 501,
      });

      await expect(prepareHostRuntimePaths(paths)).resolves.toBeUndefined();
    },
  );

  it("creates user-private directories and rejects symlink components", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-host-safe-"));
    temporaryRoots.push(root);
    const realData = join(root, "real-data");
    const linkedData = join(root, "linked-data");
    await mkdir(realData, { mode: 0o700 });
    await symlink(realData, linkedData);
    const unsafe = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: linkedData },
      platform: "linux",
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await expect(prepareHostRuntimePaths(unsafe)).rejects.toMatchObject({
      code: "unsafe-symlink",
    });

    const safe = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "safe-data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(safe);
    expect((await lstat(safe.dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(safe.runtimeDirectory)).mode & 0o777).toBe(0o700);
  });

  it("rejects an existing data directory that is accessible to group or other users", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-host-mode-"));
    temporaryRoots.push(root);
    const dataDirectory = join(root, "data");
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: dataDirectory },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    await chmod(dataDirectory, 0o755);
    await expect(prepareHostRuntimePaths(paths)).rejects.toMatchObject({
      name: "HostRuntimePathError",
      code: "unsafe-mode",
      path: paths.dataDirectory,
      message: "Octant runtime paths must not be accessible to group or other users.",
    });
  });
});

describe("owner receipts and redaction", () => {
  const receipt = {
    schemaVersion: 1 as const,
    hostId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
    endpoint: "/tmp/octant-1000/owner.sock",
    pid: 1234,
    processStart: "987654",
    serverVersion: "1.2.3",
    wireVersion: "1",
    serviceMode: "foreground" as const,
    nonceDigest: "a".repeat(64),
    createdAt: "2026-08-09T10:00:00.000Z",
  };

  it("round-trips the bounded versioned owner receipt", () => {
    expect(decodeOwnerReceipt(encodeOwnerReceipt(receipt))).toEqual(receipt);
  });

  it("rejects unknown versions and unbounded or malformed fields", () => {
    expect(() => decodeOwnerReceipt(JSON.stringify({ ...receipt, schemaVersion: 2 }))).toThrow();
    expect(() => decodeOwnerReceipt(JSON.stringify({ ...receipt, pid: 0 }))).toThrow();
    expect(() =>
      decodeOwnerReceipt(JSON.stringify({ ...receipt, endpoint: "x".repeat(500) })),
    ).toThrow();
  });

  it("redacts authority secrets and sensitive structured values", () => {
    const text = redactHostRuntimeText(
      "authorization=Bearer abc bridgeSecret=hunter2 controlNonce=private api_key=sk-secret",
    );
    expect(text).not.toContain("abc");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("private");
    expect(text).not.toContain("sk-secret");
    expect(text.match(/\[REDACTED\]/g)?.length).toBe(4);
  });

  it("redacts quoted JSON secret values before startup errors reach service logs", () => {
    const text = formatHostRuntimeError(
      new Error(
        'startup failed: {"token":"sk-live-secret","password":"hunter2","nested":{"api_key":"nested-secret"}}',
      ),
    );

    expect(text).not.toContain("sk-live-secret");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("nested-secret");
  });

  it("formats typed path failures without exposing the private path", () => {
    const privatePath = "/Users/private/Library/Application Support/Octant";
    const output = formatHostRuntimeError(
      new HostRuntimePathError(
        "invalid-path",
        `Octant could not canonicalize its data directory: EACCES: ${privatePath}`,
        privatePath,
      ),
    );

    expect(output).toBe("Octant host path validation failed (invalid-path).");
    expect(output).not.toContain(privatePath);
  });

  it("reads a stable process-start fact for the current supported host", async () => {
    const first = await readHostRuntimeProcessStart(process.pid);
    expect(first).toMatch(/^(darwin|linux):/);
    expect(await readHostRuntimeProcessStart(process.pid)).toBe(first);
  });

  it("keeps process-start identity stable across timezone changes", async () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utc = await readHostRuntimeProcessStart(process.pid);
      process.env.TZ = "America/Los_Angeles";
      expect(await readHostRuntimeProcessStart(process.pid)).toBe(utc);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});

describe("host-info projection", () => {
  const receipt = {
    schemaVersion: 1 as const,
    hostId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
    url: "http://127.0.0.1:13773/",
    controlEndpoint: "/tmp/octant-1000/owner.sock",
    serviceMode: "foreground" as const,
    serverVersion: "1.2.3",
    wireVersion: "1",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };

  it("round-trips a strict versioned host-info receipt", () => {
    expect(decodeHostInfoReceipt(encodeHostInfoReceipt(receipt))).toEqual(receipt);
    expect(() => decodeHostInfoReceipt(JSON.stringify({ ...receipt, schemaVersion: 2 }))).toThrow();
  });

  it("writes host-info atomically with owner-only permissions", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-host-info-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    await writeHostInfoReceipt(paths, { ...receipt, controlEndpoint: paths.socketPath });
    expect(await readHostInfoReceipt(paths)).toEqual({
      ...receipt,
      controlEndpoint: paths.socketPath,
    });
    expect((await lstat(paths.hostInfoPath)).mode & 0o777).toBe(0o600);
  });

  it("clears only the projections published by the releasing owner", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-projection-cleanup-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const bridgeSecret = "owner-bridge-secret";
    const instanceId = "22222222-2222-4222-8222-222222222222";
    await writeFile(paths.bridgeSecretPath, `${bridgeSecret}\n`, { mode: 0o600 });
    await writeHostInfoReceipt(paths, {
      schemaVersion: 1,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId,
      url: "http://127.0.0.1:13773/",
      controlEndpoint: paths.socketPath,
      serviceMode: "foreground",
      serverVersion: "1.2.3",
      wireVersion: "1",
      updatedAt: "2026-08-09T10:00:00.000Z",
    });

    await clearHostRuntimeProjections(paths, {
      instanceId: "33333333-3333-4333-8333-333333333333",
      bridgeSecret: "replacement-secret",
    });
    expect(await readFile(paths.bridgeSecretPath, "utf8")).toBe(`${bridgeSecret}\n`);
    expect((await lstat(paths.hostInfoPath)).isFile()).toBe(true);

    await clearHostRuntimeProjections(paths, { instanceId, bridgeSecret });
    await expect(lstat(paths.bridgeSecretPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.hostInfoPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("single owner control socket", () => {
  it("uses the bound socket as the fresh-start arbiter before publishing authority", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-owner-race-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);

    const first = await acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "123456",
      afterSocketBound: async () => {
        expect((await lstat(paths.socketPath)).isSocket()).toBe(true);
        await expect(lstat(paths.controlSecretPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    });
    expect(first.kind).toBe("owner");
    if (first.kind === "owner") owners.push(first);
  });

  it("makes a simultaneous fresh-start competitor attach to the socket winner", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-owner-simultaneous-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);

    let announceBound!: () => void;
    let releaseWinner!: () => void;
    const bound = new Promise<void>((resolve) => {
      announceBound = resolve;
    });
    const holdWinner = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const firstPromise = acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "123456",
      afterSocketBound: async () => {
        announceBound();
        await holdWinner;
      },
    });
    await bound;
    const secondPromise = acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "33333333-3333-4333-8333-333333333333",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "123457",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseWinner();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.kind).toBe("owner");
    if (first.kind === "owner") owners.push(first);
    expect(second).toMatchObject({
      kind: "attached",
      owner: { instanceId: "22222222-2222-4222-8222-222222222222" },
    });
  });

  it("never quarantines an initializing owner that rejects a stale receipt secret", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-owner-stale-authority-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const staleSecret = "stale-owner-secret";
    await writeFile(paths.controlSecretPath, staleSecret, { mode: 0o600 });
    await writeFile(
      paths.ownerReceiptPath,
      encodeOwnerReceipt({
        schemaVersion: 1,
        hostId: "11111111-1111-4111-8111-111111111111",
        instanceId: "22222222-2222-4222-8222-222222222222",
        endpoint: paths.socketPath,
        pid: 999_999,
        processStart: "dead-owner",
        serverVersion: "1.2.2",
        wireVersion: "1",
        serviceMode: "foreground",
        nonceDigest: createHash("sha256").update(staleSecret).digest("hex"),
        createdAt: "2026-08-09T10:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    let announceBound!: () => void;
    let continueOwner!: () => void;
    const bound = new Promise<void>((resolve) => {
      announceBound = resolve;
    });
    const holdOwner = new Promise<void>((resolve) => {
      continueOwner = resolve;
    });
    const ownerPromise = acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "33333333-3333-4333-8333-333333333333",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "new-owner",
      afterSocketBound: async () => {
        announceBound();
        await holdOwner;
      },
    });
    await bound;

    await expect(
      acquireHostRuntimeOwner({
        paths,
        hostId: "11111111-1111-4111-8111-111111111111",
        instanceId: "44444444-4444-4444-8444-444444444444",
        serverVersion: "1.2.3",
        wireVersion: "1",
        serviceMode: "foreground",
        processStart: "competitor",
        processAlive: () => false,
      }),
    ).rejects.toMatchObject({ code: "owner-unhealthy" });

    continueOwner();
    const owner = await ownerPromise;
    expect(owner.kind).toBe("owner");
    if (owner.kind === "owner") owners.push(owner);
  });

  it("binds before persistence and makes a competitor attach", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-owner-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    let persistenceOpened = false;
    let stopRequested = false;
    const first = await acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "123456",
      beforePersistence: () => {
        expect(persistenceOpened).toBe(false);
        persistenceOpened = true;
      },
      onStopRequested: () => {
        stopRequested = true;
      },
    });
    expect(first.kind).toBe("owner");
    if (first.kind !== "owner") throw new Error("expected owner");
    owners.push(first);
    expect(persistenceOpened).toBe(true);

    const second = await acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "33333333-3333-4333-8333-333333333333",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "123457",
    });
    expect(second).toMatchObject({
      kind: "attached",
      owner: {
        instanceId: "22222222-2222-4222-8222-222222222222",
        serviceMode: "foreground",
      },
    });
    if (second.kind !== "attached") throw new Error("expected attachment");
    expect(await second.requestStop()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopRequested).toBe(true);
  });

  it.each([
    ["host identity", "99999999-9999-4999-8999-999999999999", "1"],
    ["wire version", "11111111-1111-4111-8111-111111111111", "2"],
  ])("rejects attachment to an incompatible %s", async (_fact, hostId, wireVersion) => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-owner-incompatible-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const first = await acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "123456",
    });
    if (first.kind !== "owner") throw new Error("expected owner");
    owners.push(first);

    await expect(
      acquireHostRuntimeOwner({
        paths,
        hostId,
        instanceId: "33333333-3333-4333-8333-333333333333",
        serverVersion: "1.2.3",
        wireVersion,
        serviceMode: "foreground",
        processStart: "123457",
      }),
    ).rejects.toMatchObject({ code: "owner-incompatible" });
  });

  it("preserves a changed control secret when the old owner releases", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-owner-release-race-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const first = await acquireHostRuntimeOwner({
      paths,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "123456",
    });
    if (first.kind !== "owner") throw new Error("expected owner");
    owners.push(first);

    // A replacement can reuse the same pathname and inode. Cleanup must only
    // remove the exact authority artifact that this owner published.
    await writeFile(paths.controlSecretPath, "replacement-secret\n", { mode: 0o600 });
    await chmod(paths.controlSecretPath, 0o600);

    await first.release();
    expect((await lstat(paths.controlSecretPath)).isFile()).toBe(true);
    expect(await readFile(paths.controlSecretPath, "utf8")).toBe("replacement-secret\n");
    await unlink(paths.controlSecretPath);
  });

  it("removes newly created authority artifacts when writing the secret fails", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-owner-secret-write-failure-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: process.platform === "win32" ? "linux" : process.platform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);

    const defaultOpen = openMock.getMockImplementation();
    if (defaultOpen === undefined) throw new Error("expected the open mock implementation");
    openMock.mockImplementation(async (...args) => {
      const handle = await defaultOpen(...args);
      if (args[0] !== paths.controlSecretPath) return handle;
      return {
        close: handle.close.bind(handle),
        stat: handle.stat.bind(handle),
        writeFile: async (...writeArgs: unknown[]) => {
          await handle.writeFile(...(writeArgs as Parameters<typeof handle.writeFile>));
          throw new Error("simulated secret write failure");
        },
      } as unknown as typeof handle;
    });
    try {
      await expect(
        acquireHostRuntimeOwner({
          paths,
          hostId: "11111111-1111-4111-8111-111111111111",
          instanceId: "22222222-2222-4222-8222-222222222222",
          serverVersion: "1.2.3",
          wireVersion: "1",
          serviceMode: "foreground",
          processStart: "123456",
        }),
      ).rejects.toMatchObject({ code: "unsafe-owner-artifact" });
    } finally {
      openMock.mockImplementation(defaultOpen);
    }

    await expect(lstat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.controlSecretPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never replaces an ambiguous non-socket owner path", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-owner-node-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    await writeFile(paths.socketPath, "not a socket", { mode: 0o600 });
    await chmod(paths.socketPath, 0o600);

    await expect(
      acquireHostRuntimeOwner({
        paths,
        hostId: "11111111-1111-4111-8111-111111111111",
        instanceId: "22222222-2222-4222-8222-222222222222",
        serverVersion: "1.2.3",
        wireVersion: "1",
        serviceMode: "foreground",
        processStart: "123456",
      }),
    ).rejects.toMatchObject({ code: "ambiguous-owner-node" });
    expect(await readFile(paths.socketPath, "utf8")).toBe("not a socket");
  });

  it("quarantines a proven stale socket before binding a replacement owner", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-stale-owner-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const stalePid = await leaveStaleSocket(paths.socketPath);
    const secret = "stale-control-secret";
    const staleReceipt = {
      schemaVersion: 1 as const,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      endpoint: paths.socketPath,
      pid: stalePid,
      processStart: "stale-start",
      serverVersion: "1.2.2",
      wireVersion: "1",
      serviceMode: "foreground" as const,
      nonceDigest: createHash("sha256").update(secret).digest("hex"),
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    await writeFile(paths.controlSecretPath, secret, { mode: 0o600 });
    await writeFile(paths.ownerReceiptPath, encodeOwnerReceipt(staleReceipt), { mode: 0o600 });

    const replacement = await acquireHostRuntimeOwner({
      paths,
      hostId: staleReceipt.hostId,
      instanceId: "33333333-3333-4333-8333-333333333333",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "replacement-start",
      processAlive: () => false,
    });
    expect(replacement.kind).toBe("owner");
    if (replacement.kind === "owner") owners.push(replacement);
  });

  it("quarantines stale authority artifacts before exposing the socket path", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-stale-owner-order-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const stalePid = await leaveStaleSocket(paths.socketPath);
    const secret = "stale-control-secret";
    const staleReceipt = {
      schemaVersion: 1 as const,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      endpoint: paths.socketPath,
      pid: stalePid,
      processStart: "stale-start",
      serverVersion: "1.2.2",
      wireVersion: "1",
      serviceMode: "foreground" as const,
      nonceDigest: createHash("sha256").update(secret).digest("hex"),
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    await writeFile(paths.controlSecretPath, secret, { mode: 0o600 });
    await writeFile(paths.ownerReceiptPath, encodeOwnerReceipt(staleReceipt), { mode: 0o600 });
    let observedSafeOrder = false;

    const replacement = await acquireHostRuntimeOwner({
      paths,
      hostId: staleReceipt.hostId,
      instanceId: "33333333-3333-4333-8333-333333333333",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "replacement-start",
      processAlive: () => false,
      afterStaleArtifactsQuarantined: async () => {
        expect((await lstat(paths.socketPath)).isSocket()).toBe(true);
        await expect(lstat(paths.ownerReceiptPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(paths.controlSecretPath)).rejects.toMatchObject({ code: "ENOENT" });
        observedSafeOrder = true;
      },
    });
    expect(observedSafeOrder).toBe(true);
    if (replacement.kind === "owner") owners.push(replacement);
  });

  it("refuses to replace a live owner whose socket pathname is missing", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-socketless-live-owner-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const secret = "live-control-secret";
    const receipt = {
      schemaVersion: 1 as const,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      endpoint: paths.socketPath,
      pid: process.pid,
      processStart: "live-start",
      serverVersion: "1.2.2",
      wireVersion: "1",
      serviceMode: "foreground" as const,
      nonceDigest: createHash("sha256").update(secret).digest("hex"),
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    await writeFile(paths.controlSecretPath, secret, { mode: 0o600 });
    await writeFile(paths.ownerReceiptPath, encodeOwnerReceipt(receipt), { mode: 0o600 });

    await expect(
      acquireHostRuntimeOwner({
        paths,
        hostId: receipt.hostId,
        instanceId: "33333333-3333-4333-8333-333333333333",
        serverVersion: "1.2.3",
        wireVersion: "1",
        serviceMode: "foreground",
        processStart: "replacement-start",
        processAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "owner-unhealthy" });
    await expect(lstat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(decodeOwnerReceipt(await readFile(paths.ownerReceiptPath, "utf8"))).toEqual(receipt);
  });

  it("recovers when runtime cleanup leaves only a durable dead-owner receipt", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-receipt-only-owner-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const staleReceipt = {
      schemaVersion: 1 as const,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      endpoint: paths.socketPath,
      pid: 999_999,
      processStart: "dead-before-runtime-cleanup",
      serverVersion: "1.2.2",
      wireVersion: "1",
      serviceMode: "foreground" as const,
      nonceDigest: createHash("sha256").update("removed-with-runtime-directory").digest("hex"),
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    await writeFile(paths.ownerReceiptPath, encodeOwnerReceipt(staleReceipt), {
      mode: 0o600,
    });
    const processAlive = vi.fn(() => false);

    const replacement = await acquireHostRuntimeOwner({
      paths,
      hostId: staleReceipt.hostId,
      instanceId: "33333333-3333-4333-8333-333333333333",
      serverVersion: "1.2.3",
      wireVersion: "1",
      serviceMode: "foreground",
      processStart: "replacement-start",
      processAlive,
    });

    expect(replacement.kind).toBe("owner");
    if (replacement.kind === "owner") owners.push(replacement);
    expect(processAlive).toHaveBeenCalledWith(staleReceipt.pid, staleReceipt.processStart);
    expect(decodeOwnerReceipt(await readFile(paths.ownerReceiptPath, "utf8"))).toMatchObject({
      instanceId: "33333333-3333-4333-8333-333333333333",
    });
    expect((await lstat(paths.controlSecretPath)).isFile()).toBe(true);
  });

  it("preserves a receipt-only owner when its process identity is still live", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-receipt-only-live-owner-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const receipt = {
      schemaVersion: 1 as const,
      hostId: "11111111-1111-4111-8111-111111111111",
      instanceId: "22222222-2222-4222-8222-222222222222",
      endpoint: paths.socketPath,
      pid: process.pid,
      processStart: "still-live-after-runtime-cleanup",
      serverVersion: "1.2.2",
      wireVersion: "1",
      serviceMode: "foreground" as const,
      nonceDigest: createHash("sha256").update("removed-with-runtime-directory").digest("hex"),
      createdAt: "2026-08-09T10:00:00.000Z",
    };
    await writeFile(paths.ownerReceiptPath, encodeOwnerReceipt(receipt), {
      mode: 0o600,
    });

    await expect(
      acquireHostRuntimeOwner({
        paths,
        hostId: receipt.hostId,
        instanceId: "33333333-3333-4333-8333-333333333333",
        serverVersion: "1.2.3",
        wireVersion: "1",
        serviceMode: "foreground",
        processStart: "replacement-start",
        processAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "owner-unhealthy" });

    expect(decodeOwnerReceipt(await readFile(paths.ownerReceiptPath, "utf8"))).toEqual(receipt);
    await expect(lstat(paths.controlSecretPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(paths.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when the socket identity changes during stale-owner liveness inspection", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-stale-owner-toctou-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const stalePid = await leaveStaleSocket(paths.socketPath);
    const secret = "stale-control-secret";
    await writeFile(paths.controlSecretPath, secret, { mode: 0o600 });
    await writeFile(
      paths.ownerReceiptPath,
      encodeOwnerReceipt({
        schemaVersion: 1,
        hostId: "11111111-1111-4111-8111-111111111111",
        instanceId: "22222222-2222-4222-8222-222222222222",
        endpoint: paths.socketPath,
        pid: stalePid,
        processStart: "stale-start",
        serverVersion: "1.2.2",
        wireVersion: "1",
        serviceMode: "foreground",
        nonceDigest: createHash("sha256").update(secret).digest("hex"),
        createdAt: "2026-08-09T10:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    let replacementSocket: Server | undefined;
    let result: Awaited<ReturnType<typeof acquireHostRuntimeOwner>> | undefined;
    let thrown: unknown;
    try {
      result = await acquireHostRuntimeOwner({
        paths,
        hostId: "11111111-1111-4111-8111-111111111111",
        instanceId: "33333333-3333-4333-8333-333333333333",
        serverVersion: "1.2.3",
        wireVersion: "1",
        serviceMode: "foreground",
        processStart: "replacement-start",
        processAlive: async () => {
          await unlink(paths.socketPath);
          replacementSocket = createServer();
          await new Promise<void>((resolve, reject) => {
            replacementSocket?.once("error", reject);
            replacementSocket?.listen(paths.socketPath, resolve);
          });
          return false;
        },
      });
    } catch (error) {
      thrown = error;
    }
    if (result?.kind === "owner") owners.push(result);

    expect(thrown).toMatchObject({ code: "ambiguous-owner-node" });
    expect((await lstat(paths.socketPath)).isSocket()).toBe(true);
    await closeFixtureServer(replacementSocket);
    await rm(paths.socketPath, { force: true });
  });

  it("fails closed before quarantine when the stale receipt does not match the socket owner", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-inconsistent-owner-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const stalePid = await leaveStaleSocket(paths.socketPath);
    const secret = "inconsistent-control-secret";
    await writeFile(paths.controlSecretPath, secret, { mode: 0o600 });
    await writeFile(
      paths.ownerReceiptPath,
      encodeOwnerReceipt({
        schemaVersion: 1,
        hostId: "99999999-9999-4999-8999-999999999999",
        instanceId: "22222222-2222-4222-8222-222222222222",
        endpoint: paths.socketPath,
        pid: stalePid,
        processStart: "copied-receipt",
        serverVersion: "1.2.2",
        wireVersion: "1",
        serviceMode: "foreground",
        nonceDigest: createHash("sha256").update(secret).digest("hex"),
        createdAt: "2026-08-09T10:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const processAlive = vi.fn(() => false);

    await expect(
      acquireHostRuntimeOwner({
        paths,
        hostId: "11111111-1111-4111-8111-111111111111",
        instanceId: "33333333-3333-4333-8333-333333333333",
        serverVersion: "1.2.3",
        wireVersion: "1",
        serviceMode: "foreground",
        processStart: "replacement-start",
        processAlive,
      }),
    ).rejects.toMatchObject({ code: "owner-unhealthy" });
    expect(processAlive).not.toHaveBeenCalled();
    expect((await lstat(paths.socketPath)).isSocket()).toBe(true);
  });

  it("fails closed when an unreachable socket may still have a live owner", async () => {
    const runtimeBase = await realpath(tmpdir());
    const root = await mkdtemp(join(runtimeBase, "octant-live-owner-"));
    temporaryRoots.push(root);
    const paths = resolveHostRuntimePaths({
      env: { OCTANT_DATA_DIR: join(root, "data") },
      platform: filesystemTestPlatform,
      home: join(root, "home"),
      temporaryDirectory: runtimeBase,
      uid: process.getuid?.() ?? 1000,
    });
    await prepareHostRuntimePaths(paths);
    const stalePid = await leaveStaleSocket(paths.socketPath);
    const secret = "unreachable-control-secret";
    await writeFile(paths.controlSecretPath, secret, { mode: 0o600 });
    await writeFile(
      paths.ownerReceiptPath,
      encodeOwnerReceipt({
        schemaVersion: 1,
        hostId: "11111111-1111-4111-8111-111111111111",
        instanceId: "22222222-2222-4222-8222-222222222222",
        endpoint: paths.socketPath,
        pid: stalePid,
        processStart: "possible-pid-reuse",
        serverVersion: "1.2.2",
        wireVersion: "1",
        serviceMode: "foreground",
        nonceDigest: createHash("sha256").update(secret).digest("hex"),
        createdAt: "2026-08-09T10:00:00.000Z",
      }),
      { mode: 0o600 },
    );

    await expect(
      acquireHostRuntimeOwner({
        paths,
        hostId: "11111111-1111-4111-8111-111111111111",
        instanceId: "33333333-3333-4333-8333-333333333333",
        serverVersion: "1.2.3",
        wireVersion: "1",
        serviceMode: "foreground",
        processStart: "replacement-start",
        processAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "owner-unhealthy" });
    expect((await lstat(paths.socketPath)).isSocket()).toBe(true);
    await unlink(paths.socketPath);
  });
});

async function leaveStaleSocket(path: string): Promise<number> {
  const source = `const {createServer}=require("node:net");const server=createServer();server.listen(${JSON.stringify(path)},()=>{process.stdout.write("ready\\n");process.exit(0)});`;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  const output = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 && stdout.includes("ready")) resolve(stdout);
      else reject(new Error(`stale socket fixture failed: ${stderr}`));
    });
  });
  expect(output).toContain("ready");
  if (child.pid === undefined) throw new Error("stale socket fixture has no pid");
  return child.pid;
}

async function closeFixtureServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
