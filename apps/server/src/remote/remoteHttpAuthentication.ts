import { createHash } from "node:crypto";
import type { RemoteClientPrincipal, StableHostId } from "@octant/contracts/remote-access";
import {
  decodeRemoteChallengeRequestV1,
  decodeRemoteKeyRotationRequestV1,
  decodeRemoteOwnDeviceMetadataV1,
  decodeRemoteSelfServiceEmptyBodyV1,
  decodeRemoteSelfServiceReceiptV1,
  decodeRemoteSessionRequestV1,
  decodeRemoteSessionResponseV1,
  decodeRemoteRequestProofV1,
  type RemoteChallengeRequestV1,
  type RemoteRequestProofV1,
  type RemoteSessionRequestV1,
} from "@octant/contracts/remote-request-proof";
import {
  decodeRemotePushTokenClearV1,
  decodeRemotePushTokenReceiptV1,
  decodeRemotePushTokenRegistrationV1,
} from "@octant/contracts";
import { buildRemoteSessionMetadataPayload, canonicalizeRemotePathQuery } from "@octant/domain";
import {
  RemoteRequestProofError,
  type RemoteRequestProofService,
  type RemoteSessionFacts,
} from "../remoteRequestProofService";
import type { RemoteRouteDefinition } from "../remoteRoutePolicy";
import type { PushNotificationTokenStore } from "./pushNotificationTokenStore";

export const REMOTE_SESSION_COOKIE = "__Secure-octant-remote-session";

export const REMOTE_AUTH_ROUTE_IDS = {
  challenge: "remote-auth-challenge",
  session: "remote-auth-session",
  device: "remote-auth-device",
  signOut: "remote-auth-sign-out",
  rotateKey: "remote-auth-rotate-key",
  revokeSelf: "remote-auth-revoke-self",
  pushToken: "remote-auth-push-token",
} as const;

const SELF_SERVICE_ROUTE_IDS: ReadonlySet<string> = new Set([
  REMOTE_AUTH_ROUTE_IDS.signOut,
  REMOTE_AUTH_ROUTE_IDS.rotateKey,
  REMOTE_AUTH_ROUTE_IDS.revokeSelf,
]);

const PUSH_TOKEN_ROUTE_IDS: ReadonlySet<string> = new Set([REMOTE_AUTH_ROUTE_IDS.pushToken]);

const CLEARING_COOKIE = `${REMOTE_SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0`;

export interface RemoteSelfServiceReceipt {
  readonly commandId: string;
  readonly result: "applied" | "already-applied";
  readonly occurredAt: string;
  readonly cancellation?: { canceled: number; cancelHookFailures: number };
}

export interface RemoteCredentialSelfServicePort {
  readonly readOwnDevice?: (input: {
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly credentialGeneration: number;
    readonly sessionIdleExpiresAt?: string;
    readonly sessionAbsoluteExpiresAt?: string;
  }) => ReturnType<typeof decodeRemoteOwnDeviceMetadataV1>;
  readonly signOut: (input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly sessionIdDigest: string;
  }) => RemoteSelfServiceReceipt;
  readonly selfRotateDevice: (input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly credentialGeneration: number;
    readonly newDeviceKeyFingerprint: string;
    readonly newDevicePublicKey: string;
    readonly newKeyProof: string;
  }) => RemoteSelfServiceReceipt;
  readonly selfRevokeDevice: (input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId: string;
  }) => RemoteSelfServiceReceipt;
}

interface RemoteCredentialServiceError {
  readonly category: "invalid" | "not-found" | "conflict";
}

const MAX_COOKIE_HEADER_LENGTH = 4_096;
const MAX_BODY_BYTES = 8_192;
const MAX_AUTHENTICATED_BODY_BYTES = 1_048_576;
const MAX_PROOF_HEADER_LENGTH = 8_192;
const MAX_PROOF_JSON_BYTES = 6_144;
const MAX_CSRF_LENGTH = 128;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const COMMAND_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const BODY_CONTENT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/octet-stream",
]);

export interface RequestTransportFacts {
  readonly listenerTrust: "loopback" | "remote";
  readonly sourceClass: "loopback" | "lan-private" | "tailscale" | "unknown";
  readonly sourceKey: string;
}

export interface RemoteVerifiedRequestFacts {
  readonly method: string;
  readonly canonicalPathQuery: string;
  readonly bodyDigest: string;
  readonly commandId?: string;
  readonly transport: RequestTransportFacts;
}

export interface RemoteAdmissionPort {
  readonly acquire: (input: {
    readonly bucket: "auth" | "product";
    readonly deviceId?: string;
    readonly transport: RequestTransportFacts;
  }) => (() => void) | undefined;
}

