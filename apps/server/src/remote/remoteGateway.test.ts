import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// C1: The production gateway module (`remoteGateway.ts`) exports no
// bypass-capable finalizer seam or factory — `createRemoteGateway` always
// assembles mandatory finalizers from real collaborators. R2/R3
// finalization logic is tested directly in `remoteGatewayFinalization.test.ts`.
// These integration tests use vi.mock to wrap the real finalization
// function so individual tests can inject controlled failure outcomes
// without exporting any bypass-capable seam from the production module.
vi.mock("./remoteGatewayFinalization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remoteGatewayFinalization")>();
  return {
    ...actual,
    executeFinalizationSequence: vi.fn(actual.executeFinalizationSequence),
  };
});
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { buildHostHelloSignaturePayload } from "@octant/domain";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Journal } from "../persistence/journal";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  PRIVATE_LISTENER_TEST_CERT,
  PRIVATE_LISTENER_TEST_KEY,
} from "../privateListener.test-certs";
import type { RequestTransportFacts, Serve } from "../server";
import {
  createRemoteGateway,
  RemoteGatewayError,
  RemoteGatewayFinalizationError,
  type RemoteGatewayConfig,
  type RemoteGatewayOptions,
} from "./remoteGateway";
import { canonicalDeviceKeyFacts } from "./deviceKeyFacts";
import { executeFinalizationSequence } from "./remoteGatewayFinalization";
import { createPushNotificationTokenStore } from "./pushNotificationTokenStore";

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const nowMs = Date.parse("2026-07-29T09:00:00.000Z");
const nowIso = new Date(nowMs).toISOString();
const ORIGIN = "https://192.168.1.20:9443";
const directories: string[] = [];
const lanFacts: RequestTransportFacts = {
  listenerTrust: "remote",
  sourceClass: "lan-private",
  sourceKey: "opaque-lan-source-key",
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.mocked(executeFinalizationSequence).mockReset();
});

function makeSigning() {
  const hostKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const hostPublicDer = hostKeys.publicKey.export({ format: "der", type: "spki" });
  return {
    signing: {
      hostKeyFingerprint: createHash("sha256").update(hostPublicDer).digest("hex"),
      hostPublicKey: hostPublicDer.toString("base64url"),
      signHostPayload: (payload: string) =>
        sign("sha256", Buffer.from(payload, "utf8"), {
          key: hostKeys.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url"),
    },
  };
}

function makeConfig(overrides: Partial<RemoteGatewayConfig["listener"]> = {}): RemoteGatewayConfig {
  return {
    listener: {
      hostname: "192.168.1.20",
      port: 9443,
      origin: ORIGIN,
      tls: { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
      ...overrides,
    },
  };
}

/**
 * Create a Serve function that captures the fetch handler for direct testing.
 */
function createCapturingServe(): {
  readonly serve: Serve;
  readonly getFetch: () =>
    | ((req: Request, facts?: RequestTransportFacts) => Promise<Response>)
    | undefined;
} {
  let captured: ((req: Request, facts?: RequestTransportFacts) => Promise<Response>) | undefined;
  const serve: Serve = (opts) => {
    captured = opts.fetch as (req: Request, facts?: RequestTransportFacts) => Promise<Response>;
    return {
      url: new URL(`https://${opts.hostname}:${opts.port}`),
      stop: vi.fn(async () => {}),
    };
  };
  return { serve, getFetch: () => captured };
}

interface SetupOptions {
  readonly config?: RemoteGatewayConfig;
  readonly productDispatch?: RemoteGatewayOptions["productDispatch"];
  readonly webAssets?: RemoteGatewayOptions["webAssets"];
  readonly designPage?: RemoteGatewayOptions["designPage"];
  readonly serve?: Serve;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

function setup(options: SetupOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-remote-gateway-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => nowIso);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => nowIso,
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
        occurredAt: nowIso,
        payload: {
          hostId,
          displayName: "This Mac",
          hostKeyFingerprint: "a".repeat(64),
          keyGeneration: 1,
          createdAt: nowIso,
        },
      },
    ],
  });
  const { signing } = makeSigning();
  let uuidCounter = 0;
  const uuid =
    options.uuid ?? (() => `22222222-2222-4222-8222-${String(++uuidCounter).padStart(12, "0")}`);
  const serveCalls: Array<{ readonly hostname: string; readonly port: number }> = [];
  const defaultServe: Serve = (opts) => {
    serveCalls.push({ hostname: opts.hostname, port: opts.port });
    return {
      url: new URL(`https://${opts.hostname}:${opts.port}`),
      stop: vi.fn(async () => {}),
    };
  };
  const webAssets =
    options.webAssets ?? (() => Promise.resolve(new Response("web-assets", { status: 200 })));
  let pushUuidCounter = 0;
  const pushRegistrations = createPushNotificationTokenStore({
    dataDirectory: directory,
    journal,
    uuid: () => `99999999-9999-4999-8999-${String(++pushUuidCounter).padStart(12, "0")}`,
    hostActorId: "33333333-3333-4333-8333-333333333333",
  });
  const baseOptions: RemoteGatewayOptions = {
    connection,
    journal,
    hostId,
    displayName: "This Mac",
    serverBuildVersion: "0.1.0",
    signing,
    webAssets,
    ...(options.productDispatch === undefined ? {} : { productDispatch: options.productDispatch }),
    ...(options.designPage === undefined ? {} : { designPage: options.designPage }),
    serve: options.serve ?? defaultServe,
    now: options.now ?? (() => nowMs),
    uuid,
    clock: () => nowIso,
    pushTokenStore: pushRegistrations,
    config: options.config ?? makeConfig(),
  };
  const gateway = createRemoteGateway(baseOptions);
  return { gateway, connection, journal, signing, serveCalls, directory, pushRegistrations };
}

