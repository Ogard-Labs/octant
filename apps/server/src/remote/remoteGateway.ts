// Dual-listener gateway composition.
//
// Composes the private HTTPS listener, remote route policy, signed protocol
// service, HTTP authentication, credential lifecycle, request registry, web
// assets, and an injected authenticated-product seam over one shared
// persistence/service graph. The gateway owns the fetch handler: callers
// cannot inject an arbitrary remote fetch that bypasses route/auth policy.
//
// Remote access is disabled by default. The gateway is constructed only when
// an explicit configuration is supplied, and it builds the exact route/auth
// policy atomically before the listener binds. A failed policy/TLS/bind/auth
// initialization leaves the loopback listener serving unchanged.
//
// Disable/finalization is deterministic: stop admission, invalidate sessions,
// cancel work, then unbind the listener. A failure in durable invalidation or
// cancellation leaves the gateway in a typed `failed` state with admission
// closed and the listener still bound so a retry can complete finalization.

import { randomUUID as defaultRandomUUID } from "node:crypto";
import type { StableHostId } from "@octant/contracts/remote-access";
import {
  REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR,
  REMOTE_AUTHENTICATION_PROTOCOL_VERSION,
  REMOTE_SECURITY_FLOOR,
  type ProtocolRange,
  type RemoteTimePostureV1,
} from "@octant/contracts/remote-access";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { RemoteRequestProofService } from "../remoteRequestProofService";
import { RemoteCredentialLifecycleService } from "../remoteCredentialLifecycleService";
import {
  createRemoteRouteHandler,
  createRemoteRoutePolicy,
  REMOTE_PROTOCOL_ROUTE_IDS,
  type RemoteRouteDefinition,
  type RemoteRouteFacts,
} from "../remoteRoutePolicy";
import {
  createPrivateListener,
  type PrivateListener,
  type PrivateListenerConfig,
  type PrivateListenerFailureCode,
} from "../privateListener";
import type { RequestTransportFacts, Serve } from "../server";
import {
  PairingDeviceLifecycleService,
  type PairingClaimResult,
} from "./pairingDeviceLifecycleService";
import type { LocalDeviceAdministrationPort } from "./localDeviceAdministrationRoutes";
import {
  REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST,
  RemoteProtocolError,
  RemoteProtocolService,
  type HostSigningPort,
} from "./remoteProtocolService";
import {
  createRemoteHttpAuthentication,
  REMOTE_AUTH_ROUTE_IDS,
  type RemoteClientPrincipalHandoff,
  type RemoteCredentialSelfServicePort,
  type RemoteHttpAuthentication,
  type RemoteRequestRegistryPort,
} from "./remoteHttpAuthentication";
import { createPushNotificationTokenStore } from "./pushNotificationTokenStore";
import { createRemoteRequestRegistry } from "./remoteRequestRegistry";
import { executeFinalizationSequence } from "./remoteGatewayFinalization";
import { MonotonicRemoteClock } from "./monotonicRemoteClock";

const DEFAULT_SUPPORTED_PROTOCOL_RANGE: ProtocolRange = { min: 1, max: 1 };
const PROTOCOL_BODY_MAX_BYTES = 8_192;

/**
 * Pre-auth routes that mint new real-time authority. These are
 * refused while the server-owned time posture is `recovery-required` so an
 * unsafe host clock cannot extend the lifetime of freshly issued trust.
 */
const TRUST_ISSUING_PRE_AUTH_ROUTE_IDS: ReadonlySet<string> = new Set([
  REMOTE_PROTOCOL_ROUTE_IDS.pairing,
  REMOTE_PROTOCOL_ROUTE_IDS.negotiate,
  REMOTE_AUTH_ROUTE_IDS.challenge,
  REMOTE_AUTH_ROUTE_IDS.session,
]);

/**
 * The injected authenticated-product seam. When undefined, authenticated
 * product handling is unavailable and every authenticated non-self-service
 * route returns 503 until the shared client principal supplies the real
 * product dispatch.
 */
export type RemoteProductDispatch = (
  handoff: RemoteClientPrincipalHandoff,
) => Promise<Response | undefined>;