export interface RemoteRequestRegistrationPort {
  readonly hostId: string;
  readonly deviceId: string;
  readonly sessionIdDigest: string;
  readonly cancel: () => void;
}

export interface RemoteRequestRegistryPort {
  readonly register: (input: RemoteRequestRegistrationPort) => () => void;
  readonly cancelBySession: (sessionIdDigest: string) => {
    canceled: number;
    cancelHookFailures: number;
  };
  readonly cancelByDevice: (input: { readonly hostId: string; readonly deviceId: string }) => {
    canceled: number;
    cancelHookFailures: number;
  };
  readonly cancelAll: () => { canceled: number; cancelHookFailures: number };
  readonly size: () => number;
}

export interface RemoteSessionRevalidationPort {
  readonly isSessionActive: (sessionId: string) => boolean;
}

export interface RemoteClientPrincipalHandoff {
  readonly request: Request;
  readonly principal: RemoteClientPrincipal;
  readonly freshness: "current" | "rotation-due";
  readonly requestFacts: RemoteVerifiedRequestFacts;
  /**
   * S1: The combined abort signal (client-disconnect + registry cancellation)
   * that the product handler must observe. When this signal aborts, the handler
   * must stop work immediately — a revoke/rotate has invalidated the session.
   */
  readonly abortSignal?: AbortSignal;
}

export interface RemoteHttpAuthenticationOptions {
  readonly proofService: RemoteRequestProofService;
  readonly signNegotiationMetadata: (payload: string) => string;
  readonly admission?: RemoteAdmissionPort;
  readonly credentialSelfService?: RemoteCredentialSelfServicePort;
  readonly pushTokenStore?: PushNotificationTokenStore;
  readonly requestRegistry?: RemoteRequestRegistryPort;
  readonly sessionRevalidation?: RemoteSessionRevalidationPort;
  readonly productDispatch?: (
    handoff: RemoteClientPrincipalHandoff,
  ) => Promise<Response | undefined>;
}

export interface RemoteHttpAuthentication {
  readonly handlePreAuthRoute: (
    request: Request,
    route: RemoteRouteDefinition,
    transport: RequestTransportFacts,
  ) => Promise<Response | undefined>;
  readonly handleAuthenticated: (
    request: Request,
    transport: RequestTransportFacts,
    route?: RemoteRouteDefinition,
  ) => Promise<Response>;
}

type RemoteAuthFailureCategory =
  | "invalid"
  | "unauthorized"
  | "rate-limited"
  | "unavailable"
  | "too-large";

class RemoteHttpAuthFailure extends Error {
  readonly status: number;
  readonly category: RemoteAuthFailureCategory;
  readonly clearSession: boolean;
  readonly reasonCode: "expired" | "revoked" | undefined;

  constructor(
    status: number,
    category: RemoteAuthFailureCategory,
    clearSession = false,
    reasonCode?: "expired" | "revoked",
  ) {
    super("Remote request rejected.");
    this.name = "RemoteHttpAuthFailure";
    this.status = status;
    this.category = category;
    this.clearSession = clearSession;
    this.reasonCode = reasonCode;
  }
}