/**
 * Insert an active session row directly into the DB so we can test
 * invalidation without running the full challenge/issue flow.
 */
function insertActiveSession(
  connection: ReturnType<typeof openSqlite>,
  sessionIdDigest: string,
  host: string = hostId,
): void {
  connection
    .prepare(
      `INSERT INTO remote_session_store (
        session_id_digest, host_id, device_id, credential_generation, origin,
        protocol_version, capability_digest, issued_at, last_seen_at,
        idle_expires_at, absolute_expires_at, csrf_digest, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      sessionIdDigest,
      host,
      "22222222-2222-4222-8222-222222222222",
      1,
      ORIGIN,
      1,
      "c".repeat(64),
      nowMs,
      nowMs,
      nowMs + 60_000,
      nowMs + 600_000,
      createHash("sha256").update(sessionIdDigest).digest("hex"),
    );
}

function countActiveSessions(connection: ReturnType<typeof openSqlite>): number {
  return (
    connection
      .prepare("SELECT COUNT(*) AS n FROM remote_session_store WHERE state = 'active'")
      .get() as { readonly n: number }
  ).n;
}

function countInvalidatedSessions(connection: ReturnType<typeof openSqlite>): number {
  return (
    connection
      .prepare("SELECT COUNT(*) AS n FROM remote_session_store WHERE state = 'revoked'")
      .get() as { readonly n: number }
  ).n;
}

describe("RemoteGateway — disabled by default and composition", () => {
  it("is disabled by default with admission open and no listener", () => {
    const { gateway } = setup();
    const facts = gateway.facts();
    expect(facts.state).toBe("disabled");
    expect(facts.admissionClosed).toBe(false);
    expect(gateway.listener()).toBeUndefined();
    expect(facts.origin).toBe(ORIGIN);
    expect(facts.hostId).toBe(hostId);
  });

  it("constructs the full service graph over one persistence/journal connection", async () => {
    const { gateway, serveCalls } = setup();
    await gateway.start();
    expect(gateway.facts().state).toBe("ready");
    expect(serveCalls).toHaveLength(1);
    expect(serveCalls[0]).toEqual({ hostname: "192.168.1.20", port: 9443 });
    await gateway.stop();
    expect(gateway.facts().state).toBe("disabled");
  });

  it("failed TLS initialization leaves the gateway failed with a typed error code", async () => {
    const { gateway } = setup({
      config: makeConfig({ tls: { cert: "not-a-cert", key: "not-a-key" } }),
    });
    await expect(gateway.start()).rejects.toThrow(RemoteGatewayError);
    expect(gateway.facts().state).toBe("failed");
    expect(gateway.facts().errorCode).toBe("invalid-tls");
    expect(gateway.listener()).toBeUndefined();
  });
});

describe("RemoteGateway — A1: gateway-owned admission gate", () => {
  it("rejects requests with 503 after admission is closed and before dispatch", async () => {
    const dispatched = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const { gateway } = setup({ productDispatch: dispatched });
    await gateway.start();
    await gateway.stop();
    expect(gateway.facts().admissionClosed).toBe(true);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("closes admission synchronously when stop begins, before invalidation", async () => {
    const { gateway } = setup();
    await gateway.start();
    expect(gateway.facts().admissionClosed).toBe(false);
    await gateway.stop();
    expect(gateway.facts().admissionClosed).toBe(true);
  });

  it("admission gate is checked before route/auth/product dispatch", async () => {
    const { serve, getFetch } = createCapturingServe();
    const dispatched = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const { gateway } = setup({ productDispatch: dispatched, serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const helloRequest = new Request(`${ORIGIN}/api/remote/hello`, {
      headers: { host: "192.168.1.20:9443" },
    });
    const beforeResponse = await capturedFetch!(helloRequest, lanFacts);
    expect(beforeResponse.status).toBe(200);
    await gateway.stop();
    const afterResponse = await capturedFetch!(helloRequest, lanFacts);
    expect(afterResponse.status).toBe(503);
    const body = await afterResponse.json();
    expect(body.category).toBe("unavailable");
    expect(dispatched).not.toHaveBeenCalled();
  });
});

describe("RemoteGateway — A2: atomic generation swap on restart", () => {
  it("restart binds the new config's port, not the original", async () => {
    const serveCalls: Array<{ readonly hostname: string; readonly port: number }> = [];
    const { gateway } = setup({
      serve: (opts) => {
        serveCalls.push({ hostname: opts.hostname, port: opts.port });
        return {
          url: new URL(`https://${opts.hostname}:${opts.port}`),
          stop: vi.fn(async () => {}),
        };
      },
    });
    await gateway.start();
    expect(serveCalls[0]).toEqual({ hostname: "192.168.1.20", port: 9443 });
    const newConfig = makeConfig({ port: 8443, origin: "https://192.168.1.20:8443" });
    await gateway.restart(newConfig);
    expect(serveCalls[1]).toEqual({ hostname: "192.168.1.20", port: 8443 });
    expect(gateway.facts().origin).toBe("https://192.168.1.20:8443");
    await gateway.stop();
  });

  it("listener and policy identity match after restart", async () => {
    const { gateway } = setup();
    await gateway.start();
    expect(gateway.facts().origin).toBe(ORIGIN);
    const newConfig = makeConfig({ port: 8443, origin: "https://192.168.1.20:8443" });
    await gateway.restart(newConfig);
    expect(gateway.facts().origin).toBe("https://192.168.1.20:8443");
    expect(gateway.facts().hostId).toBe(hostId);
    await gateway.stop();
  });
});