export interface RemoteGatewayServices {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly hostId: StableHostId;
  readonly displayName: string;
  readonly serverBuildVersion: string;
  readonly signing: HostSigningPort;
  /**
   * Web assets handler for static GET requests. The gateway does not own the
   * web build; it reuses the same handler as the loopback listener.
   */
  readonly webAssets: (request: Request) => Response | Promise<Response | undefined>;
  /**
   * Authenticated product dispatch seam. When undefined, authenticated product
   * routes fail closed with 503 until a real handler is supplied.
   */
  readonly productDispatch?: RemoteProductDispatch;
  readonly serve: Serve;
  readonly now?: () => number;
  readonly uuid?: () => string;
  readonly clock?: () => string;
  readonly actorId?: string;
  /**
   * Optional shared push-token destination store. When omitted the gateway
   * creates an isolated in-memory store for this generation.
   */
  readonly pushTokenStore?: import("./pushNotificationTokenStore").PushNotificationTokenStore;
}

export interface RemoteGatewayConfig {
  readonly listener: PrivateListenerConfig;
}

export interface RemoteGatewayOptions extends RemoteGatewayServices {
  readonly config: RemoteGatewayConfig;
}

export type RemoteGatewayState = "disabled" | "ready" | "failed";

/**
 * Finalization failure detail. When `stop` reports unresolved hook failures,
 * the gateway exposes the typed failure so a retry can complete finalization
 * before unbinding.
 */
export interface RemoteGatewayFinalizationFailure {
  readonly kind: "invalidation-failed" | "cancellation-failed";
  readonly cancelHookFailures: number;
}

export interface RemoteGatewayFacts {
  readonly state: RemoteGatewayState;
  readonly origin: string;
  readonly hostId: StableHostId;
  readonly errorCode?: PrivateListenerFailureCode;
  readonly finalizationFailure?: RemoteGatewayFinalizationFailure;
  /** True when admission is closed: new requests are rejected before dispatch. */
  readonly admissionClosed: boolean;
}

export interface RemoteGateway {
  readonly facts: () => RemoteGatewayFacts;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: (config: RemoteGatewayConfig) => Promise<void>;
  readonly listener: () => PrivateListener | undefined;
  /** Local packaged-host administration over the loopback desktop bridge. */
  readonly localDeviceAdministration: () => LocalDeviceAdministrationPort | undefined;
}

/**
 * Identity bundle derived from one config so listener, origin, policy, and
 * authentication identities cannot diverge during restart.
 */
interface GatewayIdentity {
  readonly origin: string;
  readonly hostId: StableHostId;
}

/**
 * One atomically-swapped generation bundle. The listener, services, identity,
 * and config all derive from the same generation so `start` always binds the
 * exact generation's config and services together.
 */
interface GatewayGeneration {
  readonly config: RemoteGatewayConfig;
  readonly identity: GatewayIdentity;
  readonly services: GatewayServices;
}

export class RemoteGatewayError extends Error {
  readonly code: PrivateListenerFailureCode;

  constructor(code: PrivateListenerFailureCode) {
    super(`Octant remote gateway ${code.replaceAll("-", " ")}.`);
    this.name = "RemoteGatewayError";
    this.code = code;
  }
}

/**
 * Finalization error — durable invalidation or cancellation reported
 * unresolved hook failures. The listener remains bound and admission remains
 * closed so a retry can complete finalization.
 */
export class RemoteGatewayFinalizationError extends Error {
  readonly detail: RemoteGatewayFinalizationFailure;

  constructor(detail: RemoteGatewayFinalizationFailure) {
    super(`Octant remote gateway finalization ${detail.kind}.`);
    this.name = "RemoteGatewayFinalizationError";
    this.detail = detail;
  }
}

interface GatewayServices {
  readonly gatewayFetch: (request: Request, facts?: RequestTransportFacts) => Promise<Response>;
  readonly localDeviceAdministration: LocalDeviceAdministrationPort;
  readonly stopAdmission: () => void;
  readonly invalidateSessions: () => RemoteCredentialInvalidationResult;
  readonly cancelWork: () => { readonly canceled: number; readonly cancelHookFailures: number };
  /**
   * Durably persist the server-owned monotonic clock high-water
   * mark. Best-effort and safe to call at listener start/stop (outside any
   * database transaction). The durable observed timestamps remain the recovery
   * source if this write is skipped.
   */
  readonly persistClockGuard: () => void;
}