export function createRemoteHttpAuthentication(
  options: RemoteHttpAuthenticationOptions,
): RemoteHttpAuthentication {
  // S1: In a production-capable configuration (productDispatch exists), the
  // registry and authoritative session revalidation must both be wired. Without
  // the registry, cancellation cannot reach in-flight work. Without revalidation,
  // the verify-vs-revoke TOCTOU is open. Fail construction closed if incomplete.
  if (options.productDispatch !== undefined) {
    if (options.requestRegistry === undefined) {
      throw new Error(
        "Remote HTTP authentication requires a request registry when product dispatch is configured.",
      );
    }
    if (options.sessionRevalidation === undefined) {
      throw new Error(
        "Remote HTTP authentication requires session revalidation when product dispatch is configured.",
      );
    }
  }

  const handleChallenge = async (body: RemoteChallengeRequestV1): Promise<Response> => {
    // Lifecycle state is local security-panel information. Keep the unauthenticated
    // challenge surface generic so a remote caller cannot enumerate device state.
    const challenge = issueWithServiceErrors(() => options.proofService.issueChallenge(body), {
      exposeLifecycleReason: false,
    });
    return jsonResponse(200, challenge);
  };

  const handleSession = async (body: RemoteSessionRequestV1): Promise<Response> => {
    const issued = issueWithServiceErrors(() => options.proofService.issueSession(body), {
      exposeLifecycleReason: false,
    });
    const response = decodeRemoteSessionResponseV1({
      hostId: issued.hostId,
      deviceId: issued.deviceId,
      sessionId: issued.sessionId,
      credentialGeneration: issued.credentialGeneration,
      origin: issued.origin,
      protocolVersion: issued.protocolVersion,
      authenticationVersion: issued.authenticationVersion,
      capabilityDigest: issued.capabilityDigest,
      issuedAt: issued.issuedAt,
      idleExpiresAt: issued.idleExpiresAt,
      absoluteExpiresAt: issued.absoluteExpiresAt,
      csrfToken: issued.csrfToken,
      negotiationSignature: options.signNegotiationMetadata(
        buildRemoteSessionMetadataPayload({
          hostId: issued.hostId,
          deviceId: issued.deviceId,
          credentialGeneration: issued.credentialGeneration,
          origin: issued.origin,
          protocolVersion: issued.protocolVersion,
          authenticationVersion: issued.authenticationVersion,
          capabilityDigest: issued.capabilityDigest,
          issuedAt: issued.issuedAt,
          idleExpiresAt: issued.idleExpiresAt,
          absoluteExpiresAt: issued.absoluteExpiresAt,
        }),
      ),
    });
    return jsonResponse(200, response, {
      "set-cookie": `${REMOTE_SESSION_COOKIE}=${issued.sessionId}; Secure; HttpOnly; SameSite=Strict; Path=/api/`,
    });
  };

  const handlePreAuthRoute = async (
    request: Request,
    route: RemoteRouteDefinition,
    transport: RequestTransportFacts,
  ): Promise<Response | undefined> => {
    if (route.id !== REMOTE_AUTH_ROUTE_IDS.challenge && route.id !== REMOTE_AUTH_ROUTE_IDS.session)
      return undefined;
    let release: (() => void) | undefined;
    try {
      const facts = requireTransportFacts(transport);
      if (route.id === REMOTE_AUTH_ROUTE_IDS.challenge) {
        const body = decodeBounded(decodeRemoteChallengeRequestV1, await readJsonBody(request));
        release = options.admission?.acquire({
          bucket: "auth",
          deviceId: body.deviceId,
          transport: facts,
        });
        if (options.admission !== undefined && release === undefined) {
          throw new RemoteHttpAuthFailure(429, "rate-limited");
        }
        return await handleChallenge(body);
      }
      const body = decodeBounded(decodeRemoteSessionRequestV1, await readJsonBody(request));
      release = options.admission?.acquire({
        bucket: "auth",
        deviceId: body.deviceId,
        transport: facts,
      });
      if (options.admission !== undefined && release === undefined) {
        throw new RemoteHttpAuthFailure(429, "rate-limited");
      }
      return await handleSession(body);
    } catch (error) {
      return mapFailure(error);
    } finally {
      release?.();
    }
  };

  const handleAuthenticated = async (
    request: Request,
    transport: RequestTransportFacts,
    route?: RemoteRouteDefinition,
  ): Promise<Response> => {
    let admissionRelease: (() => void) | undefined;
    let registryRelease: (() => void) | undefined;
    try {
      const facts = requireTransportFacts(transport);
      const sessionId = readSessionCookie(request.headers);
      const sessionFacts = options.proofService.describeSession(sessionId);
      if (sessionFacts === undefined) {
        throw new RemoteHttpAuthFailure(401, "unauthorized", true);
      }
      admissionRelease = options.admission?.acquire({
        bucket: "product",
        deviceId: sessionFacts.deviceId,
        transport: facts,
      });
      if (options.admission !== undefined && admissionRelease === undefined) {
        throw new RemoteHttpAuthFailure(429, "rate-limited");
      }
      const handoff = await authenticateRequest(request, sessionId, sessionFacts, facts, options);

      // S1: Create the registry abort controller before registration. The
      // combined signal merges client-disconnect (request.signal) with the
      // registry cancellation so revoke/rotate during an in-flight dispatch
      // aborts the handler synchronously, not just the response stream.
      const registryAbort = new AbortController();
      const sessionIdDigest = sha256Hex(sessionId);
      const isSelfServiceRoute = route !== undefined && SELF_SERVICE_ROUTE_IDS.has(route.id);
      const isOwnDeviceRoute = route?.id === REMOTE_AUTH_ROUTE_IDS.device;
      const isPushTokenRoute = route !== undefined && PUSH_TOKEN_ROUTE_IDS.has(route.id);

      if (options.requestRegistry !== undefined && handoff.principal.kind === "remote-device") {
        const remotePrincipal = handoff.principal;
        try {
          registryRelease = options.requestRegistry.register({
            hostId: remotePrincipal.hostId,
            deviceId: remotePrincipal.deviceId,
            sessionIdDigest,
            cancel: () => registryAbort.abort(),
          });
        } catch {
          // Registry capacity exhausted — fail closed.
          throw new RemoteHttpAuthFailure(503, "unavailable");
        }
      }

      // F2: Revalidate the session immediately before dispatch/effect to close
      // the verify-vs-revoke TOCTOU. A session revoked between proof verification
      // and registration/dispatch must not escape cancellation.
      if (options.sessionRevalidation !== undefined) {
        if (!options.sessionRevalidation.isSessionActive(sessionId)) {
          registryRelease?.();
          registryRelease = undefined;
          throw new RemoteHttpAuthFailure(401, "unauthorized", true);
        }
      }

      if (isOwnDeviceRoute) {
        const response = await handleOwnDeviceRoute(handoff, options);
        registryRelease?.();
        registryRelease = undefined;
        return response;
      }

      if (isPushTokenRoute) {
        const response = await handlePushTokenRoute(handoff, route!, options);
        registryRelease?.();
        registryRelease = undefined;
        return response;
      }

      if (isSelfServiceRoute) {
        const response = await handleSelfServiceRoute(
          handoff,
          route!,
          sessionId,
          options,
          registryAbort.signal,
        );
        // Self-service responses are non-streaming; release immediately.
        registryRelease?.();
        registryRelease = undefined;
        return response;
      }
      if (options.productDispatch === undefined) {
        throw new RemoteHttpAuthFailure(503, "unavailable");
      }
      // S1: Bind the combined client-disconnect + registry abort signal into
      // the handoff request before dispatch. The handler observes this signal
      // and must stop work when it aborts.
      const combinedSignal = combineAbortSignals(request.signal, registryAbort.signal);
      const dispatchHandoff: RemoteClientPrincipalHandoff = {
        ...handoff,
        request: bindAbortSignal(handoff.request, combinedSignal),
        abortSignal: combinedSignal,
      };
      const response = await options.productDispatch(dispatchHandoff);
      if (response === undefined) throw new RemoteHttpAuthFailure(503, "unavailable");

      // Release the registry entry only after the response body stream closes,
      // errors, or completes. For non-streaming responses (null/locked body),
      // release immediately.
      return withNoStore(wrapResponseForRegistryRelease(response, registryRelease, registryAbort));
    } catch (error) {
      registryRelease?.();
      registryRelease = undefined;
      return mapFailure(error);
    } finally {
      admissionRelease?.();
    }
  };

  return { handlePreAuthRoute, handleAuthenticated };
}

