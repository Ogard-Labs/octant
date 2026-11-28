import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  AggregateId,
  HOST_UPDATE_REQUESTED_EVENT_NAME,
  HOST_UPDATE_STEP_EVENT_NAME,
  decodeHostUpdateStatus,
  decodeUtcTimestamp,
  type EventActor,
} from "@octant/contracts";
import { decodeHeadlessBuildRelease } from "@octant/contracts/app-updates";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import {
  authorizeHostControlAction,
  authorizePrincipalAction,
  canonicalHeadlessReleaseBytes,
} from "@octant/domain";
import {
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  HEADLESS_ARTIFACT_SIGNATURE_FILENAME,
  encodeHeadlessArtifactManifest,
  encodeHeadlessArtifactSignature,
  signHeadlessArtifactManifest,
  writeHostUpdateResultFile,
  type HeadlessArtifactManifest,
} from "@octant/host-runtime";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthenticatedProductDispatch } from "./authenticatedProductRoutes";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import {
  createDesktopHostUpdateRouteHandler,
  DESKTOP_HOST_UPDATE_ROUTE,
} from "./desktopHostUpdateRoutes";
import { createHostControlRouteHandler } from "./hostControlRoutes";
import { HostDrain } from "./hostDrain";
import { launchOutOfServiceUpgrade } from "./hostUpdateRunner";
import { HostUpdateService } from "./hostUpdateService";
import { Journal } from "./persistence/journal";
import { MIGRATIONS, applyMigrations } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { createRemoteRoutePolicy } from "./remoteRoutePolicy";
import { createHeadlessBuilds } from "./shield/headlessBuilds";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const TARGET =
  process.platform === "darwin"
    ? "darwin-arm64"
    : process.arch === "arm64"
      ? "linux-arm64"
      : "linux-x64";
const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.platform === "darwin" ? "arm64" : process.arch === "arm64" ? "arm64" : "x64";
const BRIDGE_SECRET = "desktop-bridge-secret-for-update-tests-123456";
const WINDOW_ID = "70000000-0000-4000-8000-000000000010";
const CAPABILITY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const NOW_MS = new Date("2026-11-28T14:00:00.000Z").getTime();

const tempDirs: string[] = [];
const connections: SqliteConnection[] = [];

afterEach(() => {
  for (const conn of connections.splice(0)) conn.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createJournalFixture() {
  const dir = makeTempDir("octant-host-update-db-");
  const connection = openSqlite(join(dir, "octant.sqlite3"));
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => "2026-11-28T14:00:00.000Z");
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    projections: registries.projections,
    registry: registries.events,
    clock: () => "2026-11-28T14:00:00.000Z",
  });
  return { dir, connection, journal };
}

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

function asFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(handler, {
    preconnect: () => undefined,
  }) as typeof globalThis.fetch;
}