interface RemoteCredentialInvalidationResult {
  readonly cancelHookFailures: number;
}

export function createRemoteGateway(options: RemoteGatewayOptions): RemoteGateway {
  // A1: gateway-owned admission gate. Checked synchronously before any
  // route/auth/product dispatch. stop() closes this first. The ref is shared
  // between the gateway closure and the services' gatewayFetch so both see
  // the same closed state.
  const admissionRef = { closed: false };
  // F1: shutdown command ID is rotated on each successful start() (new enabled
  // lifetime). It is stable across retries of one incomplete stop so a
  // crash/retry resumes the same receipt. After successful finalization, the
  // next start() generates a fresh ID so new sessions in the next lifetime are
  // invalidated, not skipped as "already-applied".
  const shutdownCommandIdRef = { value: options.uuid?.() ?? defaultRandomUUID() };
  // A2: one mutable, atomically-swapped generation. start() always binds the
  // exact generation's config + services so listener and policy/auth identity
  // cannot mismatch across restart.
  let generation = buildGeneration(options, options.config, admissionRef, shutdownCommandIdRef);
  let listener: PrivateListener | undefined;
  let state: RemoteGatewayState = "disabled";
  let errorCode: PrivateListenerFailureCode | undefined;
  let finalizationFailure: RemoteGatewayFinalizationFailure | undefined;

  const facts = (): RemoteGatewayFacts => ({
    state,
    origin: generation.identity.origin,
    hostId: generation.identity.hostId,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(finalizationFailure === undefined ? {} : { finalizationFailure }),
    admissionClosed: admissionRef.closed,
  });

  const start = async (): Promise<void> => {
    if (listener !== undefined) return;
    state = "disabled";
    errorCode = undefined;
    finalizationFailure = undefined;
    admissionRef.closed = false;
    try {
      listener = createPrivateListener({
        config: generation.config.listener,
        fetch: generation.services.gatewayFetch,
        serve: options.serve,
        ...(generation.config.listener.admissionLimits === undefined
          ? {}
          : { admissionLimits: generation.config.listener.admissionLimits }),
      });
      await listener.start();
      // F1: rotate the shutdown command ID for this new enabled lifetime.
      // A retry of a failed stop keeps the old ID (start is not called between
      // retries); a new enabled lifetime gets a fresh ID so new sessions are
      // invalidated, not skipped as "already-applied".
      shutdownCommandIdRef.value = options.uuid?.() ?? defaultRandomUUID();
      state = "ready";
      // Persist the monotonic high-water mark now that the listener
      // is bound. Best-effort — a failure must not destabilize the ready
      // listener, and the durable observed timestamps remain the recovery
      // source across a restart.
      persistClockGuardSafely(generation.services);
    } catch (error) {
      listener = undefined;
      state = "failed";
      errorCode = classifyGatewayError(error);
      throw new RemoteGatewayError(errorCode);
    }
  };

  const stop = async (): Promise<void> => {
    // Deterministic disable/finalization order:
    // 1. Stop admission — the gateway-owned gate closes synchronously so new
    //    requests are rejected before route/auth/product dispatch.
    // 2. Invalidate sessions — durable session invalidation commits so
    //    authenticated clients cannot resume after unbind.
    // 3. Cancel work — in-flight request streams are canceled via the
    //    registry so handlers observe the abort signal.
    // 4. Unbind — the listener socket closes only after admission, sessions,
    //    and work are finalized. A4: if invalidation or cancellation reports
    //    unresolved hook failures, the gateway enters a typed `failed` state
    //    with admission closed and the listener still bound so a retry can
    //    complete finalization.
    admissionRef.closed = true;
    const outcome = executeFinalizationSequence(generation.services);
    if (outcome.failure !== undefined) {
      state = "failed";
      finalizationFailure = outcome.failure;
      throw new RemoteGatewayFinalizationError(outcome.failure);
    }
    // Persist the monotonic high-water mark after finalization
    // succeeds but before the socket unbinds, so the last observed time is
    // durable across a clean disable/restart.
    persistClockGuardSafely(generation.services);
    const current = listener;
    // F2: retain the listener until unbind succeeds. If unbind rejects, the
    // listener handle is preserved so a retry can unbind. Setting
    // listener = undefined before awaiting would lose the handle and make
    // facts() lie about the bound state.
    if (current !== undefined) {
      try {
        await current.stop();
      } catch (error) {
        state = "failed";
        errorCode = classifyGatewayError(error);
        throw new RemoteGatewayError(errorCode);
      }
    }
    listener = undefined;
    state = "disabled";
    errorCode = undefined;
    finalizationFailure = undefined;
    // Admission remains closed after stop so any in-flight boundary fetch
    // still rejects. start() reopens admission.
  };

  const restart = async (nextConfig: RemoteGatewayConfig): Promise<void> => {
    // A2: rebuild the entire generation atomically. The new identity, services,
    // and config are swapped together so start() binds the exact new
    // generation. No Object.assign on readonly service/identity objects.
    await stop();
    generation = buildGeneration(options, nextConfig, admissionRef, shutdownCommandIdRef);
    await start();
  };

  return {
    facts,
    start,
    stop,
    restart,
    listener: () => listener,
    localDeviceAdministration: () => generation.services.localDeviceAdministration,
  };
}