async function handleOwnDeviceRoute(
  handoff: RemoteClientPrincipalHandoff,
  options: RemoteHttpAuthenticationOptions,
): Promise<Response> {
  const service = options.credentialSelfService;
  const readOwnDevice = service?.readOwnDevice;
  if (readOwnDevice === undefined) throw new RemoteHttpAuthFailure(503, "unavailable");
  const principal = handoff.principal;
  if (principal.kind !== "remote-device") {
    throw new RemoteHttpAuthFailure(403, "invalid");
  }
  const session = options.proofService.describeSession(
    readSessionCookie(handoff.request.headers) ?? "",
  );
  try {
    const metadata = issueWithServiceErrors(() =>
      readOwnDevice({
        hostId: principal.hostId,
        deviceId: principal.deviceId,
        credentialGeneration: principal.credentialGeneration,
        ...(session === undefined
          ? {}
          : {
              sessionIdleExpiresAt: session.idleExpiresAt,
              sessionAbsoluteExpiresAt: session.absoluteExpiresAt,
            }),
      }),
    );
    return jsonResponse(200, metadata);
  } catch (error) {
    throw mapCredentialServiceError(error);
  }
}

async function handlePushTokenRoute(
  handoff: RemoteClientPrincipalHandoff,
  route: RemoteRouteDefinition,
  options: RemoteHttpAuthenticationOptions,
): Promise<Response> {
  const store = options.pushTokenStore;
  if (store === undefined) throw new RemoteHttpAuthFailure(503, "unavailable");
  if (handoff.principal.kind !== "remote-device") {
    throw new RemoteHttpAuthFailure(403, "invalid");
  }
  const { hostId, deviceId } = handoff.principal;
  const occurredAt = new Date().toISOString();
  if (handoff.request.method === "PUT") {
    const body = decodeBounded(
      decodeRemotePushTokenRegistrationV1,
      await readJsonObject(handoff.request),
    );
    const outcome = store.register({
      hostId,
      deviceId,
      platform: body.platform,
      token: body.token,
      now: occurredAt,
    });
    return jsonResponse(
      200,
      decodeRemotePushTokenReceiptV1({ result: outcome.result, occurredAt }),
    );
  }
  if (handoff.request.method === "DELETE") {
    decodeBounded(decodeRemotePushTokenClearV1, await readJsonObject(handoff.request));
    const outcome = store.clear({ hostId, deviceId });
    return jsonResponse(
      200,
      decodeRemotePushTokenReceiptV1({ result: outcome.result, occurredAt }),
    );
  }
  void route;
  throw new RemoteHttpAuthFailure(400, "invalid");
}

