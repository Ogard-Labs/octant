// Remote exit evidence A — disposable-host/two-browser harness and
// pair/use/reconnect matrix.
//
// Boots a disposable Octant host: the REAL dual-listener gateway
// (`createRemoteGateway`) over real HTTPS (openssl CA + CA-signed cert, no
// certificate bypass) on an available private/Tailscale interface, with a
// real SQLite store/journal and a bounded product-dispatch fixture. The host
// serves the evidence page + the bundled client-runtime driver at the remote
// origin (the production model: the web shell is served BY the host).
//
// TWO isolated Chromium profiles (separate Playwright contexts) run the REAL
// client-runtime pairing/session/surface clients inside the page, so the
// matrix exercises the actual production transport, device-key (IndexedDB),
// session-cookie, proof, and reconnect/replay paths — not raw HTTP. Host-side
// actions (approve, revoke, restart, reconcile) are performed by the harness
// through the gateway's local administration port / captured lifecycle, the
// same way the packaged desktop does.
//
// Evidence rows are recorded with exact heads; every row carries redacted
// evidence (identities hashed, no device keys / ticket proofs / session
// secrets / tokens / cookies). Deterministically untestable rows — reload/
// reboot device-credential rehydration (not implemented yet), Tailscale-cert
// endpoint parity, packaged-native approval, and two-live-process rows — are
// recorded as NAMED SKIPS with exact reproduction commands, never as
// failures.
//
// Fails with a non-zero explanatory exit if no private interface, openssl,
// bun, Chromium executable, or macOS security trust-store tool is available.

import { execFileSync, execSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  decodeStableHostId,
  REMOTE_ACCESS_EVENT_NAMES,
  type StableHostId,
} from "@octant/contracts/remote-access";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Journal } from "../persistence/journal";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  readDeviceRegistration,
  readRemoteCommandReceipt,
} from "../persistence/remoteAccessProjection";
import { nodeServe } from "../nodeServe";
import type { Serve } from "../server";
import type { RemoteClientPrincipalHandoff } from "./remoteHttpAuthentication";
import {
  createRemoteGateway,
  type RemoteGateway,
  type RemoteGatewayConfig,
  type RemoteProductDispatch,
} from "./remoteGateway";

// Test-only lifecycle capture. The production gateway owns lifecycle
// composition (no caller-supplied override exists on RemoteGatewayServices).
// This vi.mock wraps the real PairingDeviceLifecycleService so the harness
// captures the exact instance the gateway constructs, enabling harness-side
// ticket creation/approval/inventory through the same in-memory ticket store
// the gateway uses — the same way the packaged desktop approves pairing.
const capturedLifecycles: PairingDeviceLifecycleService[] = [];
vi.mock("./pairingDeviceLifecycleService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pairingDeviceLifecycleService")>();
  const Real = actual.PairingDeviceLifecycleService;
  return {
    ...actual,
    PairingDeviceLifecycleService: class extends Real {
      constructor(options: ConstructorParameters<typeof Real>[0]) {
        super(options);
        capturedLifecycles.push(this);
      }
    },
  };
});
import { PairingDeviceLifecycleService } from "./pairingDeviceLifecycleService";

// Browser-realm driver surface (mirrors remoteExitEvidenceADriver.ts).
// page.evaluate callbacks execute inside Chromium at the evidence page, where
// the driver module augments the page global (`globalThis.__evidenceA`). The Node
// compiler cannot see the browser realm, so the surface is declared as a
// global here; at runtime the page script provides the implementation.
declare global {
  var __evidenceA: EvidenceDriverHandle;
  var __evidenceAPendingMutation:
    | Promise<{ status: "ambiguous" | "completed"; error?: string; httpStatus?: number }>
    | undefined;
  var __evidenceAStreamRead:
    | Promise<{ status: "aborted" | "completed"; error?: string; frames?: number }>
    | undefined;
}

interface EvidenceDriverHandle {
  init(): Promise<{
    ok: true;
    originDigest: string;
    fragmentCleared: boolean;
    hadFragment: boolean;
    deviceKeyStorage: "indexeddb" | "memory";
  }>;
  hello(): Promise<{
    productId: string;
    hostIdDigest: string;
    displayName: string;
    hostKeyFingerprintDigest: string;
    originDigest: string;
  }>;
  pair(input: { ticketId: string; ticketProof: string; deviceLabel: string }): Promise<{
    status: "claimed";
    ticketIdDigest: string;
    hostIdDigest: string;
    deviceLabel: string;
    deviceKeyFingerprintDigest: string;
    originDigest: string;
    sourceClass: string;
    claimedAt: string;
    expiresAt: string;
  }>;
  pollApproval(): Promise<
    | {
        status: "approved";
        deviceIdDigest: string;
        credentialGeneration: number;
        originDigest: string;
      }
    | { status: "pending" }
    | { status: "failed"; category: string }
  >;
  connect(): Promise<RedactedDriverState>;
  state(): Promise<RedactedDriverState>;
  runChatSurface(): Promise<DriverOperationResult>;
  runChatMutation(): Promise<DriverOperationResult>;
  runWorkSurface(): Promise<DriverOperationResult>;
  runWorkMutation(): Promise<DriverOperationResult>;
  runCodeSurface(): Promise<DriverOperationResult>;
  runCodeMutation(): Promise<DriverOperationResult>;
  runProviderSurface(): Promise<DriverOperationResult>;
  runSettingsSurface(): Promise<DriverOperationResult>;
  probeSurfaceStatus(): Promise<{ status: number }>;
  disconnect(): Promise<RedactedDriverState>;
  reconnect(): Promise<RedactedDriverState>;
  beginEvidenceMutation(): { status: "in-flight" };
  finishEvidenceMutation(): Promise<{
    status: "ambiguous" | "completed";
    error?: string;
    httpStatus?: number;
  }>;
  readStreamToEnd(): Promise<{ status: "aborted" | "completed"; error?: string; frames?: number }>;
  lookupReceipt(commandId: string): Promise<
    | {
        kind: "applied" | "pending" | "failed" | "not-found" | "ambiguous";
        commandIdDigest: string;
        operationKind?: string;
        reasonCode?: string;
      }
    | { kind: "error"; category: string; status?: number }
  >;
  rotateDeviceKey(): Promise<{ ok: true; newFingerprintDigest: string } | DriverOperationFailure>;
  ownDevice(): Promise<
    | {
        ok: true;
        deviceIdDigest: string;
        originDigest: string;
        credentialGeneration: number;
        state: string;
      }
    | DriverOperationFailure
  >;
  signOut(): Promise<RedactedDriverState>;
  revokeSelf(): Promise<RedactedDriverState>;
  clearStorage(): Promise<{ ok: true }>;
  storageState(): Promise<{ deviceKeyRecords: number }>;
}

type RedactedDriverState =
  | { kind: "idle" }
  | {
      kind: "connecting" | "negotiating" | "authenticating" | "reconnecting" | "stale";
      hostIdDigest: string;
    }
  | { kind: "ready"; hostIdDigest: string; displayName: string }
  | { kind: "incompatible" | "unauthorized" | "unavailable"; reason: string };

