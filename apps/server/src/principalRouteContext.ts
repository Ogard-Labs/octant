import { decodeWindowId, type WindowId } from "@octant/contracts";
import {
  assertNoPrincipalIdentityInPayload,
  ClientPrincipalError,
  principalActsAsHostPerson,
  WINDOW_CAPABILITY_HEADER,
  resolveAuthenticatedPrincipal,
  type ClientPrincipal,
} from "./clientPrincipal";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

/**
 * The authority context shared by every authenticated product route.
 *
 * `scopeId` is an internal service scope only. A remote device gets a stable
 * scope derived from its authenticated device identity; it is never returned
 * as a local-window principal and never accepted from request data.
 */
export interface PrincipalRouteContext {
  readonly principal: ClientPrincipal;
  readonly scopeId: WindowId;
  readonly abortSignal?: AbortSignal;
}

export interface ResolvePrincipalRouteContextInput {
  readonly request: Request;
  readonly store?: WindowAuthorityStore;
  readonly now?: number;
  readonly body?: unknown;
  readonly principal?: ClientPrincipal;
  readonly abortSignal?: AbortSignal;
}

const boundContexts = new WeakMap<Request, PrincipalRouteContext>();

/** Bind the already-authenticated transport principal to one request object. */
export function bindPrincipalRouteContext(request: Request, context: PrincipalRouteContext): void {
  boundContexts.set(request, Object.freeze(context));
}

/** Read a context previously bound by the server-owned dispatch boundary. */
export function readPrincipalRouteContext(request: Request): PrincipalRouteContext | undefined {
  return boundContexts.get(request);
}

/**
 * Whether the request's bound principal is held to the remote action
 * catalogue: any device session except a device the host's own person paired.
 * A request with no bound principal reached its handler on the loopback
 * listener, where the window capability the handler checks is the authority.
 */
export function boundPrincipalIsRestricted(request: Request): boolean {
  const principal = boundContexts.get(request)?.principal;
  return principal !== undefined && !principalActsAsHostPerson(principal);
}

/**
 * Retain one original request's identity through asynchronous admission work.
 * Paired authentication supplies the original combined disconnect/registry
 * signal. It is an in-flight request proof, not a persistent paired-turn lease:
 * response completion releases registry tracking under the existing policy.
 */
export function retainRouteAdmissionCurrent(input: {
  readonly request: Request;
  readonly context: PrincipalRouteContext;
  readonly store: WindowAuthorityStore;
  readonly now: () => number;
}): () => boolean {
  const { request, context, store, now } = input;
  const bound = readPrincipalRouteContext(request);
  const capability = request.headers.get(WINDOW_CAPABILITY_HEADER);
  const requestSignal = request.signal;
  const principal = context.principal;
  const scopeId = context.scopeId;
  const lifetime = context.abortSignal;
  return () => {
    if (
      request.signal !== requestSignal ||
      requestSignal.aborted ||
      lifetime?.aborted === true ||
      request.headers.get(WINDOW_CAPABILITY_HEADER) !== capability ||
      readPrincipalRouteContext(request) !== bound ||
      context.principal !== principal ||
      context.scopeId !== scopeId ||
      context.abortSignal !== lifetime
    )
      return false;
    if (principal.kind === "remote-device")
      return (
        bound === context &&
        lifetime !== undefined &&
        String(principal.deviceId) === String(scopeId)
      );
    try {
      return (
        String(store.authenticate(capability ?? "", now())) === String(scopeId) &&
        String(principal.windowId) === String(scopeId)
      );
    } catch {
      return false;
    }
  };
}

/**
 * Resolve one route context. A bound context is authoritative; otherwise the
 * local-window principal is resolved through the shared client-principal
 * adapter. Callers cannot provide a remote identity in a query or body.
 */
export function resolvePrincipalRouteContext(
  input: ResolvePrincipalRouteContextInput,
): PrincipalRouteContext {
  const bound = boundContexts.get(input.request);
  if (bound !== undefined) {
    assertNoPrincipalIdentityInPayload(input.request, input.body);
    return bound;
  }

  if (input.principal !== undefined) {
    assertNoPrincipalIdentityInPayload(input.request, input.body);
    return makeContext(input.principal, input.abortSignal);
  }
  if (input.store === undefined || input.now === undefined) {
    throw new ClientPrincipalError("unavailable", "Authenticated route authority is unavailable.");
  }

  const principal = resolveAuthenticatedPrincipal({
    kind: "local-window",
    request: input.request,
    store: input.store,
    now: input.now,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  return makeContext(principal, input.abortSignal);
}

/**
 * Resolve one route context, translating principal failures into the window
 * authority error shape that existing route handlers already catch. Routes
 * that must distinguish a person at a local window from a paired remote device
 * read `principal.kind` from the returned context.
 */
export function authenticateRoutePrincipal(
  input: ResolvePrincipalRouteContextInput,
): PrincipalRouteContext {
  try {
    return resolvePrincipalRouteContext(input);
  } catch (error) {
    if (error instanceof ClientPrincipalError) {
      throw new WindowAuthorityError(
        error.category === "conflict"
          ? "conflict"
          : error.category === "invalid"
            ? "invalid"
            : "unauthorized",
        error.message,
      );
    }
    throw error;
  }
}

/**
 * Compatibility helper for existing services that still accept a WindowId.
 * The identity has already been resolved by the shared principal context; the
 * helper only exposes its opaque service scope to the legacy service seam.
 */
export function authenticateRouteWindowId(input: ResolvePrincipalRouteContextInput): WindowId {
  return authenticateRoutePrincipal(input).scopeId;
}

function makeContext(
  principal: ClientPrincipal,
  abortSignal: AbortSignal | undefined,
): PrincipalRouteContext {
  const scopeId = principalScopeId(principal);
  return Object.freeze({
    principal,
    scopeId,
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
}

function principalScopeId(principal: ClientPrincipal): WindowId {
  // The local authority store is the source of truth for the authenticated
  // window identity. Keep its opaque value intact here; test stores and
  // embedded callers may use non-UUID identifiers even though the persisted
  // contract normally uses UUIDs.
  if (principal.kind === "local-window") return principal.windowId as WindowId;
  try {
    return decodeWindowId(String(principal.deviceId));
  } catch {
    throw new ClientPrincipalError("invalid", "Remote device identity is invalid.");
  }
}