async function handleSelfServiceRoute(
  handoff: RemoteClientPrincipalHandoff,
  route: RemoteRouteDefinition,
  sessionId: string,
  options: RemoteHttpAuthenticationOptions,
  abortSignal: AbortSignal,
): Promise<Response> {
  const service = options.credentialSelfService;
  if (service === undefined) throw new RemoteHttpAuthFailure(503, "unavailable");
  const commandId = handoff.requestFacts.commandId;
  if (commandId === undefined) throw new RemoteHttpAuthFailure(400, "invalid");
  if (handoff.principal.kind !== "remote-device") {
    throw new RemoteHttpAuthFailure(403, "invalid");
  }
  const { hostId, deviceId, credentialGeneration } = handoff.principal;
  const sessionIdDigest = sha256Hex(sessionId);
  // S3: Clear the cookie on sign-out, revoke, AND rotate — rotation invalidates
  // the current session and the client must re-authenticate with the new key.
  const clearCookie =
    route.id === REMOTE_AUTH_ROUTE_IDS.signOut ||
    route.id === REMOTE_AUTH_ROUTE_IDS.revokeSelf ||
    route.id === REMOTE_AUTH_ROUTE_IDS.rotateKey;
  try {
    let receipt: RemoteSelfServiceReceipt;
    // S3: Track defense-in-depth registry cancellation results separately so
    // they can be aggregated with the lifecycle outcome.
    let defenseResult: { canceled: number; cancelHookFailures: number } = {
      canceled: 0,
      cancelHookFailures: 0,
    };
    if (route.id === REMOTE_AUTH_ROUTE_IDS.signOut) {
      decodeBounded(decodeRemoteSelfServiceEmptyBodyV1, await readJsonObject(handoff.request));
      receipt = service.signOut({ commandId, hostId, deviceId, sessionIdDigest });
      // Defense-in-depth: cancel the registry entry for this session even if
      // the lifecycle service's onSessionsInvalidated callback already did.
      if (options.requestRegistry !== undefined) {
        defenseResult = options.requestRegistry.cancelBySession(sessionIdDigest);
      }
    } else if (route.id === REMOTE_AUTH_ROUTE_IDS.rotateKey) {
      const body = decodeBounded(
        decodeRemoteKeyRotationRequestV1,
        await readJsonObject(handoff.request),
      );
      receipt = service.selfRotateDevice({
        commandId,
        hostId,
        deviceId,
        credentialGeneration,
        newDeviceKeyFingerprint: body.newDeviceKeyFingerprint,
        newDevicePublicKey: body.newDevicePublicKey,
        newKeyProof: body.newKeyProof,
      });
      // Rotation invalidates all sessions for the device.
      if (options.requestRegistry !== undefined) {
        defenseResult = options.requestRegistry.cancelByDevice({ hostId, deviceId });
      }
    } else if (route.id === REMOTE_AUTH_ROUTE_IDS.revokeSelf) {
      decodeBounded(decodeRemoteSelfServiceEmptyBodyV1, await readJsonObject(handoff.request));
      receipt = service.selfRevokeDevice({ commandId, hostId, deviceId });
      // Revocation invalidates all sessions for the device.
      if (options.requestRegistry !== undefined) {
        defenseResult = options.requestRegistry.cancelByDevice({ hostId, deviceId });
      }
    } else {
      throw new RemoteHttpAuthFailure(503, "unavailable");
    }
    // S3: Aggregate lifecycle + defense cancellation outcomes. If any
    // cancellation failed, the work may continue — never imply success.
    const lifecycleFailures = receipt.cancellation?.cancelHookFailures ?? 0;
    const totalFailures = lifecycleFailures + defenseResult.cancelHookFailures;
    if (totalFailures > 0) {
      // The durable action committed but cancellation did not fully reach
      // all in-flight work. Return 503 so the client retries. The cookie is
      // cleared because the durable action invalidated the current session.
      throw new RemoteHttpAuthFailure(503, "unavailable", clearCookie);
    }
    const wire = decodeRemoteSelfServiceReceiptV1({
      commandId: receipt.commandId,
      result: receipt.result,
      occurredAt: receipt.occurredAt,
    });
    return jsonResponse(200, wire, clearCookie ? { "set-cookie": CLEARING_COOKIE } : {});
  } catch (error) {
    // S3: If the error is already a RemoteHttpAuthFailure with clearCookie,
    // propagate it as-is so the cookie clearing header survives.
    if (error instanceof RemoteHttpAuthFailure && error.clearSession) {
      throw error;
    }
    throw mapCredentialServiceError(error);
  }
}