interface DriverOperationFailure {
  readonly ok: false;
  readonly category: string;
  readonly status?: number;
}

type DriverOperationResult = { readonly ok: true } | DriverOperationFailure;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../../");
const serverDir = join(repoRoot, "apps/server");
const EVIDENCE_ROOT = join(repoRoot, ".remote-exit-evidence-a");

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");

// ─── Prerequisites (computed once) ─────────────────────────────────────

interface EvidencePrereqs {
  readonly address: string;
  readonly sourceClass: "lan-private" | "tailscale";
  readonly caCertPath: string;
  readonly caCert: string;
  readonly serverCert: string;
  readonly serverKey: string;
  readonly chromium: string;
  readonly bun: string;
  readonly security: string;
}

function discoverPrivateInterface():
  | { address: string; class: "lan-private" | "tailscale" }
  | undefined {
  const interfaces = networkInterfaces();
  const candidates: { address: string; class: "lan-private" | "tailscale" }[] = [];
  for (const iface of Object.values(interfaces)) {
    if (iface === undefined) continue;
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const parts = addr.address.split(".").map(Number);
      if (parts.length !== 4) continue;
      const [a, b] = parts as [number, number, number, number];
      const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      const isTailscale = a === 100 && b >= 64 && b <= 127;
      if (isPrivate || isTailscale) {
        if (a === 172 && (b === 17 || b === 18)) continue; // Docker NAT rewrites source IPs
        candidates.push({
          address: addr.address,
          class: isTailscale ? "tailscale" : "lan-private",
        });
      }
    }
  }
  const tailscale = candidates.find((candidate) => candidate.class === "tailscale");
  return tailscale ?? candidates[0];
}

function generateCaAndServerCert(
  certDir: string,
  hostname: string,
): { caCertPath: string; caCert: string; serverCert: string; serverKey: string } | undefined {
  const caKeyPath = join(certDir, "ca.key");
  const caCertPath = join(certDir, "ca.crt");
  const serverKeyPath = join(certDir, "server.key");
  const serverCsrPath = join(certDir, "server.csr");
  const serverCertPath = join(certDir, "server.crt");
  const extPath = join(certDir, "server.ext");
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${caKeyPath}" -out "${caCertPath}" ` +
        `-days 1 -nodes -subj "/CN=Octant Test CA" 2>/dev/null`,
      { stdio: "pipe" },
    );
    execSync(
      `openssl req -newkey rsa:2048 -keyout "${serverKeyPath}" -out "${serverCsrPath}" ` +
        `-nodes -subj "/CN=${hostname}" 2>/dev/null`,
      { stdio: "pipe" },
    );
    writeFileSync(extPath, `subjectAltName=IP:${hostname}\n`);
    execSync(
      `openssl x509 -req -in "${serverCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" ` +
        `-CAcreateserial -out "${serverCertPath}" -days 1 -extfile "${extPath}" 2>/dev/null`,
      { stdio: "pipe" },
    );
  } catch {
    return undefined;
  }
  if (!existsSync(caCertPath) || !existsSync(serverCertPath) || !existsSync(serverKeyPath)) {
    return undefined;
  }
  return {
    caCertPath: caCertPath,
    caCert: readFileSync(caCertPath, "utf8"),
    serverCert: readFileSync(serverCertPath, "utf8"),
    serverKey: readFileSync(serverKeyPath, "utf8"),
  };
}

function findChromium(): string | undefined {
  const candidates = [
    ...(process.env.OCTANT_BROWSER_EXECUTABLE === undefined
      ? []
      : [process.env.OCTANT_BROWSER_EXECUTABLE]),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findBun(): string | undefined {
  try {
    execSync("bun --version", { stdio: "pipe" });
    return "bun";
  } catch {
    return undefined;
  }
}

function findSecurity(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    execFileSync("security", ["help"], { stdio: "ignore" });
    return "security";
  } catch {
    return undefined;
  }
}

const remoteExitEvidenceRequested = process.env.OCTANT_RUN_REMOTE_EXIT_EVIDENCE_A === "1";

const prereqs: EvidencePrereqs | undefined = (() => {
  if (!remoteExitEvidenceRequested) return undefined;
  const iface = discoverPrivateInterface();
  if (iface === undefined) return undefined;
  const certDir = mkdtempSync(join(tmpdir(), "octant-564-certs-"));
  const certs = generateCaAndServerCert(certDir, iface.address);
  if (certs === undefined) return undefined;
  const chromium = findChromium();
  if (chromium === undefined) return undefined;
  const bun = findBun();
  if (bun === undefined) return undefined;
  const security = findSecurity();
  if (security === undefined) return undefined;
  return { ...iface, sourceClass: iface.class, ...certs, chromium, bun, security };
})();

const prereqsSkipReason =
  prereqs === undefined
    ? "no private/Tailscale interface, openssl, Chromium executable, bun, or macOS security trust-store tool is available in this environment"
    : undefined;

interface TrustedCaKeychain {
  readonly close: () => void;
}

function parseKeychainPaths(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^\"(.*)\"$/, "$1"))
    .filter((line) => line.length > 0);
}

/**
 * Install the disposable CA in a temporary macOS keychain and make that
 * keychain part of Chrome's platform trust search list. This is real CA
 * validation; the browser contexts never use ignoreHTTPSErrors.
 */
function installTrustedCa(caCertPath: string, security: string): TrustedCaKeychain {
  const keychainDirectory = mkdtempSync(join(tmpdir(), "octant-564-ca-trust-"));
  const keychainPath = join(keychainDirectory, "evidence-ca.keychain-db");
  const password = randomUUID();
  const previousKeychains = parseKeychainPaths(
    execFileSync(security, ["list-keychains", "-d", "user"], { encoding: "utf8" }),
  );
  let created = false;
  try {
    execFileSync(security, ["create-keychain", "-p", password, keychainPath], { stdio: "pipe" });
    created = true;
    execFileSync(security, ["set-keychain-settings", "-lut", "3600", keychainPath], {
      stdio: "pipe",
    });
    execFileSync(security, ["unlock-keychain", "-p", password, keychainPath], { stdio: "pipe" });
    execFileSync(
      security,
      ["add-trusted-cert", "-r", "trustRoot", "-k", keychainPath, caCertPath],
      {
        stdio: "pipe",
        timeout: 30_000,
      },
    );
    execFileSync(
      security,
      ["list-keychains", "-d", "user", "-s", keychainPath, ...previousKeychains],
      {
        stdio: "pipe",
      },
    );
  } catch (error) {
    if (created) execFileSync(security, ["delete-keychain", keychainPath], { stdio: "ignore" });
    throw new Error(`Could not install the disposable CA trust root: ${describeError(error)}`);
  }

  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      try {
        execFileSync(security, ["list-keychains", "-d", "user", "-s", ...previousKeychains], {
          stdio: "pipe",
        });
      } finally {
        execFileSync(security, ["delete-keychain", keychainPath], { stdio: "ignore" });
      }
    },
  };
}