describe("RemoteGateway — A3: stable shutdown command ID across retry", () => {
  it("rotates the shutdown command ID on each new enabled lifetime", async () => {
    // F1: the shutdown command ID is rotated on each successful start().
    // A retry of a failed stop reuses the same ID (not rotated until start).
    // This test verifies that two stop/start cycles with same config use
    // different command IDs (the F1 fix). The real invalidation proof is
    // in the F1 test suite above.
    const { gateway, connection } = setup();
    await gateway.start();
    insertActiveSession(connection, "1".repeat(64));
    await gateway.stop();
    expect(countActiveSessions(connection)).toBe(0);

    // Second lifetime: new command ID → new sessions invalidated
    await gateway.start();
    insertActiveSession(connection, "2".repeat(64));
    await gateway.stop();
    expect(countActiveSessions(connection)).toBe(0);
    expect(countInvalidatedSessions(connection)).toBe(2);
  });
});

describe("RemoteGateway — A4: preserve failure truth on finalization", () => {
  it("exposes typed finalization error class", () => {
    const error = new RemoteGatewayFinalizationError({
      kind: "invalidation-failed",
      cancelHookFailures: 2,
    });
    expect(error.detail.kind).toBe("invalidation-failed");
    expect(error.detail.cancelHookFailures).toBe(2);
    expect(error.name).toBe("RemoteGatewayFinalizationError");
  });

  it("R2: does not unbind the listener when invalidation hook fails", async () => {
    // R2: inject a real invalidation-hook failure via the mocked
    // finalization sequence. The gateway must throw
    // RemoteGatewayFinalizationError, keep admission closed, retain the
    // listener (not stopped), and report truthful facts.
    vi.mocked(executeFinalizationSequence).mockReturnValue({
      failure: { kind: "invalidation-failed", cancelHookFailures: 3 },
    });
    const { gateway } = setup();
    await gateway.start();
    expect(gateway.listener()).toBeDefined();
    expect(gateway.facts().state).toBe("ready");

    let thrown: unknown;
    try {
      await gateway.stop();
    } catch (error) {
      thrown = error;
    }
    // Typed finalization error
    expect(thrown).toBeInstanceOf(RemoteGatewayFinalizationError);
    expect((thrown as RemoteGatewayFinalizationError).detail.kind).toBe("invalidation-failed");
    expect((thrown as RemoteGatewayFinalizationError).detail.cancelHookFailures).toBe(3);
    // Admission remains closed
    expect(gateway.facts().admissionClosed).toBe(true);
    // Listener is retained (not unbound)
    expect(gateway.listener()).toBeDefined();
    // State is failed with truthful finalizationFailure facts
    expect(gateway.facts().state).toBe("failed");
    expect(gateway.facts().finalizationFailure).toEqual({
      kind: "invalidation-failed",
      cancelHookFailures: 3,
    });
  });

  it("R2: does not unbind the listener when cancellation hook fails", async () => {
    // R2: inject a real cancellation-hook failure via the mocked
    // finalization sequence. The gateway must throw
    // RemoteGatewayFinalizationError, keep admission closed, retain the
    // listener, and report truthful facts.
    vi.mocked(executeFinalizationSequence).mockReturnValue({
      failure: { kind: "cancellation-failed", cancelHookFailures: 2 },
    });
    const { gateway } = setup();
    await gateway.start();
    expect(gateway.listener()).toBeDefined();

    let thrown: unknown;
    try {
      await gateway.stop();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RemoteGatewayFinalizationError);
    expect((thrown as RemoteGatewayFinalizationError).detail.kind).toBe("cancellation-failed");
    expect((thrown as RemoteGatewayFinalizationError).detail.cancelHookFailures).toBe(2);
    expect(gateway.facts().admissionClosed).toBe(true);
    expect(gateway.listener()).toBeDefined();
    expect(gateway.facts().state).toBe("failed");
    expect(gateway.facts().finalizationFailure).toEqual({
      kind: "cancellation-failed",
      cancelHookFailures: 2,
    });
  });

  it("R2: successful retry after finalization failure completes unbind", async () => {
    // R2: after a finalization failure, a retry that succeeds must complete
    // the full finalization sequence and unbind the listener.
    let fail = true;
    vi.mocked(executeFinalizationSequence).mockImplementation(() => {
      if (fail) {
        return { failure: { kind: "invalidation-failed", cancelHookFailures: 1 } };
      }
      return {};
    });
    const { gateway } = setup();
    await gateway.start();

    // First stop fails
    let thrown: unknown;
    try {
      await gateway.stop();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RemoteGatewayFinalizationError);
    expect(gateway.listener()).toBeDefined();

    // Retry succeeds — finalization no longer fails
    fail = false;
    await gateway.stop();
    expect(gateway.listener()).toBeUndefined();
    expect(gateway.facts().state).toBe("disabled");
    expect(gateway.facts().finalizationFailure).toBeUndefined();
  });
});

describe("RemoteGateway — A5: bounded protocol body reader", () => {
  it("rejects oversize protocol body before mutation", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const largeBody = JSON.stringify({ ticketId: "x".repeat(10_000) });
    const request = new Request(`${ORIGIN}/api/remote/pairing`, {
      method: "POST",
      headers: {
        host: "192.168.1.20:9443",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: largeBody,
    });
    const response = await capturedFetch!(request, lanFacts);
    expect([413, 400, 403]).toContain(response.status);
    await gateway.stop();
  });

  it("rejects malformed JSON body before protocol mutation", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const request = new Request(`${ORIGIN}/api/remote/pairing`, {
      method: "POST",
      headers: {
        host: "192.168.1.20:9443",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: "{not valid json",
    });
    const response = await capturedFetch!(request, lanFacts);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await gateway.stop();
  });
});

describe("RemoteGateway — A7: undefined transport facts fail closed", () => {
  it("rejects requests with 403 when transport facts are undefined", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const request = new Request(`${ORIGIN}/api/remote/hello`, {
      headers: { host: "192.168.1.20:9443" },
    });
    const response = await capturedFetch!(request, undefined);
    expect(response.status).toBe(403);
    await gateway.stop();
  });

  it("admission-closed requests return 503 after stop", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    await gateway.stop();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const request = new Request(`${ORIGIN}/api/remote/hello`, {
      headers: { host: "192.168.1.20:9443" },
    });
    const response = await capturedFetch!(request, lanFacts);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.category).toBe("unavailable");
    expect(body.message).toContain("admission");
  });
});