function mapCredentialServiceError(error: unknown): RemoteHttpAuthFailure {
  if (error instanceof RemoteHttpAuthFailure) return error;
  const category = (error as Partial<RemoteCredentialServiceError> | null)?.category;
  if (category === "invalid") return new RemoteHttpAuthFailure(400, "invalid");
  if (category === "not-found") return new RemoteHttpAuthFailure(401, "unauthorized", true);
  if (category === "conflict") return new RemoteHttpAuthFailure(409, "invalid");
  return new RemoteHttpAuthFailure(503, "unavailable");
}

/**
 * S1: Combines multiple abort signals into one. If any source signal aborts,
 * the combined signal aborts synchronously. This merges client-disconnect
 * (request.signal) with registry cancellation so the product handler sees a
 * single signal that fires on either event.
 */
function combineAbortSignals(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal === undefined) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * S1: Returns a new Request with the given abort signal bound. The fetch
 * runtime observes request.signal for cancellation; binding the combined
 * signal ensures the handler's downstream work (fetch calls, etc.) aborts
 * when the registry or client disconnects.
 */
function bindAbortSignal(request: Request, signal: AbortSignal): Request {
  // If the request already has the same signal, no-op.
  if (request.signal === signal) return request;
  return new Request(request, { signal });
}

/**
 * B4: Wraps a product dispatch response so the registry entry is released only
 * after the body stream closes, errors, completes, or is canceled. For
 * non-streaming responses (null/locked body), release is immediate.
 *
 * Cancellation authority: the AbortController signal (fired by the registry
 * cancel hook) is the authoritative cancellation signal. When it fires, the
 * wrapper errors the stream (preventing further client bytes) and releases
 * the registry entry exactly once. The underlying `source.cancel()` call is
 * best-effort — it tells the upstream body to stop producing bytes, but its
 * completion or rejection is NOT observable to the registry or lifecycle
 * service. The registry hook only knows that `AbortController.abort()` was
 * called, which is the truthful cancellation boundary.
 */
function wrapResponseForRegistryRelease(
  response: Response,
  registryRelease: (() => void) | undefined,
  abortController: AbortController,
): Response {
  if (registryRelease === undefined) return response;
  const body = response.body;
  // No body or already-locked body: release immediately.
  if (body === null || body.locked) {
    registryRelease();
    return response;
  }
  const release = registryRelease;
  let released = false;
  const doRelease = (): void => {
    if (released) return;
    released = true;
    release();
  };
  // Build a new ReadableStream that reads from the original body, checks the
  // abort signal on each chunk, and releases the registry entry on
  // completion, error, or cancellation.
  const source = body.getReader();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const wrapped = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      if (abortController.signal.aborted) {
        controller.error(new Error("Request canceled."));
        doRelease();
        return;
      }
      try {
        const { done, value } = await source.read();
        if (done) {
          controller.close();
          doRelease();
          return;
        }
        if (abortController.signal.aborted) {
          controller.error(new Error("Request canceled."));
          doRelease();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        doRelease();
      }
    },
    cancel() {
      // B4: Consumer cancellation — best-effort upstream cancel. The
      // authoritative cancellation signal is the AbortController, which the
      // registry hook fires. Release exactly once regardless of upstream
      // cancel outcome.
      source.cancel("Request canceled.").catch(() => {});
      doRelease();
    },
  });
  // B4: Proactively error the stream when the abort signal fires, even if
  // the consumer is not actively pulling. This prevents further client bytes.
  // The authoritative cancellation is the abort signal itself; source.cancel()
  // is best-effort and its rejection is not surfaced to the registry.
  abortController.signal.addEventListener(
    "abort",
    () => {
      source.cancel("Request canceled.").catch(() => {});
      try {
        streamController?.error(new Error("Request canceled."));
      } catch {
        // Controller may already be closed/errored.
      }
      doRelease();
    },
    { once: true },
  );
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readJsonObject(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
}