// ─── Store / signing / gateway scaffolding ─────────────────────────────

interface DisposableStore {
  readonly directory: string;
  readonly connection: SqliteConnection;
  readonly journal: Journal;
}

function setupStore(directory: string): DisposableStore {
  const connection = openSqlite(join(directory, "store.sqlite3"));
  const clock = () => new Date().toISOString();
  applyMigrations(connection, MIGRATIONS, clock);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  journal.append({
    aggregate: { aggregateType: "remote-host", aggregateId: hostId },
    expectedVersion: 0,
    events: [
      {
        eventId: "55555555-5555-4555-8555-555555555555",
        eventName: "remote.host-identity-initialized@1",
        eventVersion: 1,
        correlationId: "44444444-4444-4444-8444-444444444444",
        actor: { kind: "system", actorId: "33333333-3333-4333-8333-333333333333" },
        occurredAt: clock(),
        payload: {
          hostId,
          displayName: "This Mac",
          hostKeyFingerprint: "a".repeat(64),
          keyGeneration: 1,
          createdAt: clock(),
        },
      },
    ],
  });
  return { directory, connection, journal };
}

function makeSigning() {
  const hostKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const hostPublicDer = hostKeys.publicKey.export({ format: "der", type: "spki" });
  return {
    hostKeyFingerprint: createHash("sha256").update(hostPublicDer).digest("hex"),
    signHostPayload: (payload: string) =>
      cryptoSign("sha256", Buffer.from(payload, "utf8"), {
        key: hostKeys.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
  };
}

function makeConfig(
  address: string,
  port: number,
  certs: { cert: string; key: string },
): RemoteGatewayConfig {
  return {
    listener: {
      hostname: address,
      port,
      origin: `https://${address}:${port}`,
      tls: { cert: certs.cert, key: certs.key },
      // Disposable-host seam: the full matrix performs many pairing/auth
      // operations within one 60s window from one source address, which
      // exceeds the production defaults. The product defaults are unchanged;
      // this host is a disposable test fixture.
      admissionLimits: {
        pairingPerSourcePerMinute: 200,
        pairingPerHostPerMinute: 600,
        authPerSourcePerMinute: 200,
        authPerDevicePerMinute: 120,
        productConcurrentPerDevice: 8,
        productConcurrentPerListener: 32,
        productStateChangingPerDevicePerMinute: 300,
      },
    },
  };
}

function createGatewayAndCaptureLifecycle(options: Parameters<typeof createRemoteGateway>[0]): {
  gateway: RemoteGateway;
  lifecycle: PairingDeviceLifecycleService;
} {
  const before = capturedLifecycles.length;
  const gateway = createRemoteGateway(options);
  const lifecycle = capturedLifecycles[capturedLifecycles.length - 1];
  if (lifecycle === undefined || capturedLifecycles.length === before) {
    throw new Error("Gateway did not construct a PairingDeviceLifecycleService.");
  }
  return { gateway, lifecycle };
}

// ─── Evidence product-dispatch fixture ─────────────────────────────────
//
// The real gateway verifies session, device proof, CSRF, origin, and command
// identity BEFORE this dispatch runs (remoteHttpAuthentication). The fixture
// then serves the mode-valid surface data and records durable command
// receipts through the real journal/projection, plus evidence-only
// endpoints: an ambiguous-mutation endpoint that holds the response until
// registry cancellation, a bounded command-result lookup, and a slow NDJSON
// stream that observes the combined abort signal.

interface EvidenceFixture {
  readonly dispatch: RemoteProductDispatch;
  readonly lastMutationCommandId: () => string | undefined;
  readonly heldMutationCount: () => number;
  readonly mutationAbortedCount: () => number;
  readonly streamStartedCount: () => number;
  readonly streamAbortedCount: () => number;
}

function createEvidenceFixture(options: {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly hostId: StableHostId;
}): EvidenceFixture {
  const state = {
    lastMutationCommandId: undefined as string | undefined,
    heldMutations: 0,
    mutationAborted: 0,
    streamStarted: 0,
    streamAborted: 0,
  };
  const nowIso = () => new Date().toISOString();

  const journalReceipt = (input: {
    commandId: string;
    operationKind: string;
    operationDigest: string;
    deviceId?: string;
  }): void => {
    const head = options.connection
      .prepare(
        "SELECT aggregate_version AS v FROM aggregate_heads WHERE aggregate_type = 'remote-host' AND aggregate_id = ?",
      )
      .get(options.hostId) as { v: number } | undefined;
    const occurredAt = nowIso();
    options.journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: options.hostId },
      expectedVersion: head?.v ?? 0,
      events: [
        {
          eventId: randomUUID(),
          eventName: REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded,
          eventVersion: 1,
          correlationId: randomUUID(),
          actor: { kind: "system", actorId: randomUUID() },
          occurredAt,
          payload: {
            commandId: input.commandId,
            hostId: options.hostId,
            ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
            operationKind: input.operationKind,
            operationDigest: input.operationDigest,
            resultCategory: "applied",
            createdAt: occurredAt,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        },
      ],
    });
  };

  const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

  const dispatch: RemoteProductDispatch = async (handoff: RemoteClientPrincipalHandoff) => {
    const request = handoff.request;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const deviceId =
      handoff.principal.kind === "remote-device" ? handoff.principal.deviceId : undefined;
    const commandId = handoff.requestFacts.commandId;
    // The auth layer already consumed the request body to verify the digest;
    // the canonical body digest is authoritative for the receipt operation.
    const operationDigest = handoff.requestFacts.bodyDigest;

    // Bounded command-result lookup (durable via the receipt projection).
    if (method === "GET" && path.startsWith("/api/chat/evidence/commands/")) {
      const lookupId = decodeURIComponent(path.slice("/api/chat/evidence/commands/".length));
      const row = readRemoteCommandReceipt(options.connection, lookupId);
      if (row === undefined) return json({ kind: "not-found", commandId: lookupId });
      const resultCategory = String(row.result_category);
      const operationKind = String(row.operation_kind);
      const createdAt = String(row.created_at);
      const expiresAt = String(row.expires_at);
      if (resultCategory === "applied") {
        return json({
          kind: "applied",
          commandId: lookupId,
          operationKind,
          occurredAt: createdAt,
          expiresAt,
        });
      }
      if (resultCategory === "pending") {
        return json({ kind: "pending", commandId: lookupId, operationKind, createdAt, expiresAt });
      }
      return json({
        kind: "failed",
        commandId: lookupId,
        operationKind,
        reasonCode: resultCategory,
        occurredAt: createdAt,
        expiresAt,
      });
    }

    // Slow NDJSON stream that observes the combined abort signal.
    if (method === "GET" && path === "/api/chat/evidence/stream") {
      state.streamStarted += 1;
      const encoder = new TextEncoder();
      let frame = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let timer: ReturnType<typeof setTimeout>;
          const stop = (reason: string) => {
            clearTimeout(timer);
            state.streamAborted += 1;
            controller.error(new Error(reason));
          };
          timer = setTimeout(function tick() {
            if (handoff.abortSignal?.aborted === true) {
              stop("stream canceled by registry");
              return;
            }
            controller.enqueue(encoder.encode(`{"frame":${frame++}}\n`));
            timer = setTimeout(tick, 75);
          }, 0);
          handoff.abortSignal?.addEventListener(
            "abort",
            () => stop("stream canceled by registry"),
            {
              once: true,
            },
          );
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    }

    // Ambiguous mutation: records a durable receipt, then holds the response
    // until registry cancellation (listener disable / gateway stop) aborts it.
    if (method === "POST" && path === "/api/chat/evidence/mutation") {
      if (commandId === undefined) return json({ category: "invalid" }, 400);
      state.lastMutationCommandId = commandId;
      state.heldMutations += 1;
      journalReceipt({
        commandId,
        operationKind: "evidence-mutation",
        operationDigest,
        ...(deviceId === undefined ? {} : { deviceId }),
      });
      const { promise, resolve } = Promise.withResolvers<Response>();
      handoff.abortSignal?.addEventListener(
        "abort",
        () => {
          state.mutationAborted += 1;
          resolve(json({ kind: "aborted", commandId }, 503));
        },
        { once: true },
      );
      return promise;
    }

    // Mode-valid product surfaces (reads + one strict mutation each).
    if (method === "GET" && path === "/api/chat/bootstrap") {
      return json({
        settings: {
          defaultResearchEnabled: false,
          defaultResearchRouting: "automatic",
          defaultPersonalityInstructions: "Be concise.",
          version: 1,
          updatedAt: nowIso(),
        },
        threads: [],
      });
    }
    if (method === "POST" && path === "/api/chat/commands") {
      if (commandId === undefined) return json({ category: "invalid" }, 400);
      journalReceipt({
        commandId,
        operationKind: "chat-settings-update",
        operationDigest,
        ...(deviceId === undefined ? {} : { deviceId }),
      });
      return json({ ok: true });
    }
    if (method === "GET" && path === "/api/work/threads/bootstrap") {
      return json({
        threads: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            projectId: "30000000-0000-4000-8000-000000000001",
            title: "Remote Work",
            lifecycle: "active",
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            version: 1,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        ],
      });
    }
    if (method === "POST" && path === "/api/work/threads/commands") {
      if (commandId === undefined) return json({ category: "invalid" }, 400);
      journalReceipt({
        commandId,
        operationKind: "work-thread-rename",
        operationDigest,
        ...(deviceId === undefined ? {} : { deviceId }),
      });
      return json({ ok: true });
    }
    if (method === "GET" && path === "/api/code/bootstrap") {
      return json({
        settings: {
          defaultExecutionPolicy: "plan",
          defaultPermissionPersistence: "current-session",
          version: 1,
          updatedAt: nowIso(),
        },
        threads: [],
        checkouts: [],
        activity: [],
      });
    }
    if (method === "POST" && path === "/api/code/commands") {
      if (commandId === undefined) return json({ category: "invalid" }, 400);
      journalReceipt({
        commandId,
        operationKind: "code-settings-update",
        operationDigest,
        ...(deviceId === undefined ? {} : { deviceId }),
      });
      return json({ ok: true });
    }
    if (method === "GET" && path === "/api/providers/bootstrap") {
      return json({ providers: [] });
    }
    if (method === "GET" && path === "/api/agent-profiles") {
      return json({ profiles: [] });
    }
    return undefined;
  };

  return {
    dispatch,
    lastMutationCommandId: () => state.lastMutationCommandId,
    heldMutationCount: () => state.heldMutations,
    mutationAbortedCount: () => state.mutationAborted,
    streamStartedCount: () => state.streamStarted,
    streamAbortedCount: () => state.streamAborted,
  };
}