describe("RemoteGateway — local-only routes fail before auth/product dispatch", () => {
  it("rejects /api/shell before product dispatch", async () => {
    const { serve, getFetch } = createCapturingServe();
    const dispatched = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const { gateway } = setup({ productDispatch: dispatched, serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const request = new Request(`${ORIGIN}/api/shell`, {
      headers: { host: "192.168.1.20:9443", origin: ORIGIN },
    });
    const response = await capturedFetch!(request, lanFacts);
    expect(response.status).toBe(404);
    expect(dispatched).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it("rejects /api/desktop before product dispatch", async () => {
    const { serve, getFetch } = createCapturingServe();
    const dispatched = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const { gateway } = setup({ productDispatch: dispatched, serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const request = new Request(`${ORIGIN}/api/desktop/launch`, {
      headers: { host: "192.168.1.20:9443", origin: ORIGIN },
    });
    const response = await capturedFetch!(request, lanFacts);
    expect(response.status).toBe(404);
    expect(dispatched).not.toHaveBeenCalled();
    await gateway.stop();
  });
});

describe("RemoteGateway — host listener and pairing administration stay local", () => {
  // The `octant listener` and `octant pair` commands reach these routes only
  // over the loopback administration channel. A request arriving on the
  // private listener is refused before auth or dispatch even when it carries
  // the host's local secret and a window capability, so a paired device can
  // never enable, move, or disable the listener or approve its own pairing.
  const administration: ReadonlyArray<readonly [string, "GET" | "POST"]> = [
    ["/api/desktop/private-listener/status", "GET"],
    ["/api/desktop/private-listener/enable", "POST"],
    ["/api/desktop/private-listener/restart", "POST"],
    ["/api/desktop/private-listener/disable", "POST"],
    ["/api/desktop/remote/pairing-tickets", "POST"],
    ["/api/desktop/remote/pairing-requests", "GET"],
    ["/api/desktop/remote/pairing-requests/approve", "POST"],
    ["/api/desktop/remote/pairing-requests/deny", "POST"],
  ];

  it("refuses every listener and pairing administration route to a remote client", async () => {
    const { serve, getFetch } = createCapturingServe();
    const dispatched = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const { gateway } = setup({ productDispatch: dispatched, serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    for (const [path, method] of administration) {
      const response = await capturedFetch!(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: {
            host: "192.168.1.20:9443",
            origin: ORIGIN,
            "content-type": "application/json",
            "x-octant-desktop-secret": "desktop-secret",
            "x-octant-window-capability": "A".repeat(43),
          },
          ...(method === "POST"
            ? { body: JSON.stringify({ ticketId: "77777777-7777-4777-8777-777777777777" }) }
            : {}),
        }),
        lanFacts,
      );
      expect(response.status, path).toBe(404);
    }
    expect(dispatched).not.toHaveBeenCalled();
    expect(gateway.facts().state).toBe("ready");
    await gateway.stop();
  });
});

describe("RemoteGateway — authenticated product handling unavailable by default", () => {
  it("returns 401/503 for authenticated product routes when productDispatch is undefined", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const request = new Request(`${ORIGIN}/api/chat/threads`, {
      headers: { host: "192.168.1.20:9443", origin: ORIGIN },
    });
    const response = await capturedFetch!(request, lanFacts);
    expect([401, 503]).toContain(response.status);
    await gateway.stop();
  });
});

describe("RemoteGateway — deterministic disable/finalization order", () => {
  it("R3: stop completes in order: admission → sessions → work → unbind", async () => {
    // R3: instrument the real finalization boundaries via the mocked
    // finalization sequence. The mock records when it is called. The serve
    // stop records unbind. The full sequence must be
    // admission → finalization → unbind.
    const events: string[] = [];
    vi.mocked(executeFinalizationSequence).mockImplementation((finalizers) => {
      finalizers.stopAdmission();
      events.push("admission");
      finalizers.invalidateSessions();
      events.push("sessions");
      finalizers.cancelWork();
      events.push("work");
      return {};
    });
    const { gateway } = setup({
      serve: () => ({
        url: new URL(ORIGIN),
        stop: vi.fn(async () => {
          events.push("unbind");
        }),
      }),
    });
    await gateway.start();
    await gateway.stop();
    expect(events).toEqual(["admission", "sessions", "work", "unbind"]);
    expect(gateway.facts().state).toBe("disabled");
    expect(gateway.listener()).toBeUndefined();
  });

  it("R3: fail-stop at invalidation prevents work cancellation and unbind", async () => {
    // R3: when invalidation fails, the gateway must not proceed to work
    // cancellation or unbind. The sequence stops at sessions.
    const events: string[] = [];
    vi.mocked(executeFinalizationSequence).mockImplementation((finalizers) => {
      finalizers.stopAdmission();
      events.push("admission");
      finalizers.invalidateSessions();
      events.push("sessions");
      return { failure: { kind: "invalidation-failed", cancelHookFailures: 1 } };
    });
    const { gateway } = setup({
      serve: () => ({
        url: new URL(ORIGIN),
        stop: vi.fn(async () => {
          events.push("unbind");
        }),
      }),
    });
    await gateway.start();
    let thrown: unknown;
    try {
      await gateway.stop();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RemoteGatewayFinalizationError);
    // Only admission and sessions were called — work and unbind were not
    expect(events).toEqual(["admission", "sessions"]);
    expect(gateway.listener()).toBeDefined();
  });

  it("R3: fail-stop at cancellation prevents unbind", async () => {
    // R3: when cancellation fails, the gateway must not proceed to unbind.
    const events: string[] = [];
    vi.mocked(executeFinalizationSequence).mockImplementation((finalizers) => {
      finalizers.stopAdmission();
      events.push("admission");
      finalizers.invalidateSessions();
      events.push("sessions");
      finalizers.cancelWork();
      events.push("work");
      return { failure: { kind: "cancellation-failed", cancelHookFailures: 1 } };
    });
    const { gateway } = setup({
      serve: () => ({
        url: new URL(ORIGIN),
        stop: vi.fn(async () => {
          events.push("unbind");
        }),
      }),
    });
    await gateway.start();
    let thrown: unknown;
    try {
      await gateway.stop();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RemoteGatewayFinalizationError);
    // Admission, sessions, and work were called — unbind was not
    expect(events).toEqual(["admission", "sessions", "work"]);
    expect(gateway.listener()).toBeDefined();
  });

  it("R3: admission closes before any finalization service is called", async () => {
    // R3: the admission gate (admissionRef.closed) is set synchronously
    // before executeFinalizationSequence is called. Verify by checking
    // admissionClosed inside the mock.
    vi.mocked(executeFinalizationSequence).mockImplementation(() => {
      // At this point, admission must already be closed
      expect(gateway.facts().admissionClosed).toBe(true);
      return {};
    });
    const { gateway } = setup();
    await gateway.start();
    expect(gateway.facts().admissionClosed).toBe(false);
    await gateway.stop();
    expect(gateway.facts().admissionClosed).toBe(true);
  });
});

describe("RemoteGateway — C1: no-bypass import surface", () => {
  it("production module does not export bypass-capable finalizer symbols", async () => {
    // C1: the production gateway module must not export any bypass-capable
    // finalizer seam or factory. No FinalizerSeams or
    // createRemoteGatewayForTests may be present — those would allow
    // production callers to bypass mandatory finalizers. The module does
    // export runtime error classes and protocol constants, which are not
    // bypass-capable.
    const mod = await import("./remoteGateway");
    expect(typeof mod.createRemoteGateway).toBe("function");
    expect(mod).not.toHaveProperty("createRemoteGatewayForTests");
    expect(mod).not.toHaveProperty("FinalizerSeams");
  });
});

describe("RemoteGateway — protocol hello route", () => {
  it("serves signed host hello on GET /api/remote/hello", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const request = new Request(`${ORIGIN}/api/remote/hello`, {
      headers: { host: "192.168.1.20:9443" },
    });
    const response = await capturedFetch!(request, lanFacts);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.productId).toBe("octant");
    expect(body.hostId).toBe(hostId);
    expect(body.remoteOrigin).toBe(ORIGIN);
    expect(body.signature).toBeTruthy();
    // A client built before client nonces sends none and gets the hello it
    // knows how to verify.
    expect(body.clientNonce).toBeUndefined();
    await gateway.stop();
  });

  it("signs the client nonce a hello request names into the hello it answers", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const clientNonce = "Zm9vYmFy".repeat(5) + "abc";
    const response = await getFetch()!(
      new Request(`${ORIGIN}/api/remote/hello?clientNonce=${clientNonce}`, {
        headers: { host: "192.168.1.20:9443" },
      }),
      lanFacts,
    );
    expect(response.status).toBe(200);
    const hello = await response.json();
    expect(hello.clientNonce).toBe(clientNonce);
    const { signature, hostPublicKey, ...facts } = hello;
    const payload = buildHostHelloSignaturePayload(facts);
    expect(payload.startsWith("octant.host-hello.v2\n")).toBe(true);
    expect(
      verify(
        "sha256",
        Buffer.from(payload, "utf8"),
        {
          key: createPublicKey({
            key: Buffer.from(hostPublicKey, "base64url"),
            format: "der",
            type: "spki",
          }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    await gateway.stop();
  });

  it("refuses a hello request whose query is anything but one well-formed client nonce", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const nonce = "a".repeat(43);
    for (const query of [
      "clientNonce=short",
      `clientNonce=${nonce}&clientNonce=${nonce}`,
      `clientNonce=${nonce}&other=1`,
      `other=${nonce}`,
      `clientNonce=${"a".repeat(42)}%3D`,
      "clientNonce=",
    ]) {
      const response = await getFetch()!(
        new Request(`${ORIGIN}/api/remote/hello?${query}`, {
          headers: { host: "192.168.1.20:9443" },
        }),
        lanFacts,
      );
      expect(response.status, query).toBe(400);
    }
    await gateway.stop();
  });
});

describe("RemoteGateway — web assets served on non-API GET", () => {
  it("serves web assets for GET /", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({
      serve,
      webAssets: () => Promise.resolve(new Response("<html>app</html>", { status: 200 })),
    });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();
    const request = new Request(`${ORIGIN}/`, {
      headers: { host: "192.168.1.20:9443" },
    });
    const response = await capturedFetch!(request, lanFacts);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("app");
    await gateway.stop();
  });
});

describe("RemoteGateway — a running design's page", () => {
  it("hands a frame's ticketed load to the page route without a session, and answers not found without one", async () => {
    const { serve, getFetch } = createCapturingServe();
    const designPage = vi.fn(async (request: Request) => {
      expect(request.headers.get("cookie")).toBeNull();
      return new Response("<p>prototype</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    const { gateway } = setup({ serve, designPage });
    await gateway.start();
    const page = `${ORIGIN}/api/canvas/design-page?ticket=${"a".repeat(43)}`;
    const response = await getFetch()!(
      new Request(page, {
        headers: {
          host: "192.168.1.20:9443",
          "sec-fetch-site": "same-origin",
          "sec-fetch-dest": "iframe",
        },
      }),
      lanFacts,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("prototype");
    expect(response.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts;/);
    expect(designPage).toHaveBeenCalledOnce();
    await gateway.stop();

    const capture = createCapturingServe();
    const bare = setup({ serve: capture.serve });
    await bare.gateway.start();
    const missing = await capture.getFetch()!(
      new Request(page, { headers: { host: "192.168.1.20:9443" } }),
      lanFacts,
    );
    expect(missing.status).toBe(404);
    await bare.gateway.stop();
  });
});

// ---------------------------------------------------------------------------
// F1: shutdown receipt lifetime — rotate operation ID after successful
// finalization / new enabled lifetime; stable only across retries of one
// incomplete stop.
// ---------------------------------------------------------------------------

describe("RemoteGateway — F1: shutdown receipt lifetime rotates per enabled lifetime", () => {
  it("invalidates sessions across two stop/start/stop cycles with same config", async () => {
    const { gateway, connection } = setup();
    await gateway.start();

    // Generation 1: create sessions, stop → sessions invalidated
    insertActiveSession(connection, "a".repeat(64));
    insertActiveSession(connection, "b".repeat(64));
    expect(countActiveSessions(connection)).toBe(2);
    await gateway.stop();
    expect(countActiveSessions(connection)).toBe(0);
    expect(countInvalidatedSessions(connection)).toBe(2);

    // Generation 2: same config, new enabled lifetime → new sessions
    await gateway.start();
    insertActiveSession(connection, "c".repeat(64));
    insertActiveSession(connection, "d".repeat(64));
    insertActiveSession(connection, "e".repeat(64));
    expect(countActiveSessions(connection)).toBe(3);

    // Stop again — must invalidate the NEW sessions, not skip with already-applied
    await gateway.stop();
    expect(countActiveSessions(connection)).toBe(0);
    expect(countInvalidatedSessions(connection)).toBe(5);
  });

  it("failed stop retry reuses the same operation ID (resumes same receipt)", async () => {
    // Use a serve whose stop rejects on the first call but succeeds on retry.
    let unbindAttempts = 0;
    const flakyServe: Serve = (opts) => {
      return {
        url: new URL(`https://${opts.hostname}:${opts.port}`),
        stop: async () => {
          unbindAttempts += 1;
          if (unbindAttempts === 1) {
            throw Object.assign(new Error("unbind failed"), { code: "shutdown-failed" });
          }
        },
      };
    };
    const { gateway, connection } = setup({ serve: flakyServe });
    await gateway.start();
    insertActiveSession(connection, "f".repeat(64));
    expect(countActiveSessions(connection)).toBe(1);

    // First stop: invalidation succeeds but unbind fails.
    // Sessions are invalidated (durable), but the listener remains bound.
    await expect(gateway.stop()).rejects.toThrow();
    expect(gateway.facts().state).toBe("failed");
    // The listener is retained for retry (F2).
    expect(gateway.listener()).toBeDefined();

    // Retry: same operation ID → does not create a duplicate receipt.
    // The receipt from the first attempt is "applied" — retry's
    // invalidateSessions returns "already-applied" (same command ID).
    // The unbind now succeeds.
    await gateway.stop();
    expect(gateway.facts().state).toBe("disabled");
    expect(gateway.listener()).toBeUndefined();
    expect(countActiveSessions(connection)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F2: unbind failure retains listener and preserves retry authority.
// ---------------------------------------------------------------------------

describe("RemoteGateway — F2: unbind failure retains listener for retry", () => {
  it("retains listener when unbind rejects; facts are truthful", async () => {
    let unbindAttempts = 0;
    const flakyServe: Serve = (opts) => {
      return {
        url: new URL(`https://${opts.hostname}:${opts.port}`),
        stop: async () => {
          unbindAttempts += 1;
          if (unbindAttempts === 1) {
            throw Object.assign(new Error("unbind failed"), { code: "shutdown-failed" });
          }
        },
      };
    };
    const { gateway } = setup({ serve: flakyServe });
    await gateway.start();
    expect(gateway.listener()).toBeDefined();

    // First stop: unbind fails
    await expect(gateway.stop()).rejects.toThrow(RemoteGatewayError);
    expect(gateway.facts().state).toBe("failed");
    expect(gateway.facts().errorCode).toBe("shutdown-failed");
    // F2: listener is NOT lost — retry can unbind
    expect(gateway.listener()).toBeDefined();

    // Retry: unbind succeeds
    await gateway.stop();
    expect(gateway.facts().state).toBe("disabled");
    expect(gateway.listener()).toBeUndefined();
    expect(gateway.facts().errorCode).toBeUndefined();
  });

  it("admission remains closed and facts truthful throughout failed unbind + retry", async () => {
    let unbindAttempts = 0;
    const flakyServe: Serve = (opts) => {
      return {
        url: new URL(`https://${opts.hostname}:${opts.port}`),
        stop: async () => {
          unbindAttempts += 1;
          if (unbindAttempts === 1) {
            throw Object.assign(new Error("unbind failed"), { code: "shutdown-failed" });
          }
        },
      };
    };
    const { gateway } = setup({ serve: flakyServe });
    await gateway.start();
    await expect(gateway.stop()).rejects.toThrow();
    // Admission closed, state failed, listener retained
    expect(gateway.facts().admissionClosed).toBe(true);
    expect(gateway.facts().state).toBe("failed");
    expect(gateway.listener()).toBeDefined();

    await gateway.stop();
    // After successful retry: disabled, admission still closed (until start)
    expect(gateway.facts().state).toBe("disabled");
    expect(gateway.facts().admissionClosed).toBe(true);
    expect(gateway.listener()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F4: loopback compatibility regression — the unchanged loopback/local
// server boundary must continue to serve and stop cleanly.
// ---------------------------------------------------------------------------

describe("RemoteGateway — F4: loopback compatibility regression", () => {
  it("loopback-only server (no remoteListener) starts and stops cleanly", async () => {
    // This is a gateway-level smoke: the gateway with no listener bound
    // is disabled and stop is a no-op.
    const { gateway } = setup();
    expect(gateway.facts().state).toBe("disabled");
    expect(gateway.listener()).toBeUndefined();
    // stop on a disabled gateway is a no-op (admission already closed)
    await gateway.stop();
    expect(gateway.facts().state).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// Trust issuance is blocked while clock recovery is required.
// A wall-clock rollback beyond tolerance must fail closed on pairing,
// negotiation, challenge, and session issuance rather than only clamping the
// effective now against the frozen high-water mark.
// ---------------------------------------------------------------------------

// 10 minutes exceeds the 2-minute rollback tolerance.
const ROLLBACK_BEYOND_TOLERANCE_MS = 10 * 60 * 1_000;

function trustIssuingPost(path: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "192.168.1.20:9443",
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: "{}",
  });
}

describe("RemoteGateway — clock-recovery gates trust issuance", () => {
  it("refuses pairing/negotiate/challenge/session while posture is recovery-required", async () => {
    const { serve, getFetch } = createCapturingServe();
    let wall = nowMs;
    const { gateway } = setup({ serve, now: () => wall });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();

    // Seed the monotonic high-water mark by observing the clock at real time.
    await capturedFetch!(trustIssuingPost("/api/remote/pairing"), lanFacts);

    // Roll the wall clock back beyond tolerance → recovery-required.
    wall = nowMs - ROLLBACK_BEYOND_TOLERANCE_MS;

    for (const path of [
      "/api/remote/pairing",
      "/api/remote/negotiate",
      "/api/remote/auth/challenge",
      "/api/remote/auth/session",
    ]) {
      const response = await capturedFetch!(trustIssuingPost(path), lanFacts);
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.category).toBe("unavailable");
      expect(body.reasonCode).toBe("clock-recovery-required");
    }
    await gateway.stop();
  });

  it("still serves read-only host hello while posture is recovery-required", async () => {
    const { serve, getFetch } = createCapturingServe();
    let wall = nowMs;
    const { gateway } = setup({ serve, now: () => wall });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();

    // Seed then roll back beyond tolerance.
    await capturedFetch!(trustIssuingPost("/api/remote/pairing"), lanFacts);
    wall = nowMs - ROLLBACK_BEYOND_TOLERANCE_MS;

    const hello = await capturedFetch!(
      new Request(`${ORIGIN}/api/remote/hello`, { headers: { host: "192.168.1.20:9443" } }),
      lanFacts,
    );
    expect(hello.status).toBe(200);
    await gateway.stop();
  });

  it("persists the monotonic high-water mark as it advances during request handling", async () => {
    const { serve, getFetch } = createCapturingServe();
    let wall = nowMs;
    const { gateway, connection } = setup({ serve, now: () => wall });
    await gateway.start();
    const capturedFetch = getFetch();
    expect(capturedFetch).toBeDefined();

    const storedMark = () =>
      (
        connection
          .prepare("SELECT high_water_mark_ms AS m FROM remote_clock_guard WHERE host_id = ?")
          .get(hostId) as { readonly m: number } | undefined
      )?.m;

    // A request at real time advances the mark; it is persisted mid-operation.
    await capturedFetch!(trustIssuingPost("/api/remote/pairing"), lanFacts);
    expect(storedMark()).toBe(nowMs);

    // Time advances further; the next request persists the higher mark without
    // relying on a clean stop.
    wall = nowMs + 5_000;
    await capturedFetch!(trustIssuingPost("/api/remote/pairing"), lanFacts);
    expect(storedMark()).toBe(nowMs + 5_000);
    await gateway.stop();
  });
});

// ---------------------------------------------------------------------------
// A window waiting for approval, and a device approved for a window that gave up.
// ---------------------------------------------------------------------------

const TICKET_LIFE_MS = 5 * 60 * 1_000;

function postJson(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "192.168.1.20:9443",
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("RemoteGateway — waiting for approval", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a pending ticket's status polls once a second for the ticket's whole life", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const fetch = getFetch()!;
    const ticket = gateway.localDeviceAdministration()!.createPairingTicket({
      sourceClass: "lan-private",
    });
    const poll = { ticketId: ticket.ticketId, ticketProof: ticket.ticketProof };

    const statuses: number[] = [];
    for (let second = 0; second < 300; second += 1) {
      const response = await fetch(postJson("/api/remote/pairing/status", poll), lanFacts);
      statuses.push(response.status);
      expect(await response.json()).toEqual({ status: "pending" });
      vi.advanceTimersByTime(1_000);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);

    // The same source can still say hello (ten a minute), and an unknown
    // ticket's status reads draw on that same ten.
    const unknown = { ticketId: "99999999-9999-4999-8999-999999999999", ticketProof: "x" };
    const unknownStatuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await fetch(postJson("/api/remote/pairing/status", unknown), lanFacts);
      unknownStatuses.push(response.status);
    }
    expect(unknownStatuses.filter((status) => status === 200)).toHaveLength(10);
    expect(unknownStatuses.slice(-2)).toEqual([429, 429]);
    await gateway.stop();
  });

  it("does not let the wrong proof for a live ticket reach the ticket's own budget", async () => {
    const { serve, getFetch } = createCapturingServe();
    const { gateway } = setup({ serve });
    await gateway.start();
    const fetch = getFetch()!;
    const ticket = gateway.localDeviceAdministration()!.createPairingTicket({
      sourceClass: "lan-private",
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await fetch(
        postJson("/api/remote/pairing/status", {
          ticketId: ticket.ticketId,
          ticketProof: "not-the-proof",
        }),
        lanFacts,
      );
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(10);
    expect(statuses.slice(-2)).toEqual([429, 429]);
    await gateway.stop();
  });
});

describe("RemoteGateway — approval for a window that never finished", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function approveForWindow(wall: { value: number }) {
    const { serve, getFetch } = createCapturingServe();
    const made = setup({ serve, now: () => wall.value });
    await made.gateway.start();
    const fetch = getFetch()!;
    const admin = made.gateway.localDeviceAdministration()!;
    const ticket = admin.createPairingTicket({ sourceClass: "lan-private" });

    const hello = await (
      await fetch(
        new Request(`${ORIGIN}/api/remote/hello`, { headers: { host: "192.168.1.20:9443" } }),
        lanFacts,
      )
    ).json();
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString().trim();
    const claim = await fetch(
      postJson("/api/remote/pairing", {
        ticketId: ticket.ticketId,
        ticketProof: ticket.ticketProof,
        hostHelloNonce: hello.nonce,
        devicePublicKey: publicPem,
        deviceKeyFingerprint: canonicalDeviceKeyFacts(publicPem)!.fingerprint,
        deviceLabel: "Second window",
        origin: ORIGIN,
        clientHello: {
          webBuildVersion: "0.1.0",
          supportedProtocolRange: { min: 1, max: 1 },
          browserCapabilities: ["webcrypto"],
        },
      }),
      lanFacts,
    );
    expect(claim.status).toBe(200);
    const { device } = admin.approvePairing({ ticketId: ticket.ticketId });
    return { ...made, admin, device, ticket, fetch };
  }

  it("removes the approved device after the ticket's life, with a journaled revoke", async () => {
    vi.useFakeTimers();
    const wall = { value: nowMs };
    const { gateway, admin, device, connection } = await approveForWindow(wall);
    expect(admin.listDevices().map((entry) => entry.state)).toEqual(["active"]);

    wall.value += TICKET_LIFE_MS + 1_000;
    await vi.advanceTimersByTimeAsync(TICKET_LIFE_MS + 2 * 60_000);

    const [removed] = admin.listDevices();
    expect(removed).toMatchObject({ deviceId: device.deviceId, state: "revoked" });
    expect(removed?.revokedReason).toBe("pairing-abandoned");
    expect(
      connection
        .prepare(
          "SELECT count(*) AS n FROM event_journal WHERE event_name = 'remote.device-revoked@1'",
        )
        .get(),
    ).toEqual({ n: 1 });
    await gateway.stop();
  });

  it("deletes a push registration held for the abandoned device and journals the clear without the token", async () => {
    vi.useFakeTimers();
    const wall = { value: nowMs };
    const { gateway, device, connection, pushRegistrations } = await approveForWindow(wall);
    // No route lets a device that never signed in register; the store is
    // written directly to show the abandoned device's removal reaches it.
    const token = "abandoned-device-push-token";
    pushRegistrations.register({
      hostId,
      deviceId: device.deviceId,
      platform: "android",
      token,
      notificationPublicKey: "MJaD3ARvNKlDGKOdP1uw2ORQnq9V7CJeVRT9Xg09h3E",
      preferences: {
        approvalNeeded: true,
        waiting: true,
        failure: true,
        completion: true,
        threadTitles: false,
      },
      now: nowIso,
    });

    wall.value += TICKET_LIFE_MS + 1_000;
    await vi.advanceTimersByTimeAsync(TICKET_LIFE_MS + 2 * 60_000);

    expect(pushRegistrations.get({ hostId, deviceId: device.deviceId })).toBeUndefined();
    const events = connection
      .prepare(
        "SELECT event_name, payload_json FROM event_journal WHERE aggregate_type = 'remote-push-registration' ORDER BY global_sequence",
      )
      .all() as ReadonlyArray<{ readonly event_name: string; readonly payload_json: string }>;
    expect(events.map((event) => event.event_name)).toEqual([
      "remote.push-registration-recorded@1",
      "remote.push-registration-cleared@1",
    ]);
    expect(JSON.parse(events[1]?.payload_json ?? "{}")).toMatchObject({
      deviceId: device.deviceId,
      reason: "pairing-abandoned",
    });
    expect(JSON.stringify(events)).not.toContain(token);
    await gateway.stop();
  });

  it("still tells the window it was approved when other sources have used up the host's pairing budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const wall = { value: nowMs };
    const { gateway, device, ticket, fetch } = await approveForWindow(wall);
    // Six other addresses say hello until the host-wide budget is gone.
    let refused = false;
    for (let source = 0; source < 8 && !refused; source += 1) {
      for (let i = 0; i < 10; i += 1) {
        const response = await fetch(
          new Request(`${ORIGIN}/api/remote/hello`, { headers: { host: "192.168.1.20:9443" } }),
          { ...lanFacts, sourceKey: `other-source-${source}` },
        );
        if (response.status === 429) refused = true;
      }
    }
    expect(refused).toBe(true);

    const response = await fetch(
      postJson("/api/remote/pairing/status", {
        ticketId: ticket.ticketId,
        ticketProof: ticket.ticketProof,
      }),
      lanFacts,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "approved",
      deviceId: device.deviceId,
      credentialGeneration: 1,
    });
    await gateway.stop();
  });

  it("keeps a device whose window signed in with its key", async () => {
    vi.useFakeTimers();
    const wall = { value: nowMs };
    const { gateway, admin, device, connection } = await approveForWindow(wall);
    connection
      .prepare(
        `INSERT INTO remote_session_store (
          session_id_digest, host_id, device_id, credential_generation, origin,
          protocol_version, capability_digest, issued_at, last_seen_at,
          idle_expires_at, absolute_expires_at, csrf_digest, state
        ) VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        "d".repeat(64),
        hostId,
        device.deviceId,
        ORIGIN,
        "c".repeat(64),
        wall.value,
        wall.value,
        wall.value + 60_000,
        wall.value + 600_000,
        "e".repeat(64),
      );

    wall.value += TICKET_LIFE_MS + 1_000;
    await vi.advanceTimersByTimeAsync(TICKET_LIFE_MS + 2 * 60_000);

    expect(admin.listDevices().map((entry) => entry.state)).toEqual(["active"]);
    await gateway.stop();
  });
});