async function authenticateRequest(
  request: Request,
  sessionId: string,
  sessionFacts: RemoteSessionFacts,
  transport: RequestTransportFacts,
  options: RemoteHttpAuthenticationOptions,
): Promise<RemoteClientPrincipalHandoff> {
  const method = request.method.toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(method)) throw new RemoteHttpAuthFailure(400, "invalid");
  const safe = SAFE_METHODS.has(method);

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== sessionFacts.origin) {
    throw new RemoteHttpAuthFailure(401, "unauthorized");
  }
  if (!safe && origin !== sessionFacts.origin) {
    throw new RemoteHttpAuthFailure(401, "unauthorized");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!safe && fetchSite !== "same-origin") {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
  if (safe && fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }

  const url = new URL(request.url);
  const canonicalPathQuery = canonicalizeRemotePathQuery(`${url.pathname}${url.search}`);
  if (canonicalPathQuery === undefined || canonicalPathQuery !== `${url.pathname}${url.search}`) {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }

  const envelope = decodeProofEnvelope(request.headers);

  let csrfDigest: string | undefined;
  let commandId: string | undefined;
  if (!safe) {
    const csrf = boundedHeader(request.headers, "x-octant-csrf", {
      maxLength: MAX_CSRF_LENGTH,
      pattern: BASE64URL_PATTERN,
      missingStatus: 401,
    });
    csrfDigest = sha256Hex(csrf);
    const commandIdHeader = request.headers.get("x-octant-command-id");
    if (commandIdHeader === null || !COMMAND_ID_PATTERN.test(commandIdHeader)) {
      throw new RemoteHttpAuthFailure(400, "invalid");
    }
    commandId = commandIdHeader;
  }

  const body = await readBoundedBody(
    request,
    safe ? 0 : MAX_AUTHENTICATED_BODY_BYTES,
    safe ? 400 : 413,
  );
  if (safe && body.byteLength > 0) throw new RemoteHttpAuthFailure(400, "invalid");
  if (!safe) {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType === undefined || !BODY_CONTENT_TYPES.has(contentType)) {
      throw new RemoteHttpAuthFailure(400, "invalid");
    }
  }

  const bodyDigest = sha256Hex(body);
  if (
    envelope.method !== method ||
    envelope.canonicalPathQuery !== canonicalPathQuery ||
    envelope.bodyDigest !== bodyDigest ||
    envelope.csrfDigest !== csrfDigest
  ) {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }

  const result = issueWithServiceErrors(() =>
    options.proofService.verifyRequest({
      hostId: sessionFacts.hostId,
      deviceId: sessionFacts.deviceId,
      sessionId,
      credentialGeneration: sessionFacts.credentialGeneration,
      origin: sessionFacts.origin,
      protocolVersion: sessionFacts.protocolVersion,
      proof: {
        method,
        canonicalPathQuery,
        bodyDigest,
        ...(csrfDigest === undefined ? {} : { csrfDigest }),
        timestamp: envelope.timestamp,
        nonce: envelope.nonce,
        signature: envelope.signature,
      },
    }),
  );

  const principal: RemoteClientPrincipal = {
    kind: "remote-device",
    hostId: result.hostId,
    deviceId: result.deviceId,
    credentialGeneration: result.credentialGeneration,
    origin: result.origin,
    protocolVersion: result.protocolVersion,
    capabilityDigest: sessionFacts.capabilityDigest,
    sessionId: result.sessionId,
  };
  const requestFacts: RemoteVerifiedRequestFacts = Object.freeze({
    method,
    canonicalPathQuery,
    bodyDigest,
    ...(commandId === undefined ? {} : { commandId }),
    transport,
  });
  // Safe methods never carry a body (rejected above), so a body built from the
  // hashed bytes always accompanies a method that permits one; unsafe methods
  // keep a non-null stream even when the prepared body is zero-length.
  const forwardInit: RequestInit = { headers: strippedHeaders(request.headers) };
  if (!safe) forwardInit.body = body as BodyInit;
  const forwarded = new Request(request, forwardInit);
  return { request: forwarded, principal, freshness: result.freshness, requestFacts };
}

const SOURCE_CLASSES: ReadonlySet<string> = new Set(["loopback", "lan-private", "tailscale"]);
const SOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function requireTransportFacts(input: unknown): RequestTransportFacts {
  const candidate = input as Partial<RequestTransportFacts> | null | undefined;
  if (
    candidate === null ||
    candidate === undefined ||
    candidate.listenerTrust !== "remote" ||
    typeof candidate.sourceClass !== "string" ||
    !SOURCE_CLASSES.has(candidate.sourceClass) ||
    typeof candidate.sourceKey !== "string" ||
    !SOURCE_KEY_PATTERN.test(candidate.sourceKey)
  ) {
    throw new RemoteHttpAuthFailure(503, "unavailable");
  }
  return Object.freeze({
    listenerTrust: candidate.listenerTrust,
    sourceClass: candidate.sourceClass,
    sourceKey: candidate.sourceKey,
  });
}