// ─── Redaction helpers ─────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redactEndpoint(address: string, port: number): string {
  return `https://[redacted-private-ip]:${port}`;
}

// ─── Evidence rows ─────────────────────────────────────────────────────

interface EvidenceRow {
  readonly id: string;
  readonly head: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail?: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 400);
  return String(error).slice(0, 400);
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

// ─── Matrix ────────────────────────────────────────────────────────────

describe("Remote exit evidence A — disposable-host two-browser matrix", () => {
  if (!remoteExitEvidenceRequested) {
    it.skip("runs only through the dedicated remote:exit-evidence-a command", () => {});
    return;
  }
  if (prereqs === undefined) {
    // The harness installs a disposable CA into a temporary macOS keychain via
    // `security`; Linux CI cannot satisfy that trust-store prerequisite. Fail
    // closed on macOS when any prerequisite is missing so the dedicated
    // `remote:exit-evidence-a` script never silently passes without evidence.
    if (process.platform === "darwin") {
      it("requires the disposable-host evidence prerequisites", () => {
        throw new Error(`Cannot run the remote exit evidence matrix: ${prereqsSkipReason}`);
      });
    } else {
      it.skip(`requires macOS security trust-store (skipped on ${process.platform}: ${prereqsSkipReason})`, () => {});
    }
    return;
  }
  const prereq = prereqs;

  it("pairs two isolated browser profiles, exercises the pair/use/reconnect/recovery matrix, and emits a redacted evidence table", async () => {
    const { chromium } = await import("playwright-core");

    // ── Disposable host ────────────────────────────────────────────────
    const storeDir = mkdtempSync(join(tmpdir(), "octant-564-store-"));
    const evidenceDir = join(EVIDENCE_ROOT, new Date().toISOString().replaceAll(":", "-"));
    mkdirSync(evidenceDir, { recursive: true });
    const { connection, journal } = setupStore(storeDir);
    const signing = makeSigning();
    const port = 20000 + Math.floor(Math.random() * 40000);
    const origin = `https://${prereq.address}:${port}`;
    const fixture = createEvidenceFixture({ connection, journal, hostId });

    // Bundle the browser driver once for the disposable host.
    const driverBundlePath = join(evidenceDir, "driver.js");
    execSync(
      `bun build "${join(serverDir, "src/remote/remoteExitEvidenceADriver.ts")}" --target=browser --outfile="${driverBundlePath}"`,
      { cwd: serverDir, stdio: "pipe" },
    );
    const driverBundle = readFileSync(driverBundlePath, "utf8");
    const html = [
      "<!doctype html>",
      '<html><head><meta charset="utf-8"><title>Octant remote exit evidence A</title></head>',
      '<body><main><h1>Remote exit evidence A</h1><p id="status">driver loaded</p></main>',
      '<script type="module" src="/driver.js"></script>',
      "</body></html>",
    ].join("");
    const webAssets: (request: Request) => Promise<Response | undefined> = async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/" || pathname === "/remote-exit-evidence-a.html") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/driver.js") {
        return new Response(driverBundle, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      return undefined;
    };

    const { gateway, lifecycle } = createGatewayAndCaptureLifecycle({
      connection,
      journal,
      hostId,
      displayName: "This Mac",
      serverBuildVersion: "0.1.0",
      signing,
      webAssets,
      serve: nodeServe,
      productDispatch: fixture.dispatch,
      config: makeConfig(prereq.address, port, {
        cert: prereq.serverCert,
        key: prereq.serverKey,
      }),
    });

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let browserTrust: TrustedCaKeychain | undefined;
    const rows: EvidenceRow[] = [];
    const recordRow = async (id: string, head: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
        rows.push({ id, head, status: "pass" });
      } catch (error) {
        rows.push({ id, head, status: "fail", detail: describeError(error) });
      }
    };
    const skipRow = (id: string, head: string, reason: string): void => {
      rows.push({ id, head, status: "skip", detail: reason });
    };

    const host = {
      async ticket(): Promise<{ ticketId: string; ticketProof: string }> {
        const created = lifecycle.createTicket({ sourceClass: prereq.sourceClass });
        return { ticketId: created.ticketId, ticketProof: created.ticketProof };
      },
      async approve(ticketId: string): Promise<{ deviceId: string; credentialGeneration: number }> {
        const approved = lifecycle.approveTicket({ ticketId });
        return {
          deviceId: approved.device.deviceId,
          credentialGeneration: approved.device.credentialGeneration,
        };
      },
      deviceIdForLabel(label: string): string | undefined {
        const devices = lifecycle
          .listDevices()
          .filter((candidate) => candidate.deviceLabel === label);
        // Prefer the newest active registration (re-pairs append newer rows).
        return (
          [...devices].reverse().find((candidate) => candidate.state === "active") ?? devices[0]
        )?.deviceId;
      },
      admin() {
        const control = gateway.localDeviceAdministration();
        if (control === undefined) throw new Error("Local device administration is unavailable.");
        return control;
      },
    };

    try {
      await gateway.start();
      expect(gateway.facts().state).toBe("ready");

      browserTrust = installTrustedCa(prereq.caCertPath, prereq.security);
      browser = await chromium.launch({
        executablePath: prereq.chromium,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
      });
      const runningBrowser = browser;
      const contextA = await runningBrowser.newContext();
      const contextB = await runningBrowser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      pageA.setDefaultTimeout(30_000);
      pageB.setDefaultTimeout(30_000);

      // ── E1: pair (hello → ticket → claim), profile A ─────────────────
      await recordRow(
        "E1",
        "pair: host hello, pairing ticket claim by isolated browser profile A",
        async () => {
          const ticket = await host.ticket();
          await pageA.goto(
            `${origin}/remote-exit-evidence-a.html#ticketId=${ticket.ticketId}&ticketProof=${ticket.ticketProof}`,
            {
              waitUntil: "domcontentloaded",
            },
          );
          const init = await pageA.evaluate(() => globalThis.__evidenceA.init());
          expect(init.ok).toBe(true);
          expect(init.hadFragment).toBe(true);
          expect(init.fragmentCleared).toBe(true);
          expect(init.deviceKeyStorage).toBe("indexeddb");
          expect(init.originDigest).toBe(sha256Hex(origin));

          const hello = await pageA.evaluate(() => globalThis.__evidenceA.hello());
          expect(hello.productId).toBe("octant");
          expect(hello.hostIdDigest).toBe(sha256Hex(hostId));
          expect(hello.displayName).toBe("This Mac");
          expect(hello.originDigest).toBe(sha256Hex(origin));

          const claim = await pageA.evaluate(
            ({ ticketId, ticketProof }) =>
              globalThis.__evidenceA.pair({
                ticketId,
                ticketProof,
                deviceLabel: "Profile-A-Safari",
              }),
            { ticketId: ticket.ticketId, ticketProof: ticket.ticketProof },
          );
          expect(claim.status).toBe("claimed");
          expect(claim.deviceLabel).toBe("Profile-A-Safari");
          expect(claim.hostIdDigest).toBe(sha256Hex(hostId));
          expect(claim.sourceClass).toBe(prereq.sourceClass);

          const pending = lifecycle.listPendingClaims();
          expect(pending.length).toBe(1);
          expect(pending[0]?.deviceLabel).toBe("Profile-A-Safari");
          expect(pending[0]?.origin).toBe(origin);
          expect(pending[0]?.sourceClass).toBe(prereq.sourceClass);
          expect(pending[0]?.comparisonCode).toMatch(/^\d{6}$/);
          expect(JSON.stringify(pending[0])).not.toContain(ticket.ticketProof);
        },
      );

      // ── E2: approve (local-host action) ───────────────────────────────
      await recordRow(
        "E2",
        "approve: pending claim approved by the local host; client observes approval",
        async () => {
          const pendingBefore = lifecycle.listPendingClaims();
          const ticketId = pendingBefore[0]?.ticketId;
          expect(ticketId).toBeDefined();

          const firstPoll = await pageA.evaluate(() => globalThis.__evidenceA.pollApproval());
          expect(firstPoll.status).toBe("pending");

          const approved = await host.approve(ticketId!);
          const secondPoll = await pageA.evaluate(() => globalThis.__evidenceA.pollApproval());
          expect(secondPoll.status).toBe("approved");
          if (secondPoll.status === "approved") {
            expect(secondPoll.deviceIdDigest).toBe(sha256Hex(approved.deviceId));
            expect(secondPoll.credentialGeneration).toBe(1);
          }

          const inventory = lifecycle.listDevices();
          expect(
            inventory.some(
              (device) => device.deviceLabel === "Profile-A-Safari" && device.state === "active",
            ),
          ).toBe(true);
        },
      );

      // ── E3: authenticate (challenge → negotiate → session) ───────────
      await recordRow(
        "E3",
        "authenticate: device-key challenge, protocol negotiation, session issuance",
        async () => {
          const state = await pageA.evaluate(() => globalThis.__evidenceA.connect());
          expect(state.kind).toBe("ready");
          const sessionRow = connection
            .prepare("SELECT state FROM remote_session_store WHERE device_id = ?")
            .get(host.deviceIdForLabel("Profile-A-Safari") ?? "") as { state: string } | undefined;
          expect(sessionRow?.state).toBe("active");
        },
      );

      // ── E4-E6: mode-valid surfaces ────────────────────────────────────
      await recordRow("E4", "chat: mode-valid surface read + one strict mutation", async () => {
        const surface = await pageA.evaluate(() => globalThis.__evidenceA.runChatSurface());
        expect(surface.ok).toBe(true);
        const mutation = await pageA.evaluate(() => globalThis.__evidenceA.runChatMutation());
        expect(mutation.ok).toBe(true);
        const receipts = connection
          .prepare(
            "SELECT COUNT(*) AS count FROM remote_command_receipt_projection WHERE operation_kind = 'chat-settings-update'",
          )
          .get() as { count: number };
        expect(receipts.count).toBe(1);
      });

      await recordRow("E5", "work: mode-valid surface read + one strict mutation", async () => {
        const surface = await pageA.evaluate(() => globalThis.__evidenceA.runWorkSurface());
        expect(surface.ok).toBe(true);
        const mutation = await pageA.evaluate(() => globalThis.__evidenceA.runWorkMutation());
        expect(mutation.ok).toBe(true);
        const receipts = connection
          .prepare(
            "SELECT COUNT(*) AS count FROM remote_command_receipt_projection WHERE operation_kind = 'work-thread-rename'",
          )
          .get() as { count: number };
        expect(receipts.count).toBe(1);
      });

      await recordRow("E6", "code: mode-valid surface read + one strict mutation", async () => {
        const surface = await pageA.evaluate(() => globalThis.__evidenceA.runCodeSurface());
        expect(surface.ok).toBe(true);
        const mutation = await pageA.evaluate(() => globalThis.__evidenceA.runCodeMutation());
        expect(mutation.ok).toBe(true);
        const receipts = connection
          .prepare(
            "SELECT COUNT(*) AS count FROM remote_command_receipt_projection WHERE operation_kind = 'code-settings-update'",
          )
          .get() as { count: number };
        expect(receipts.count).toBe(1);
      });

      // ── E7: disconnect mid-stream → stale read-only + fail-closed ──────
      await recordRow(
        "E7",
        "disconnect: read-only presentation; mutations fail closed",
        async () => {
          // The bridge maps an intentional disconnect to idle (the stale
          // read-only state is what a network-loss connection reports);
          // either way mutations must fail closed immediately.
          const state = await pageA.evaluate(() => globalThis.__evidenceA.disconnect());
          expect(state.kind).toBe("idle");
          const mutation = await pageA.evaluate(() => globalThis.__evidenceA.runChatMutation());
          expect(mutation).toEqual({ ok: false, category: "offline" });
          const provider = await pageA.evaluate(() => globalThis.__evidenceA.runProviderSurface());
          expect(provider).toEqual({ ok: false, category: "offline" });
        },
      );

      // ── E8: reconnect + snapshot/replay without duplication ──────────
      await recordRow(
        "E8",
        "reconnect: fresh session, snapshot, replay without duplication",
        async () => {
          const receiptCountBefore = (
            connection
              .prepare("SELECT COUNT(*) AS count FROM remote_command_receipt_projection")
              .get() as { count: number }
          ).count;
          // After an intentional disconnect the bridge drops the active
          // connection; re-establishing uses the stored pairing approval
          // (the real client path), not reconnect() which requires a live
          // connection object.
          const state = await pageA.evaluate(() => globalThis.__evidenceA.connect());
          expect(state.kind).toBe("ready");
          const snapshot = await pageA.evaluate(() => globalThis.__evidenceA.runChatSurface());
          expect(snapshot.ok).toBe(true);

          const receiptCountAfter = (
            connection
              .prepare("SELECT COUNT(*) AS count FROM remote_command_receipt_projection")
              .get() as { count: number }
          ).count;
          expect(receiptCountAfter).toBe(receiptCountBefore);

          // Journal replay from sequence 0: every command-receipt event appears exactly once.
          // The branded GlobalSequence cursor accepts plain numbers (repo precedent: `as never`).
          const replay = journal.replay({ afterSequence: 0, limit: 1000 } as never);
          const receiptEvents = replay.filter(
            (event) => event.eventName === REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded,
          );
          expect(receiptEvents.length).toBe(receiptCountAfter);
        },
      );

      // ── E9: ambiguous mutation → durable receipt lookup ──────────────
      await recordRow(
        "E9",
        "ambiguous mutation: accepted, response lost on host stop; lookup by command ID resolves it",
        async () => {
          await pageA.evaluate(() => globalThis.__evidenceA.beginEvidenceMutation());
          await waitUntil(
            () => fixture.lastMutationCommandId() !== undefined,
            10_000,
            "mutation receipt recorded",
          );
          const commandId = fixture.lastMutationCommandId()!;

          await gateway.stop();
          expect(gateway.facts().admissionClosed).toBe(true);
          expect(fixture.mutationAbortedCount()).toBeGreaterThanOrEqual(1);

          const outcome = await pageA.evaluate(() =>
            globalThis.__evidenceA.finishEvidenceMutation(),
          );
          expect(outcome.status).toBe("ambiguous");

          await gateway.start();
          expect(gateway.facts().state).toBe("ready");

          const state = await pageA.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(state.kind).toBe("ready");

          const lookup = await pageA.evaluate(
            (id) => globalThis.__evidenceA.lookupReceipt(id),
            commandId,
          );
          expect(lookup.kind).toBe("applied");
          if (lookup.kind !== "applied") {
            throw new Error(`Receipt lookup did not resolve as applied: ${JSON.stringify(lookup)}`);
          }
          expect(lookup.commandIdDigest).toBe(sha256Hex(commandId));

          // Durable receipt survives the restart; exactly one row.
          const receipt = readRemoteCommandReceipt(connection, commandId);
          expect(String(receipt?.result_category)).toBe("applied");
          const duplicates = connection
            .prepare(
              "SELECT COUNT(*) AS count FROM remote_command_receipt_projection WHERE command_id = ?",
            )
            .get(commandId) as { count: number };
          expect(duplicates.count).toBe(1);
        },
      );

      // ── E10: host restart mid-session → reauthenticate + replay ──────
      await recordRow(
        "E10",
        "restart: sessions invalidated; durable device key reauthenticates; replay intact",
        async () => {
          const state = await pageA.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(state.kind).toBe("ready");

          await gateway.stop();
          await gateway.start();

          // The previous session is invalidated: a request with the old session fails 401.
          const staleStatus = await pageA.evaluate(() =>
            globalThis.__evidenceA.probeSurfaceStatus(),
          );
          expect(staleStatus.status).toBe(401);

          const reconnected = await pageA.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(reconnected.kind).toBe("ready");
          const surface = await pageA.evaluate(() => globalThis.__evidenceA.runCodeSurface());
          expect(surface.ok).toBe(true);

          const revokedSessions = connection
            .prepare("SELECT COUNT(*) AS count FROM remote_session_store WHERE state = 'revoked'")
            .get() as { count: number };
          expect(revokedSessions.count).toBeGreaterThanOrEqual(1);
        },
      );

      // ── E11: device key rotation (profile B) ─────────────────────────
      let deviceIdB: string | undefined;
      await recordRow(
        "E11",
        "rotation: self-rotate device key; old key cannot reauthenticate; re-pair recovers",
        async () => {
          const ticket = await host.ticket();
          await pageB.goto(
            `${origin}/remote-exit-evidence-a.html#ticketId=${ticket.ticketId}&ticketProof=${ticket.ticketProof}`,
            {
              waitUntil: "domcontentloaded",
            },
          );
          const initB = await pageB.evaluate(() => globalThis.__evidenceA.init());
          expect(initB.ok).toBe(true);
          await pageB.evaluate(
            ({ ticketId, ticketProof }) =>
              globalThis.__evidenceA.pair({
                ticketId,
                ticketProof,
                deviceLabel: "Profile-B-Chrome",
              }),
            { ticketId: ticket.ticketId, ticketProof: ticket.ticketProof },
          );
          const approvedB = await host.approve(ticket.ticketId);
          const pollB = await pageB.evaluate(() => globalThis.__evidenceA.pollApproval());
          expect(pollB.status).toBe("approved");
          const connectedB = await pageB.evaluate(() => globalThis.__evidenceA.connect());
          expect(connectedB.kind).toBe("ready");

          const fingerprintBefore = lifecycle
            .listDevices()
            .find((device) => device.deviceId === approvedB.deviceId)?.deviceKeyFingerprint;

          const rotated = await pageB.evaluate(() => globalThis.__evidenceA.rotateDeviceKey());
          expect(rotated.ok).toBe(true);

          const deviceAfter = lifecycle
            .listDevices()
            .find((device) => device.deviceId === approvedB.deviceId);
          expect(deviceAfter?.credentialGeneration).toBe(2);
          expect(deviceAfter?.deviceKeyFingerprint).not.toBe(fingerprintBefore);

          const oldKeyReconnect = await pageB.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(oldKeyReconnect.kind).toBe("unauthorized");

          // Recovery: re-pair with a fresh ticket and new key.
          const recoveryTicket = await host.ticket();
          await pageB.evaluate(
            ({ ticketId, ticketProof }) =>
              globalThis.__evidenceA.pair({
                ticketId,
                ticketProof,
                deviceLabel: "Profile-B-Chrome",
              }),
            { ticketId: recoveryTicket.ticketId, ticketProof: recoveryTicket.ticketProof },
          );
          const approvedRecovery = await host.approve(recoveryTicket.ticketId);
          const pollRecovery = await pageB.evaluate(() => globalThis.__evidenceA.pollApproval());
          expect(pollRecovery.status).toBe("approved");
          // The recovery registration is the device profile B authenticates
          // with from now on; capture its id so E12 revokes the right one.
          deviceIdB = approvedRecovery.deviceId;
          const recovered = await pageB.evaluate(() => globalThis.__evidenceA.connect());
          expect(recovered.kind).toBe("ready");
        },
      );

      // ── E12: revoke active device (profile B) ────────────────────────
      await recordRow(
        "E12",
        "revoke: host revokes the active device; streams/sessions stop; reconnect requires re-pair",
        async () => {
          expect(deviceIdB).toBeDefined();
          const receipt = host.admin().revokeDevice({ deviceId: deviceIdB! });
          expect(receipt.result).toBe("applied");

          const state = await pageB.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(state.kind).toBe("unauthorized");

          const revokedSessions = connection
            .prepare(
              "SELECT COUNT(*) AS count FROM remote_session_store WHERE device_id = ? AND state = 'revoked'",
            )
            .get(deviceIdB!) as { count: number };
          expect(revokedSessions.count).toBeGreaterThanOrEqual(1);
        },
      );

      // ── E13: listener disable → in-flight stream canceled server-side ─
      await recordRow(
        "E13",
        "listener disable: admission closes; in-flight stream aborts; reconnect unavailable",
        async () => {
          const streamOutcomePromise = pageA.evaluate(() =>
            globalThis.__evidenceA.readStreamToEnd(),
          );
          await waitUntil(() => fixture.streamStartedCount() >= 1, 10_000, "stream started");

          await gateway.stop();
          expect(gateway.facts().admissionClosed).toBe(true);

          const streamOutcome = await streamOutcomePromise;
          expect(streamOutcome.status).toBe("aborted");
          expect(fixture.streamAbortedCount()).toBeGreaterThanOrEqual(1);

          const state = await pageA.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(state.kind).toBe("unavailable");

          await gateway.start();
        },
      );

      // ── E14: device expiry (reconcile) → re-pair recovery ────────────
      // ── E14: device expiry (reconcile) → re-pair recovery ────────────
      let deviceIdA: string | undefined;
      await recordRow(
        "E14",
        "expire: device credential expiry enforced; re-pair recovers",
        async () => {
          // E13's reconnect against the disabled listener failed closed and
          // cleared the client's device identity (fail-closed product
          // behavior), so profile A re-pairs before this row's checks.
          const reentryTicket = await host.ticket();
          await pageA.evaluate(
            ({ ticketId, ticketProof }) =>
              globalThis.__evidenceA.pair({
                ticketId,
                ticketProof,
                deviceLabel: "Profile-A-Safari",
              }),
            { ticketId: reentryTicket.ticketId, ticketProof: reentryTicket.ticketProof },
          );
          const approvedReentry = await host.approve(reentryTicket.ticketId);
          deviceIdA = approvedReentry.deviceId;
          const reentryPoll = await pageA.evaluate(() => globalThis.__evidenceA.pollApproval());
          expect(reentryPoll.status).toBe("approved");
          const reentryState = await pageA.evaluate(() => globalThis.__evidenceA.connect());
          expect(reentryState.kind).toBe("ready");
          expect(deviceIdA).toBeDefined();

          // Time-shift the device expiry in the disposable store to avoid the
          // real 90-day/30-day policy TTL; enforcement below is the real path.
          connection
            .prepare("UPDATE remote_device_projection SET expires_at = ? WHERE device_id = ?")
            .run(new Date(Date.now() - 1_000).toISOString(), deviceIdA);
          host.admin().reconcileExpired();

          const expiredDevice = readDeviceRegistration(connection, deviceIdA);
          expect(String(expiredDevice?.state)).toBe("expired");

          const denied = await pageA.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(denied.kind).toBe("unauthorized");

          // Recovery: re-pair with a fresh ticket.
          const recoveryTicket = await host.ticket();
          await pageA.evaluate(
            ({ ticketId, ticketProof }) =>
              globalThis.__evidenceA.pair({
                ticketId,
                ticketProof,
                deviceLabel: "Profile-A-Safari",
              }),
            { ticketId: recoveryTicket.ticketId, ticketProof: recoveryTicket.ticketProof },
          );
          const approvedRecoveryA = await host.approve(recoveryTicket.ticketId);
          deviceIdA = approvedRecoveryA.deviceId;
          const poll = await pageA.evaluate(() => globalThis.__evidenceA.pollApproval());
          expect(poll.status).toBe("approved");
          const recovered = await pageA.evaluate(() => globalThis.__evidenceA.connect());
          expect(recovered.kind).toBe("ready");
        },
      );

      // ── E15: session expiry → next request rejected, reconnect renews ─
      await recordRow(
        "E15",
        "expire: session idle/absolute expiry enforced; reconnect renews the session",
        async () => {
          expect(deviceIdA).toBeDefined();
          // Time-shift the session expiry in the disposable store to avoid the
          // real 12-hour/15-minute policy TTL; the CHECK constraint requires
          // absolute_expires_at > issued_at, and enforcement below is real.
          connection
            .prepare(
              "UPDATE remote_session_store SET absolute_expires_at = issued_at + 1 WHERE device_id = ? AND state = 'active'",
            )
            .run(deviceIdA);

          const staleStatus = await pageA.evaluate(() =>
            globalThis.__evidenceA.probeSurfaceStatus(),
          );
          expect(staleStatus.status).toBe(401);

          const state = await pageA.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(state.kind).toBe("ready");
          const surface = await pageA.evaluate(() => globalThis.__evidenceA.runChatSurface());
          expect(surface.ok).toBe(true);
        },
      );

      // ── E16: browser storage cleared → re-pair required ──────────────
      await recordRow(
        "E16",
        "storage loss: cleared device storage cannot resume; fresh profile re-pair recovers",
        async () => {
          const cleared = await pageA.evaluate(() => globalThis.__evidenceA.clearStorage());
          expect(cleared.ok).toBe(true);
          const storage = await pageA.evaluate(() => globalThis.__evidenceA.storageState());
          expect(storage.deviceKeyRecords).toBe(0);

          // The client can no longer prove possession: reconnect must fail
          // closed and must NOT return to ready.
          const denied = await pageA.evaluate(() => globalThis.__evidenceA.reconnect());
          expect(denied.kind).not.toBe("ready");

          // Recovery happens on a fresh isolated profile (the honest
          // browser-equivalent of storage loss): pair, approve, ready.
          const recoveryTicket = await host.ticket();
          const contextC = await runningBrowser.newContext();
          const pageC = await contextC.newPage();
          try {
            await pageC.goto(
              `${origin}/remote-exit-evidence-a.html#ticketId=${recoveryTicket.ticketId}&ticketProof=${recoveryTicket.ticketProof}`,
              { waitUntil: "domcontentloaded" },
            );
            const initC = await pageC.evaluate(() => globalThis.__evidenceA.init());
            expect(initC.ok).toBe(true);
            await pageC.evaluate(
              ({ ticketId, ticketProof }) =>
                globalThis.__evidenceA.pair({
                  ticketId,
                  ticketProof,
                  deviceLabel: "Profile-C-Recovery",
                }),
              { ticketId: recoveryTicket.ticketId, ticketProof: recoveryTicket.ticketProof },
            );
            await host.approve(recoveryTicket.ticketId);
            const pollC = await pageC.evaluate(() => globalThis.__evidenceA.pollApproval());
            expect(pollC.status).toBe("approved");
            const recoveredC = await pageC.evaluate(() => globalThis.__evidenceA.connect());
            expect(recoveredC.kind).toBe("ready");
          } finally {
            await pageC.close();
            await contextC.close();
          }
        },
      );

      // ── S1/S2: named skips (reload/reboot rehydration not implemented) ──
      {
        // Probe current behavior (never a pass/fail gate): the device key
        // survives a page reload (IndexedDB is origin-scoped), but no
        // auto-rehydration exists — the client must be paired again. This
        // is the known credential-rehydration gap, recorded as a named skip.
        try {
          expect(gateway.facts().state).toBe("ready");
          await pageA.reload({ waitUntil: "domcontentloaded" });
          const initAfterReload = await pageA.evaluate(() => globalThis.__evidenceA.init());
          void initAfterReload;
          const storageAfterReload = await pageA.evaluate(() =>
            globalThis.__evidenceA.storageState(),
          );
          skipRow(
            "S1",
            "reload rehydration: page reload must rehydrate the device credential automatically",
            `SKIP (reload/reboot device-credential rehydration is not implemented yet). Probe: device key survives reload (records ${storageAfterReload.deviceKeyRecords}), but the client exposes no persisted session and requires a fresh pair; current behavior matches the known rehydration gap.`,
          );
        } catch (error) {
          skipRow(
            "S1",
            "reload rehydration: page reload must rehydrate the device credential automatically",
            `SKIP (device-credential rehydration not implemented). Probe could not run: ${describeError(error)}`,
          );
        }
      }
      skipRow(
        "S2",
        "reboot rehydration: reopening the browser profile must rehydrate the device credential",
        "SKIP (device-credential rehydration not implemented). Exact command on the maintainer's machine: launch Chromium with a persistent profile at the evidence page, pair, close Chromium, relaunch the same profile, and observe pairing entry required (no auto-reconnect). Requires persisted device credentials that resume across reload and reboot.",
      );

      // ── S3: Tailscale endpoint parity ────────────────────────────────
      skipRow(
        "S3",
        "Tailscale endpoint parity: same host/device identity over a browser-trusted Tailscale HTTPS endpoint",
        "SKIP (environment + origin-scoped credential model). Needs a browser-trusted `tailscale cert` for a tailnet host and persisted device-credential rehydration to migrate the origin-scoped device key. Exact commands: `tailscale cert <tailnet-host>`; serve the same gateway on the Tailscale interface; pair a fresh profile; verify no second host registry or Project copy. Node-level Tailscale identity stability is covered by remoteGateway.hostile.smoke.test.ts.",
      );

      // ── S4: packaged desktop approval panel ──────────────────────────
      skipRow(
        "S4",
        "packaged native approval: local-host approve/deny/revoke/listener controls from the packaged Electron app",
        "SKIP (native boundary — cannot run packaged Electron in this smoke). Exact commands on the maintainer's machine: `bun run desktop:start`, enable Remote Access, pair a browser, approve from the local device panel; verify the listener control and inventory. Covered partially by apps/desktop remoteDeviceControls tests.",
      );

      // ── S5: two-live-process rows ────────────────────────────────────
      skipRow(
        "S5",
        "two-live-process rows: a real second machine on the LAN and a live provider turn stream",
        "SKIP (genuinely two-live-process). Exact commands on the maintainer's machine: (1) run `bun run remote:exit-evidence-a` on the host, then from a second machine browse to the printed endpoint, pair, and repeat the matrix rows; (2) run a live Chat turn over the remote session with a configured provider and disconnect mid-stream. These rows need two live processes and are recorded as documented skips, not failures.",
      );

      // ── Evidence output ──────────────────────────────────────────────
      const screenshotA = join(evidenceDir, "profile-a-final.png");
      const screenshotB = join(evidenceDir, "profile-b-final.png");
      await pageA.screenshot({ path: screenshotA, fullPage: true });
      await pageB.screenshot({ path: screenshotB, fullPage: true });

      const table = rows.map((row) => ({
        id: row.id,
        status: row.status,
        head: row.head,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
      }));
      console.log(
        JSON.stringify(
          {
            matrix: "Remote exit evidence A — disposable-host two-browser matrix",
            endpoint: redactEndpoint(prereq.address, port),
            sourceClass: prereq.sourceClass,
            profiles: ["Profile-A-Safari", "Profile-B-Chrome"],
            evidenceDir,
            rows: table,
          },
          null,
          2,
        ),
      );

      const failures = rows.filter((row) => row.status === "fail");
      expect(failures).toEqual([]);
      expect(rows.some((row) => row.status === "pass")).toBe(true);
    } finally {
      await browser?.close();
      browserTrust?.close();
      await gateway.stop().catch(() => undefined);
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 600_000);
});