/**
 * Best-effort durable persist of the monotonic clock high-water mark. Wrapped
 * so a persistence failure never destabilizes the listener lifecycle; the
 * durable observed timestamps in the remote stores remain the recovery source.
 */
function persistClockGuardSafely(services: GatewayServices): void {
  try {
    services.persistClockGuard();
  } catch {
    // Ignore — the guard row is a best-effort optimization over the durable
    // observed timestamps already committed to the remote stores.
  }
}

function buildGeneration(
  options: RemoteGatewayOptions,
  config: RemoteGatewayConfig,
  admissionRef: { closed: boolean },
  shutdownCommandIdRef: { value: string },
): GatewayGeneration {
  const identity = deriveIdentity(config, options.hostId);
  const services = assembleServices(options, config, identity, admissionRef, shutdownCommandIdRef);
  return { config, identity, services };
}

function assembleServices(
  options: RemoteGatewayOptions,
  config: RemoteGatewayConfig,
  identity: GatewayIdentity,
  admissionRef: { closed: boolean },
  shutdownCommandIdRef: { value: string },
): GatewayServices {
  const uuid = options.uuid ?? (() => defaultRandomUUID());
  const wallClock = options.now ?? (() => Date.now());
  // Server-owned monotonic epoch guard. Every expiry decision in the
  // gateway reads `now`/`clock` from this bound, so a wall-clock rollback (NTP
  // step, manual change, DST/timezone misconfiguration, restart, or restored
  // snapshot) can never revive expired pairing tickets, sessions, devices,
  // challenges, or receipts. The bound is seeded from the persisted guard row
  // and the greatest observed timestamps already committed to the remote stores.
  const monotonicClock = new MonotonicRemoteClock({
    connection: options.connection,
    hostId: identity.hostId,
    wallClock,
  });
  const now = monotonicClock.now();
  // A6: single clock derivation — both `now` and `clock` derive from the one
  // monotonic bound, so there is no duplicate or divergent clock.
  const clock = monotonicClock.clock();
  const actorId = options.actorId ?? uuid();

  // Pairing device lifecycle service — the gateway owns this composition. It
  // is always constructed from the shared connection/journal so the protocol
  // service claims from the exact in-memory ticket store the gateway owns.
  // No caller-supplied lifecycle override exists on the production options
  // surface; the hostile-browser harness captures this instance through
  // a test-only module mock (vi.mock) absent from the gateway export surface.
  const lifecycle = new PairingDeviceLifecycleService({
    hostId: identity.hostId,
    journal: options.journal,
    connection: options.connection,
    now,
    uuid,
  });

  // Protocol service — signed host hello, pairing, negotiation.
  const protocol = new RemoteProtocolService({
    hostId: identity.hostId,
    displayName: options.displayName,
    serverBuildVersion: options.serverBuildVersion,
    remoteOrigin: identity.origin,
    supportedProtocolRange: DEFAULT_SUPPORTED_PROTOCOL_RANGE,
    securityFloor: REMOTE_SECURITY_FLOOR,
    authenticationProtocolVersions: [REMOTE_AUTHENTICATION_PROTOCOL_VERSION],
    signing: options.signing,
    lifecycle,
    journal: options.journal,
    connection: options.connection,
    now,
    uuid,
  });

  // Proof service — challenge/session issuance + request proof verification.
  // resolveNegotiation is wired to the protocol service so session issuance
  // consumes the exact negotiation record.
  const proof = new RemoteRequestProofService(options.connection, {
    now,
    resolveNegotiation: (input) => protocol.resolveNegotiation(input),
  });

  // Request registry — process-scoped active request tracking.
  const registry = createRemoteRequestRegistry();

  // Credential lifecycle service — sign-out/rotate/revoke with session
  // invalidation. The onSessionsInvalidated callback cancels matching
  // in-flight work via the registry.
  const credentialLifecycle = new RemoteCredentialLifecycleService({
    connection: options.connection,
    journal: options.journal,
    actorId,
    uuid,
    clock,
    onSessionsInvalidated: (input) => {
      let canceled = 0;
      let cancelHookFailures = 0;
      for (const deviceId of input.deviceIds) {
        const result = registry.cancelByDevice({ hostId: input.hostId, deviceId });
        canceled += result.canceled;
        cancelHookFailures += result.cancelHookFailures;
      }
      return { canceled, cancelHookFailures };
    },
  });

  const localDeviceAdministration: LocalDeviceAdministrationPort = {
    createPairingTicket: (input) => lifecycle.createTicket(input),
    listPendingPairings: () => lifecycle.listPendingClaims(),
    approvePairing: (input) => lifecycle.approveTicket(input),
    denyPairing: (input) => lifecycle.denyTicket(input),
    listDevices: () => lifecycle.listDevices(),
    renameDevice: (input) => lifecycle.renameDevice(input),
    revokeDevice: (input) =>
      credentialLifecycle.revokeDevice({
        commandId: uuid(),
        hostId: identity.hostId,
        deviceId: input.deviceId,
        reasonCode: "local-device-revoked",
      }),
    revokeAll: () =>
      credentialLifecycle.revokeAll({
        commandId: uuid(),
        hostId: identity.hostId,
        reasonCode: "local-all-devices-revoked",
      }),
    reconcileExpired: () =>
      credentialLifecycle.reconcileExpired({
        commandId: uuid(),
        hostId: identity.hostId,
      }),
  };

  // Session revalidation port — re-reads authoritative session state before
  // dispatch to close the verify-vs-revoke TOCTOU.
  const sessionRevalidation = {
    isSessionActive: (sessionId: string) => proof.describeSession(sessionId) !== undefined,
  };

  // Credential self-service port — adapts the lifecycle service to the
  // HTTP authentication self-service route handler.
  const credentialSelfService: RemoteCredentialSelfServicePort = {
    readOwnDevice: (input) =>
      credentialLifecycle.readOwnDeviceMetadata({
        hostId: input.hostId,
        deviceId: input.deviceId,
        credentialGeneration: input.credentialGeneration,
        ...(input.sessionIdleExpiresAt === undefined
          ? {}
          : { sessionIdleExpiresAt: input.sessionIdleExpiresAt }),
        ...(input.sessionAbsoluteExpiresAt === undefined
          ? {}
          : { sessionAbsoluteExpiresAt: input.sessionAbsoluteExpiresAt }),
      }) as ReturnType<NonNullable<RemoteCredentialSelfServicePort["readOwnDevice"]>>,
    signOut: (input) =>
      credentialLifecycle.signOut({
        commandId: input.commandId,
        hostId: input.hostId,
        deviceId: input.deviceId,
        sessionIdDigest: input.sessionIdDigest,
      }),
    selfRotateDevice: (input) =>
      credentialLifecycle.selfRotateDevice({
        commandId: input.commandId,
        hostId: input.hostId,
        deviceId: input.deviceId,
        credentialGeneration: input.credentialGeneration,
        newDeviceKeyFingerprint: input.newDeviceKeyFingerprint,
        newDevicePublicKey: input.newDevicePublicKey,
        newKeyProof: input.newKeyProof,
      }),
    selfRevokeDevice: (input) =>
      credentialLifecycle.selfRevokeDevice({
        commandId: input.commandId,
        hostId: input.hostId,
        deviceId: input.deviceId,
      }),
  };

  // HTTP authentication — pre-auth challenge/session + authenticated
  // self-service and product dispatch.
  const pushTokenStore = options.pushTokenStore ?? createPushNotificationTokenStore();
  const auth: RemoteHttpAuthentication = createRemoteHttpAuthentication({
    proofService: proof,
    signNegotiationMetadata: (payload) =>
      // The host signing port signs negotiation metadata so the client can
      // verify the session response came from the same host identity.
      options.signing.signHostPayload(payload),
    credentialSelfService,
    pushTokenStore,
    requestRegistry: registry as RemoteRequestRegistryPort,
    sessionRevalidation,
    ...(options.productDispatch === undefined ? {} : { productDispatch: options.productDispatch }),
  });

  // Route policy — exact origin from the listener config so policy identity
  // matches listener identity.
  const policy = createRemoteRoutePolicy({ origin: identity.origin });

  // Route handler — facts-aware so protocol routes receive the trusted
  // source class from the accepted socket.
  // The server-owned time posture gates trust issuance. When the
  // wall clock rolls back beyond tolerance, is malformed, or jumps implausibly
  // forward, `recovery-required` is surfaced and every trust-issuing route
  // fails closed instead of issuing pairing tickets, challenges, or sessions
  // against an unsafe clock frozen at the high-water mark.
  const clockPosture = (): RemoteTimePostureV1 => monotonicClock.posture();

  const routeHandler = createRemoteRouteHandler({
    policy,
    webAssets: options.webAssets,
    preAuth: async (request, route, facts) =>
      handlePreAuthRoute(request, route, facts, protocol, auth, clockPosture),
    authenticatedProduct: async (request, route, facts) =>
      handleAuthenticatedRoute(request, route, facts, auth),
  });

  // Gateway fetch — the only fetch the listener ever calls. It checks the
  // admission gate synchronously and adapts transport facts.
  const gatewayFetch = async (
    request: Request,
    transportFacts?: RequestTransportFacts,
  ): Promise<Response> => {
    if (admissionRef.closed) {
      return admissionClosedResponse();
    }
    // A7: undefined transport facts fail closed before protocol/auth dispatch.
    // Do not fabricate an empty sourceKey and rely on downstream behavior.
    if (transportFacts === undefined) {
      return factsMissingResponse();
    }
    const routeFacts: RemoteRouteFacts = {
      sourceClass: transportFacts.sourceClass,
      sourceKey: transportFacts.sourceKey,
    };
    try {
      return await routeHandler(request, routeFacts);
    } finally {
      // Durably persist any monotonic advance observed while handling
      // this request (outside the handler's own transaction, which has already
      // committed). This keeps an expiry-boundary advance from being lost on a
      // crash before a clean stop. Best-effort — a persistence failure must not
      // change the response the client already received.
      try {
        monotonicClock.persistIfAdvanced();
      } catch {
        // Ignore — the guard row is a best-effort optimization over the durable
        // observed timestamps already committed to the remote stores.
      }
    }
  };

  // F1: shutdown command ID is read from a mutable ref that is rotated on
  // each successful start(). This ensures a retry of a failed stop reuses the
  // same ID (resumes the same receipt), while a new enabled lifetime gets a
  // fresh ID so new sessions are invalidated, not skipped as "already-applied".
  // The finalization sequence (admission → sessions → work → unbind) is
  // executed by `executeFinalizationSequence` from the internal
  // `remoteGatewayFinalization` module. The finalizers below are always
  // assembled from real collaborators — no bypass path exists.
  return {
    gatewayFetch,
    localDeviceAdministration,
    stopAdmission: () => {
      // Clear ephemeral protocol state (nonces/negotiations). The admission
      // gate is closed before this is called.
      protocol.clearEphemeralState();
    },
    invalidateSessions: () => {
      const receipt = credentialLifecycle.invalidateAllSessions({
        commandId: shutdownCommandIdRef.value,
        hostId: identity.hostId,
        reasonCode: "listener-disabled",
      });
      return {
        cancelHookFailures: receipt.cancellation?.cancelHookFailures ?? 0,
      };
    },
    cancelWork: () => registry.cancelAll(),
    persistClockGuard: () => monotonicClock.persist(),
  };
}