const STRIPPED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "cookie",
  "x-octant-device-proof",
  "x-octant-csrf",
  "origin",
  "authorization",
  "proxy-authorization",
  "forwarded",
  "x-real-ip",
  "x-client-cert",
  "x-forwarded-client-cert",
  "ssl-client-cert",
]);

function strippedHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (
      STRIPPED_HEADER_NAMES.has(normalized) ||
      normalized.startsWith("sec-fetch-") ||
      normalized.startsWith("x-forwarded-")
    ) {
      continue;
    }
    result.set(name, value);
  }
  return result;
}

function decodeProofEnvelope(headers: Headers): RemoteRequestProofV1 {
  const raw = headers.get("x-octant-device-proof");
  if (raw === null) throw new RemoteHttpAuthFailure(401, "unauthorized");
  if (raw.length === 0 || raw.length > MAX_PROOF_HEADER_LENGTH || !BASE64URL_PATTERN.test(raw)) {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64url");
  } catch {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
  if (
    bytes.length === 0 ||
    bytes.length > MAX_PROOF_JSON_BYTES ||
    bytes.toString("base64url") !== raw
  ) {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
  try {
    return decodeRemoteRequestProofV1(parsed);
  } catch {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
}

function readSessionCookie(headers: Headers): string {
  const header = headers.get("cookie");
  if (header === null) throw new RemoteHttpAuthFailure(401, "unauthorized");
  if (header.length > MAX_COOKIE_HEADER_LENGTH) {
    throw new RemoteHttpAuthFailure(400, "invalid", true);
  }
  let value: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== REMOTE_SESSION_COOKIE) continue;
    if (value !== undefined) throw new RemoteHttpAuthFailure(400, "invalid", true);
    value = part.slice(separator + 1).trim();
  }
  if (value === undefined || value === "") throw new RemoteHttpAuthFailure(401, "unauthorized");
  return value;
}

function boundedHeader(
  headers: Headers,
  name: string,
  options: {
    readonly maxLength: number;
    readonly pattern?: RegExp;
    readonly missingStatus: 400 | 401;
  },
): string {
  const value = headers.get(name);
  if (value === null) throw new RemoteHttpAuthFailure(options.missingStatus, "unauthorized");
  if (
    value.length === 0 ||
    value.length > options.maxLength ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
  return value;
}

function readJsonBody(request: Request): Promise<unknown> {
  return readBoundedBody(request, MAX_BODY_BYTES, 400).then((body) => {
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new RemoteHttpAuthFailure(400, "invalid");
    }
  });
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
  overLimitStatus: 400 | 413,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared)) {
      throw new RemoteHttpAuthFailure(400, "invalid");
    }
    const parsed = Number.parseInt(declared, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new RemoteHttpAuthFailure(overLimitStatus, "too-large");
    }
  }
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        overflow = true;
        break;
      }
      chunks.push(value);
    }
  } catch {
    // Release authority synchronously; cancel the upstream stream best-effort
    // so a hostile never-settling cancel() cannot hold the HTTP response.
    void reader.cancel().catch(() => undefined);
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
  if (overflow) {
    void reader.cancel().catch(() => undefined);
    throw new RemoteHttpAuthFailure(overLimitStatus, "too-large");
  }
  reader.releaseLock();
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeBounded<T>(decode: (input: unknown) => T, input: unknown): T {
  try {
    return decode(input);
  } catch {
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
}

function issueWithServiceErrors<T>(
  run: () => T,
  options: { readonly exposeLifecycleReason?: boolean } = {},
): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RemoteRequestProofError) {
      throw new RemoteHttpAuthFailure(
        error.category === "unavailable" ? 503 : 401,
        error.category === "unavailable" ? "unavailable" : "unauthorized",
        error.category === "expired",
        options.exposeLifecycleReason === false ? undefined : error.reasonCode,
      );
    }
    throw new RemoteHttpAuthFailure(400, "invalid");
  }
}

function mapFailure(error: unknown): Response {
  if (error instanceof RemoteHttpAuthFailure) {
    return failureResponse(error.status, error.category, error.clearSession, error.reasonCode);
  }
  return failureResponse(503, "unavailable");
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extraHeaders },
  });
}

function failureResponse(
  status: number,
  category: RemoteAuthFailureCategory,
  clearSession = false,
  reasonCode?: "expired" | "revoked",
): Response {
  return jsonResponse(
    status,
    {
      product: "Octant",
      status: "rejected",
      category,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      message: "Remote request rejected.",
    },
    {
      ...(category === "rate-limited" ? { "retry-after": "60" } : {}),
      ...(clearSession
        ? {
            "set-cookie": `${REMOTE_SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0`,
          }
        : {}),
    },
  );
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