function createTarballBytes(artifactRoot: string, archivePrefix: string): Buffer {
  const files = [
    "bin/octant",
    "lib/native/better_sqlite3.node",
    "lib/runtime/bun",
    "lib/server/main.mjs",
    HEADLESS_ARTIFACT_MANIFEST_FILENAME,
    HEADLESS_ARTIFACT_SIGNATURE_FILENAME,
    "share/NOTICES.txt",
    "share/migrations.json",
    "share/service/octant.service.template",
    "share/web/index.html",
  ];
  const blocks: Buffer[] = [];
  for (const rel of files) {
    const full = join(artifactRoot, rel);
    const contents = readFileSync(full);
    const header = Buffer.alloc(512);
    const name = `${archivePrefix}/${rel}`;
    header.write(name, 0, 100, "utf8");
    header.write(`${(0o755).toString(8).padStart(7, "0")}\0`, 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    header.write(`${contents.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    header.write("00000000000\0", 136, 12, "utf8");
    header.fill(" ", 148, 156);
    header.write("0", 156, 1, "utf8");
    header.write("ustar", 257, 5, "utf8");
    header.write("00", 263, 2, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    blocks.push(header, contents);
    const rem = contents.byteLength % 512;
    if (rem !== 0) blocks.push(Buffer.alloc(512 - rem));
  }
  blocks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(blocks));
}

function buildSignedHeadlessFixture(options: {
  readonly version: string;
  readonly storeVersion: number;
  readonly ring: "stable" | "candidate";
  readonly privateKeyBase64: string;
}) {
  const dir = makeTempDir("octant-signed-headless-");
  const prefix = `octant-${options.version}-${TARGET}`;
  const root = join(dir, prefix);
  const components: ReadonlyArray<readonly [string, string, string]> = [
    ["server", "lib/server/main.mjs", `server-${options.version}`],
    ["cli", "bin/octant", `#!/bin/sh\necho ${options.version}\n`],
    ["web-assets", "share/web/index.html", "<html></html>"],
    ["native-module", "lib/native/better_sqlite3.node", "native-bytes"],
    ["migrations", "share/migrations.json", `{"storeVersion":${options.storeVersion}}`],
    ["notices", "share/NOTICES.txt", "notices"],
    ["service-template", "share/service/octant.service.template", "[Unit]"],
    ["runtime", "lib/runtime/bun", "bun-bytes"],
  ];
  for (const [, path, body] of components) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const manifest: HeadlessArtifactManifest = {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: options.version,
    target: { platform: PLATFORM, arch: ARCH },
    wireVersion: "1",
    storeVersion: options.storeVersion,
    components: components.map(([role, path, body]) => ({
      role: role as HeadlessArtifactManifest["components"][number]["role"],
      path,
      sha256: createHash("sha256").update(body).digest("hex"),
      byteLength: Buffer.byteLength(body),
      ...(role === "server" || role === "cli" || role === "web-assets"
        ? { version: options.version }
        : {}),
    })),
  };
  const manifestText = encodeHeadlessArtifactManifest(manifest);
  writeFileSync(join(root, HEADLESS_ARTIFACT_MANIFEST_FILENAME), manifestText);
  const sig = signHeadlessArtifactManifest(manifest, options.ring, options.privateKeyBase64);
  writeFileSync(
    join(root, HEADLESS_ARTIFACT_SIGNATURE_FILENAME),
    encodeHeadlessArtifactSignature(sig),
  );
  const tarBytes = createTarballBytes(root, prefix);
  const tarSha256 = createHash("sha256").update(tarBytes).digest("hex");
  const artifactUrl = `https://updates.octant.example/artifacts/${prefix}.tar.gz`;
  const feedRelease = decodeHeadlessBuildRelease({
    product: "octant",
    version: options.version,
    target: TARGET,
    ring: options.ring,
    url: artifactUrl,
    sha256: tarSha256,
    releasedAt: "2026-11-28T12:00:00.000Z",
  });
  const privateKey = createPrivateKey({
    key: Buffer.from(options.privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const feedSignature = sign(null, canonicalHeadlessReleaseBytes(feedRelease), privateKey).toString(
    "base64",
  );
  const feedDocument = {
    schemaVersion: 1,
    release: feedRelease,
    signature: feedSignature,
  };
  return { root, tarBytes, tarSha256, artifactUrl, feedDocument };
}

function readJournalEvents(connection: SqliteConnection, eventName: string) {
  return connection
    .prepare(
      "SELECT payload_json AS payload, actor_kind AS actor FROM event_journal WHERE event_name = ? ORDER BY global_sequence",
    )
    .all(eventName) as ReadonlyArray<{ readonly payload: string; readonly actor: string }>;
}

describe("host.service.update policy and /api/host-control/update authorization", () => {
  it("allows only local windows and person-paired Full devices, refusing restricted, hub-introduced, agent, and peer callers", async () => {
    expect(
      authorizeHostControlAction({ principalKind: "local-window", operation: "update" }),
    ).toEqual({ kind: "allow" });
    expect(
      authorizeHostControlAction({ principalKind: "person-paired-device", operation: "update" }),
    ).toEqual({ kind: "allow" });
    expect(
      authorizeHostControlAction({ principalKind: "remote-device", operation: "update" }),
    ).toEqual({ kind: "deny", reason: "local-host-required" });
    expect(
      authorizePrincipalAction({
        principalKind: "person-paired-device",
        action: "host.service.update",
        accessLevel: "read-only",
      }),
    ).toEqual({ kind: "deny", reason: "local-host-required" });
    expect(
      authorizePrincipalAction({
        principalKind: "person-paired-device",
        action: "host.service.update",
        accessLevel: "approve-and-steer",
      }),
    ).toEqual({ kind: "deny", reason: "local-host-required" });

    // Route forwarding policy allows POST /api/host-control/update on the authenticated surface,
    // and dispatch + hostControlRoutes refuse every non-Full-person principal.
    const routePolicy = createRemoteRoutePolicy({ origin: "https://octant.example:8443" });
    expect(
      routePolicy.inspect(
        new Request("https://octant.example:8443/api/host-control/update", {
          method: "POST",
          headers: {
            host: "octant.example:8443",
            origin: "https://octant.example:8443",
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
        }),
      ),
    ).toMatchObject({ kind: "allow", surface: "authenticated-product" });

    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({
      windowId: WINDOW_ID as never,
      capability: CAPABILITY,
      now: NOW_MS,
    });
    const handleUpdate = vi.fn(async () => ({
      hostKind: "headless" as const,
      state: "idle" as const,
      fromVersion: "0.1.0",
    }));
    const hostControlHandler = createHostControlRouteHandler({
      windowAuthorityStore,
      diagnostics: () => undefined,
      hostUpdate: { handle: handleUpdate },
      now: () => NOW_MS,
    });
    const dispatch = createAuthenticatedProductDispatch({
      dispatch: (request) => hostControlHandler(request),
    });
    const body = JSON.stringify({ action: "status" });
    const makeRemoteRequest = () =>
      new Request("https://octant.example:8443/api/host-control/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    const makePrincipal = (options: {
      readonly suffix: string;
      readonly admittedBy: "host-person" | "hub-roster";
      readonly accessLevel?: "read-only" | "approve-and-steer";
    }) =>
      createRemoteDevicePrincipal({
        hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
        deviceId: `10000000-0000-4000-8000-00000000000${options.suffix}` as DeviceId,
        sessionId: `20000000-0000-4000-8000-00000000000${options.suffix}` as RemoteSessionId,
        credentialGeneration: 1,
        origin: "https://octant.example:8443",
        protocolVersion: 1,
        capabilityDigest: options.suffix.repeat(64).slice(0, 64),
        admittedBy: options.admittedBy,
        ...(options.accessLevel !== undefined ? { accessLevel: options.accessLevel } : {}),
      });

    // Person-paired Full device is admitted.
    const fullResponse = await dispatch({
      request: makeRemoteRequest(),
      principal: makePrincipal({ suffix: "1", admittedBy: "host-person" }),
    });
    expect(fullResponse?.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledTimes(1);

    // Lower access level, hub-introduced device, and unproved pairings are all refused 403.
    for (const principal of [
      makePrincipal({ suffix: "2", admittedBy: "host-person", accessLevel: "read-only" }),
      makePrincipal({ suffix: "3", admittedBy: "host-person", accessLevel: "approve-and-steer" }),
      makePrincipal({ suffix: "4", admittedBy: "hub-roster" }),
    ]) {
      const denied = await dispatch({ request: makeRemoteRequest(), principal });
      expect(denied?.status).toBe(403);
    }

    // Disallowed payload fields (URL, path, version choice, arguments) are rejected with 400.
    const badPayload = await hostControlHandler(
      new Request("http://127.0.0.1:3100/api/host-control/update", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": CAPABILITY,
        },
        body: JSON.stringify({
          action: "start",
          requestId: randomUUID(),
          expectedCurrentVersion: "0.1.0",
          drain: { kind: "stop-now" },
          url: "https://evil.example/octant.tar.gz",
        }),
      }),
    );
    expect(badPayload?.status).toBe(400);
  });
});

describe("HostUpdateService standalone headless lifecycle", () => {
  it("verifies a signed newer fixture, drains, launches out-of-service upgrade, and journals the atomic result file at next start", async () => {
    const keys = makeKeyPair();
    const fixture = buildSignedHeadlessFixture({
      version: "0.2.0",
      storeVersion: 2,
      ring: "stable",
      privateKeyBase64: keys.privateKeyBase64,
    });
    const { dir, connection, journal } = createJournalFixture();
    const stateDirectory = join(dir, "state");
    const installRoot = join(stateDirectory, "install");
    const resultPath = join(stateDirectory, "host-update-result.json");
    const pendingPath = join(stateDirectory, "host-update-pending.json");
    const drain = new HostDrain({ now: () => NOW_MS });
    const builds = createHeadlessBuilds({
      folder: join(dir, "headless-builds"),
      trustedKeys: {
        stable: [keys.publicKeyBase64],
        candidate: [keys.publicKeyBase64],
        preview: [],
      },
      feed: {
        baseUrl: "https://updates.octant.example",
        ring: () => "stable",
        fetch: asFetch(async (input) => {
          const url = String(input);
          if (url === fixture.artifactUrl) {
            return new Response(new Uint8Array(fixture.tarBytes), { status: 200 });
          }
          if (url.endsWith(".json")) {
            return new Response(JSON.stringify(fixture.feedDocument), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("not found", { status: 404 });
        }),
      },
    });

    const launchedSpecs: Array<{
      readonly installRoot: string;
      readonly updateContextPath: string;
    }> = [];
    const service = new HostUpdateService({
      hostKind: "headless",
      currentVersion: () => "0.1.0",
      currentRing: () => "stable",
      platform: PLATFORM,
      arch: ARCH,
      uid: 501,
      stateDirectory,
      installRoot,
      resultPath,
      pendingPath,
      builds,
      drain,
      connection,
      journal,
      clock: () => "2026-11-28T14:00:00.000Z",
      uuid: randomUUID,
      sleep: async () => undefined,
      readInstalledStoreVersion: async () => 1,
      launchUpgrade: async (input) => {
        launchedSpecs.push({
          installRoot: input.installRoot,
          updateContextPath: input.updateContextPath,
        });
        return { status: "launched" };
      },
    });

    const requestId = decodeAggregateId(randomUUID());
    const remoteActor: EventActor = {
      kind: "remote-device",
      actorId: "00000000-0000-4000-8000-000000000099" as never,
      deviceId: "10000000-0000-4000-8000-000000000099" as never,
    };

    let status = await service.handle(
      { action: "prepare", requestId, expectedCurrentVersion: "0.1.0" },
      remoteActor,
    );
    for (let i = 0; i < 40 && status.state === "preparing"; i += 1) {
      await new Promise((done) => setTimeout(done, 25));
      status = await service.handle({ action: "status", requestId }, remoteActor);
    }
    expect(status.state).toBe("update-available");
    expect(status.toVersion).toBe("0.2.0");
    expect(status.storeMigration).toBe(true);

    // Start is idempotent by requestId; a second different requestId is refused while active.
    const started = await service.handle(
      {
        action: "start",
        requestId,
        expectedCurrentVersion: "0.1.0",
        drain: { kind: "wait", minutes: 5 },
      },
      remoteActor,
    );
    expect(started.state).toBe("running");

    const idempotentRepeat = await service.handle(
      {
        action: "start",
        requestId,
        expectedCurrentVersion: "0.1.0",
        drain: { kind: "wait", minutes: 5 },
      },
      remoteActor,
    );
    expect(idempotentRepeat.requestId).toBe(requestId);

    const competing = await service.handle(
      {
        action: "start",
        requestId: decodeAggregateId(randomUUID()),
        expectedCurrentVersion: "0.1.0",
        drain: { kind: "stop-now" },
      },
      remoteActor,
    );
    expect(competing.state).toBe("refused");
    expect(competing.failureReason).toBe("already-updating");

    // Wait for background unpack + launch to complete.
    for (let i = 0; i < 40 && launchedSpecs.length === 0; i += 1) {
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(launchedSpecs).toHaveLength(1);
    service.dispose();

    const requestedEvents = readJournalEvents(connection, HOST_UPDATE_REQUESTED_EVENT_NAME);
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0]?.payload).not.toContain("https://");

    // Simulate the out-of-service runner writing the atomic result file and the upgraded host starting next.
    await writeHostUpdateResultFile(resultPath, {
      schemaVersion: 1,
      requestId,
      actor: remoteActor,
      hostKind: "headless",
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      ring: "stable",
      drain: { kind: "wait", minutes: 5 },
      storeMigration: true,
      outcome: "updated",
      step: "health-check",
      completedAt: decodeUtcTimestamp("2026-11-28T14:01:00.000Z"),
    });

    const restartedService = new HostUpdateService({
      hostKind: "headless",
      currentVersion: () => "0.2.0",
      currentRing: () => "stable",
      platform: PLATFORM,
      arch: ARCH,
      uid: 501,
      stateDirectory,
      installRoot,
      resultPath,
      pendingPath,
      builds,
      drain: new HostDrain({ now: () => NOW_MS }),
      connection,
      journal,
      clock: () => "2026-11-28T14:01:05.000Z",
      uuid: randomUUID,
    });
    await restartedService.reconcileStartupResult();
    const afterStatus = await restartedService.handle({ action: "status", requestId });
    expect(afterStatus.state).toBe("updated");
    expect(afterStatus.toVersion).toBe("0.2.0");

    const stepEvents = readJournalEvents(connection, HOST_UPDATE_STEP_EVENT_NAME);
    expect(stepEvents).toHaveLength(1);
    const firstStepPayload = stepEvents[0]?.payload;
    expect(firstStepPayload).toBeDefined();
    expect(JSON.parse(firstStepPayload ?? "{}")).toMatchObject({
      requestId,
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      outcome: "succeeded",
      step: "health-check",
    });
    restartedService.dispose();
  });

  it("refuses bad signature and digest mismatch without launching an upgrade", async () => {
    const trustedKeys = makeKeyPair();
    const untrustedKeys = makeKeyPair();
    const badSigFixture = buildSignedHeadlessFixture({
      version: "0.2.0",
      storeVersion: 1,
      ring: "stable",
      privateKeyBase64: untrustedKeys.privateKeyBase64,
    });
    const goodSigFixture = buildSignedHeadlessFixture({
      version: "0.2.0",
      storeVersion: 1,
      ring: "stable",
      privateKeyBase64: trustedKeys.privateKeyBase64,
    });

    const runPrepare = async (fetchImpl: typeof globalThis.fetch) => {
      const { dir, connection, journal } = createJournalFixture();
      const stateDirectory = join(dir, "state");
      const builds = createHeadlessBuilds({
        folder: join(dir, "builds"),
        trustedKeys: { stable: [trustedKeys.publicKeyBase64], candidate: [], preview: [] },
        feed: { baseUrl: "https://updates.octant.example", ring: () => "stable", fetch: fetchImpl },
      });
      const service = new HostUpdateService({
        hostKind: "headless",
        currentVersion: () => "0.1.0",
        currentRing: () => "stable",
        platform: PLATFORM,
        arch: ARCH,
        uid: 501,
        stateDirectory,
        installRoot: join(stateDirectory, "install"),
        resultPath: join(stateDirectory, "host-update-result.json"),
        pendingPath: join(stateDirectory, "host-update-pending.json"),
        builds,
        drain: new HostDrain({ now: () => NOW_MS }),
        connection,
        journal,
        clock: () => "2026-11-28T14:00:00.000Z",
        uuid: randomUUID,
      });
      const requestId = decodeAggregateId(randomUUID());
      let status = await service.handle({
        action: "prepare",
        requestId,
        expectedCurrentVersion: "0.1.0",
      });
      for (let i = 0; i < 40 && status.state === "preparing"; i += 1) {
        await new Promise((done) => setTimeout(done, 25));
        status = await service.handle({ action: "status", requestId });
      }
      service.dispose();
      return status;
    };

    const badSigStatus = await runPrepare(
      asFetch(
        async () =>
          new Response(JSON.stringify(badSigFixture.feedDocument), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    expect(badSigStatus.state).toBe("refused");
    expect(badSigStatus.failureReason).toBe("untrusted-signature");

    const digestMismatchStatus = await runPrepare(
      asFetch(async (input) => {
        const url = String(input);
        if (url === goodSigFixture.artifactUrl) {
          return new Response(new Uint8Array(Buffer.from("corrupted-tarball")), { status: 200 });
        }
        return new Response(JSON.stringify(goodSigFixture.feedDocument), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    expect(digestMismatchStatus.state).toBe("refused");
    expect(digestMismatchStatus.failureReason).toBe("digest-mismatch");
  });

  it("lifts drain and stays on the old version when out-of-service runner launch fails before swap", async () => {
    const keys = makeKeyPair();
    const fixture = buildSignedHeadlessFixture({
      version: "0.2.0",
      storeVersion: 1,
      ring: "stable",
      privateKeyBase64: keys.privateKeyBase64,
    });
    const { dir, connection, journal } = createJournalFixture();
    const stateDirectory = join(dir, "state");
    const buildsFolder = join(dir, "builds");
    mkdirSync(buildsFolder, { recursive: true });
    writeFileSync(join(buildsFolder, `octant-0.2.0-${TARGET}.tar.gz`), fixture.tarBytes);
    const drain = new HostDrain({ now: () => NOW_MS });
    const builds = createHeadlessBuilds({
      folder: buildsFolder,
      trustedKeys: { stable: [keys.publicKeyBase64], candidate: [], preview: [] },
    });
    const service = new HostUpdateService({
      hostKind: "headless",
      currentVersion: () => "0.1.0",
      currentRing: () => "stable",
      platform: PLATFORM,
      arch: ARCH,
      uid: 501,
      stateDirectory,
      installRoot: join(stateDirectory, "install"),
      resultPath: join(stateDirectory, "host-update-result.json"),
      pendingPath: join(stateDirectory, "host-update-pending.json"),
      builds,
      drain,
      connection,
      journal,
      clock: () => "2026-11-28T14:00:00.000Z",
      uuid: randomUUID,
      readInstalledStoreVersion: async () => 1,
      launchUpgrade: async () => ({ status: "failed" }),
    });

    const requestId = decodeAggregateId(randomUUID());
    await service.handle({ action: "prepare", requestId, expectedCurrentVersion: "0.1.0" });
    await service.handle({
      action: "start",
      requestId,
      expectedCurrentVersion: "0.1.0",
      drain: { kind: "stop-now" },
    });

    let status = await service.handle({ action: "status", requestId });
    for (let i = 0; i < 40 && status.state === "running"; i += 1) {
      await new Promise((done) => setTimeout(done, 25));
      status = await service.handle({ action: "status", requestId });
    }
    expect(status.state).toBe("failed");
    expect(status.failureReason).toBe("runner-launch-failed");
    expect(drain.status()).toEqual({ state: "not-draining" });
    service.dispose();
  });

  it("spawns systemd-run on Linux and a one-shot launchd job on macOS without --self-built", async () => {
    const root = makeTempDir("octant-runner-launch-");
    const installRoot = join(root, "install");
    const stateDirectory = join(root, "state");
    mkdirSync(join(installRoot, "current", "bin"), { recursive: true });
    writeFileSync(join(installRoot, "current", "bin", "octant"), "#!/bin/sh\n");
    const contextPath = join(stateDirectory, "host-update", "ctx.json");
    mkdirSync(dirname(contextPath), { recursive: true });
    writeFileSync(contextPath, "{}");

    const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
    const runner = {
      run: async (command: string, args: readonly string[]) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    };

    const linuxResult = await launchOutOfServiceUpgrade({
      platform: "linux",
      uid: 1000,
      requestId: "12345678-1234-4123-8123-1234567890ab",
      installRoot,
      stateDirectory,
      artifactRoot: join(root, "unpacked"),
      updateContextPath: contextPath,
      environment: { OCTANT_DATA_DIR: "/data", SECRET_TOKEN: "must-not-pass" },
      runner,
    });
    expect(linuxResult.status).toBe("launched");
    expect(calls[0]?.command).toBe("/usr/bin/systemd-run");
    expect(calls[0]?.args).toContain("--user");
    expect(calls[0]?.args).toContain("--setenv=OCTANT_DATA_DIR=/data");
    expect(calls[0]?.args.join(" ")).not.toContain("SECRET_TOKEN");
    expect(calls[0]?.args).not.toContain("--self-built");

    const darwinResult = await launchOutOfServiceUpgrade({
      platform: "darwin",
      uid: 501,
      requestId: "12345678-1234-4123-8123-1234567890ab",
      installRoot,
      stateDirectory,
      artifactRoot: join(root, "unpacked"),
      updateContextPath: contextPath,
      environment: { OCTANT_DATA_DIR: "/data" },
      runner,
    });
    expect(darwinResult.status).toBe("launched");
    expect(calls[1]?.command).toBe("/bin/launchctl");
    expect(calls[1]?.args[0]).toBe("bootstrap");
    expect(calls[1]?.args[1]).toBe("gui/501");
    const plistPath = calls[1]?.args[2];
    expect(plistPath).toBeDefined();
    const plist = readFileSync(plistPath ?? "", "utf8");
    expect(plist).toContain("AbandonProcessGroup");
    expect(plist).not.toContain("--self-built");
  });

  it("coordinates remote desktop app updates over loopback /api/desktop/host-update with bridge-secret auth", async () => {
    const { dir, connection, journal } = createJournalFixture();
    const stateDirectory = join(dir, "state");
    const service = new HostUpdateService({
      hostKind: "desktop",
      currentVersion: () => "0.1.0",
      currentRing: () => "stable",
      platform: PLATFORM,
      arch: ARCH,
      uid: 501,
      stateDirectory,
      installRoot: join(stateDirectory, "install"),
      resultPath: join(stateDirectory, "host-update-result.json"),
      pendingPath: join(stateDirectory, "host-update-pending.json"),
      drain: new HostDrain({ now: () => NOW_MS }),
      connection,
      journal,
      clock: () => "2026-11-28T14:00:00.000Z",
      uuid: randomUUID,
    });
    const desktopRoute = createDesktopHostUpdateRouteHandler({
      desktopBridgeSecret: BRIDGE_SECRET,
      readPending: () => service.readDesktopPending(),
      reportUpdate: (report) => service.reportDesktopUpdate(report),
    });

    // Unauthenticated loopback call is refused 401.
    const unauth = await desktopRoute(
      new Request(`http://127.0.0.1:3100${DESKTOP_HOST_UPDATE_ROUTE}`, { method: "GET" }),
    );
    expect(unauth?.status).toBe(401);

    const requestId = decodeAggregateId(randomUUID());
    const prepared = await service.handle({
      action: "prepare",
      requestId,
      expectedCurrentVersion: "0.1.0",
    });
    expect(prepared.state).toBe("preparing");

    const pendingRes = await desktopRoute(
      new Request(`http://127.0.0.1:3100${DESKTOP_HOST_UPDATE_ROUTE}`, {
        method: "GET",
        headers: { "x-octant-desktop-secret": BRIDGE_SECRET },
      }),
    );
    expect(pendingRes?.status).toBe(200);
    expect(await pendingRes?.json()).toEqual({
      pending: { requestId, action: "prepare", expectedCurrentVersion: "0.1.0" },
    });

    await desktopRoute(
      new Request(`http://127.0.0.1:3100${DESKTOP_HOST_UPDATE_ROUTE}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": BRIDGE_SECRET,
        },
        body: JSON.stringify({
          requestId,
          state: "update-available",
          fromVersion: "0.1.0",
          toVersion: "0.2.0",
          ring: "stable",
          step: "prepare",
        }),
      }),
    );
    const available = decodeHostUpdateStatus(await service.handle({ action: "status", requestId }));
    expect(available.state).toBe("update-available");
    expect(available.toVersion).toBe("0.2.0");

    await service.handle({
      action: "start",
      requestId,
      expectedCurrentVersion: "0.1.0",
      drain: { kind: "wait", minutes: 10 },
    });

    // Desktop main reports waiting-for-work while active turns are running, then installing.
    await desktopRoute(
      new Request(`http://127.0.0.1:3100${DESKTOP_HOST_UPDATE_ROUTE}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": BRIDGE_SECRET,
        },
        body: JSON.stringify({
          requestId,
          state: "waiting-for-work",
          fromVersion: "0.1.0",
          toVersion: "0.2.0",
          ring: "stable",
          step: "install",
          activeAgentCount: 2,
          activityUnconfirmed: false,
        }),
      }),
    );
    const waiting = await service.handle({ action: "status", requestId });
    expect(waiting.state).toBe("waiting-for-work");
    expect(waiting.activeAgentCount).toBe(2);

    await desktopRoute(
      new Request(`http://127.0.0.1:3100${DESKTOP_HOST_UPDATE_ROUTE}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": BRIDGE_SECRET,
        },
        body: JSON.stringify({
          requestId,
          state: "installing",
          fromVersion: "0.1.0",
          toVersion: "0.2.0",
          ring: "stable",
          step: "install",
        }),
      }),
    );
    const installing = await service.handle({ action: "status", requestId });
    expect(installing.state).toBe("installing");
    expect(readJournalEvents(connection, HOST_UPDATE_REQUESTED_EVENT_NAME)).toHaveLength(1);
    expect(readJournalEvents(connection, HOST_UPDATE_STEP_EVENT_NAME)).toHaveLength(2);
    service.dispose();
  });
});