/**
 * Handle a pre-auth route: protocol (hello/pairing/negotiate) or auth
 * (challenge/session). Protocol routes require the trusted source class
 * from the transport facts; auth routes delegate to the HTTP authentication
 * handler.
 */
async function handlePreAuthRoute(
  request: Request,
  route: RemoteRouteDefinition,
  facts: RemoteRouteFacts | undefined,
  protocol: RemoteProtocolService,
  auth: RemoteHttpAuthentication,
  clockPosture: () => RemoteTimePostureV1,
): Promise<Response | undefined> {
  // Fail closed on trust issuance while clock recovery is required.
  // Pairing claims, negotiation, challenges, and session issuance all mint new
  // real-time authority; an unsafe clock (rollback beyond tolerance, malformed,
  // or an implausible forward jump) must not extend their lifetime against the
  // frozen high-water mark. Read-only routes (hello, pairing status) are not
  // gated. The posture is checked before the request body is consumed so no
  // protocol state mutates while recovery is required.
  if (TRUST_ISSUING_PRE_AUTH_ROUTE_IDS.has(route.id)) {
    const posture = clockPosture();
    if (posture.posture === "recovery-required") {
      return clockRecoveryRejectResponse();
    }
  }
  try {
    if (route.id === REMOTE_PROTOCOL_ROUTE_IDS.hello) {
      return Response.json(protocol.issueHostHello(), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (route.id === REMOTE_PROTOCOL_ROUTE_IDS.pairing) {
      if (facts === undefined) return protocolReject(403);
      const body = await readBoundedProtocolBody(request);
      const result = protocol.claimPairing({
        sourceClass: facts.sourceClass,
        request: body,
      });
      return Response.json(pairingClaimToJson(result), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (route.id === REMOTE_PROTOCOL_ROUTE_IDS.pairingStatus) {
      const body = await readBoundedProtocolBody(request);
      const result = protocol.pairingStatus(body);
      return Response.json(result, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (route.id === REMOTE_PROTOCOL_ROUTE_IDS.negotiate) {
      if (facts === undefined) return protocolReject(403);
      const body = await readBoundedProtocolBody(request);
      const result = protocol.negotiate({
        sourceClass: facts.sourceClass,
        request: body,
      });
      return Response.json(result, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  } catch (error) {
    // A5: translate RemoteProtocolError to a typed rejection response so
    // malformed/oversize inputs fail before protocol mutation with a
    // proper status code, not a generic 503 from the route handler catch.
    if (error instanceof RemoteProtocolError) {
      return protocolReject(
        error.category === "unavailable" ? 503 : error.category === "invalid" ? 400 : 401,
      );
    }
    throw error;
  }
  // Auth challenge/session routes — delegate to HTTP authentication.
  // A7: facts are always defined here because gatewayFetch rejects undefined
  // facts before dispatch. But handlePreAuthRoute may be called directly in
  // tests; fail closed if facts are missing.
  if (facts === undefined) return protocolReject(403);
  const transport: RequestTransportFacts = {
    listenerTrust: "remote",
    sourceClass: facts.sourceClass,
    sourceKey: facts.sourceKey,
  };
  return auth.handlePreAuthRoute(request, route, transport);
}

/**
 * Handle an authenticated route: self-service (sign-out/rotate/revoke) or
 * product dispatch. Delegates to the HTTP authentication handler which
 * verifies the session cookie + per-request proof before dispatch.
 */
async function handleAuthenticatedRoute(
  request: Request,
  route: RemoteRouteDefinition,
  facts: RemoteRouteFacts | undefined,
  auth: RemoteHttpAuthentication,
): Promise<Response> {
  // A7: fail closed if facts are missing.
  if (facts === undefined) return protocolReject(403);
  const transport: RequestTransportFacts = {
    listenerTrust: "remote",
    sourceClass: facts.sourceClass,
    sourceKey: facts.sourceKey,
  };
  return auth.handleAuthenticated(request, transport, route);
}

function deriveIdentity(config: RemoteGatewayConfig, hostId: StableHostId): GatewayIdentity {
  const origin =
    config.listener.origin ??
    `https://${config.listener.hostname}${config.listener.port === 443 ? "" : `:${config.listener.port}`}`;
  return { origin, hostId };
}

function classifyGatewayError(error: unknown): PrivateListenerFailureCode {
  if (error instanceof RemoteGatewayError) return error.code;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    isPrivateListenerFailureCodeString(error.code)
  ) {
    return error.code as PrivateListenerFailureCode;
  }
  return "bind-failed";
}

function isPrivateListenerFailureCodeString(value: string): boolean {
  return (
    value === "invalid-bind" ||
    value === "invalid-origin" ||
    value === "invalid-tls" ||
    value === "occupied-port" ||
    value === "interface-unavailable" ||
    value === "cancelled" ||
    value === "shutdown-failed" ||
    value === "bind-failed"
  );
}

/**
 * A5: bounded pre-auth body reader with cancellation. Reads at most
 * PROTOCOL_BODY_MAX_BYTES, cancels the stream on oversize/malformed input,
 * and throws a typed RemoteProtocolError before any protocol mutation.
 */
async function readBoundedProtocolBody(request: Request): Promise<unknown> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done || next.value === undefined) break;
      total += next.value.byteLength;
      if (total > PROTOCOL_BODY_MAX_BYTES) {
        await reader.cancel();
        throw new RemoteProtocolError("invalid", "Remote protocol request body is too large.");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof RemoteProtocolError) throw error;
    await reader.cancel().catch(() => undefined);
    throw new RemoteProtocolError("invalid", "Remote protocol request body is invalid.");
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new RemoteProtocolError("invalid", "Remote protocol request body is malformed.");
  }
}

function admissionClosedResponse(): Response {
  return Response.json(
    {
      product: "Octant",
      status: "rejected",
      category: "unavailable",
      message: "Remote gateway admission is closed.",
    },
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        vary: "Origin",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function factsMissingResponse(): Response {
  return Response.json(
    {
      product: "Octant",
      status: "rejected",
      category: "unauthorized",
      message: "Remote request transport facts are missing.",
    },
    {
      status: 403,
      headers: {
        "content-type": "application/json; charset=utf-8",
        vary: "Origin",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/**
 * Trust issuance is paused because the server-owned time posture is
 * `recovery-required`. The response is a typed 503 so clients back off and the
 * host operator can resolve the unsafe clock before new authority is minted.
 */
function clockRecoveryRejectResponse(): Response {
  return Response.json(
    {
      product: "Octant",
      status: "rejected",
      category: "unavailable",
      reasonCode: "clock-recovery-required",
      message: "Remote trust issuance is paused while host clock recovery is required.",
    },
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        vary: "Origin",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function protocolReject(status: number, reasonCode?: "expired" | "revoked"): Response {
  return Response.json(
    {
      product: "Octant",
      status: "rejected",
      category: "unauthorized",
      ...(reasonCode === undefined ? {} : { reasonCode }),
      message: "Remote protocol request rejected.",
    },
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        vary: "Origin",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function pairingClaimToJson(result: PairingClaimResult): unknown {
  return {
    kind: result.kind,
    ticketId: result.ticketId,
    hostId: result.hostId,
    deviceLabel: result.deviceLabel,
    deviceKeyFingerprint: result.deviceKeyFingerprint,
    origin: result.origin,
    sourceClass: result.sourceClass,
    comparisonCode: result.comparisonCode,
    claimedAt: result.claimedAt,
    expiresAt: result.expiresAt,
  };
}

export {
  REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR,
  REMOTE_AUTHENTICATION_ONLY_CAPABILITY_DIGEST,
  REMOTE_AUTH_ROUTE_IDS,
};
