import type { RemoteClientPrincipal, WindowId } from "@octant/contracts";
import type {
  DeviceAccessLevel,
  DeviceId,
  RemoteSessionId,
  StableHostId,
} from "@octant/contracts/remote-access";
import {
  actsAsHostPerson,
  admittedDeviceAuthorityKind,
  type PrincipalKind,
} from "@octant/domain/remote-access-policy";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

export const WINDOW_CAPABILITY_HEADER = "x-octant-window-capability";

export type ClientPrincipal = RemoteClientPrincipal;

/**
 * The authority class a principal is judged by. A device the host's own person
 * paired at Full is that person and is judged as a local window is; every
 * other device session (one the person paired at a narrower level,
 * hub-introduced, an agent grant, an unproved pairing) keeps the restricted
 * `remote-device` class. The principal itself is unchanged, so the device
 * stays the recorded actor.
 */
export function principalAuthorityKind(principal: ClientPrincipal): PrincipalKind {
  if (principal.kind === "local-window") return "local-window";
  return admittedDeviceAuthorityKind(principal);
}

/** The narrower level a device the person paired is held to, absent at Full and for every other principal. */
export function principalAccessLevel(
  principal: ClientPrincipal,
): Exclude<DeviceAccessLevel, "full"> | undefined {
  return principal.kind === "remote-device" && principal.admittedBy === "host-person"
    ? principal.accessLevel
    : undefined;
}

/** Whether the request comes from the host's own person: a local window or a device they paired. */
export function principalActsAsHostPerson(principal: ClientPrincipal): boolean {
  return actsAsHostPerson(principalAuthorityKind(principal));
}

/**
 * The origin an agent grant's session carries. It is not an HTTPS origin, so
 * no paired device's session can carry it.
 */
export const AGENT_ACCESS_ORIGIN = "octant-agent-access";

/**
 * Whether the principal is an agent grant's session. Its requests passed the
 * grant's own closed list before the product routes saw them, including the
 * level the person chose for that grant.
 */
export function isAgentGrantSession(principal: ClientPrincipal): boolean {
  return principal.kind === "remote-device" && principal.origin === AGENT_ACCESS_ORIGIN;
}

/**
 * Whether the principal is a device only the hub introduced: a device session
 * this host's own person did not pair and that is no agent grant's. While this
 * host is in a hub, such a device acts only within the member's Act item. A
 * session that carries no pairing proof counts, so an unproved pairing is held
 * to the item too. This is who let the device on, not what it may do: a
 * device the person paired at a narrower level is not the person, but it is
 * not the hub's either, so the hub's Act item never holds it.
 */
export function principalIsHubIntroduced(principal: ClientPrincipal): boolean {
  return (
    principal.kind === "remote-device" &&
    principal.admittedBy !== "host-person" &&
    !isAgentGrantSession(principal)
  );
}

export type ClientPrincipalErrorCategory = "invalid" | "unauthorized" | "conflict" | "unavailable";

export class ClientPrincipalError extends Error {
  override readonly name = "ClientPrincipalError";

  constructor(
    readonly category: ClientPrincipalErrorCategory,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolveLocalWindowPrincipalInput {
  readonly request: Request;
  readonly store: WindowAuthorityStore;
  readonly now: number;
  readonly body?: unknown;
  /**
   * Local desktop principals currently do not carry a durable generation counter
   * on the wire. Callers may supply one when a future capability-generation
   * scheme is available; default is 0 for the current registration epoch.
   */
  readonly capabilityGeneration?: number;
}

/**
 * Resolve the authenticated local-window principal from the window-capability
 * header only. Request bodies and query strings cannot supply window identity.
 */
export function resolveLocalWindowPrincipal(
  input: ResolveLocalWindowPrincipalInput,
): Extract<ClientPrincipal, { kind: "local-window" }> {
  assertNoPrincipalIdentityInPayload(input.request, input.body);
  const capability = input.request.headers.get(WINDOW_CAPABILITY_HEADER) ?? "";
  let authority: ReturnType<WindowAuthorityStore["authenticateAuthority"]>;
  try {
    authority = input.store.authenticateAuthority(capability, input.now);
  } catch (error) {
    if (error instanceof WindowAuthorityError) {
      throw new ClientPrincipalError(
        error.category === "invalid" ? "invalid" : "unauthorized",
        error.message,
      );
    }
    throw error;
  }
  return Object.freeze({
    kind: "local-window",
    windowId: String(authority.windowId),
    capabilityGeneration: authority.generation ?? input.capabilityGeneration ?? 0,
  });
}

export interface CreateRemoteDevicePrincipalInput {
  readonly hostId: StableHostId;
  readonly deviceId: DeviceId;
  readonly credentialGeneration: number;
  readonly origin: string;
  readonly protocolVersion: number;
  readonly capabilityDigest: string;
  readonly sessionId: RemoteSessionId;
  readonly admittedBy?: "host-person" | "hub-roster";
  /** A device the person paired below Full; ignored for any other admission. */
  readonly accessLevel?: DeviceAccessLevel;
}

/**
 * Normalize an already-authenticated remote device session into the shared
 * principal shape. This never upgrades to local-window.
 */
export function createRemoteDevicePrincipal(
  input: CreateRemoteDevicePrincipalInput,
): Extract<ClientPrincipal, { kind: "remote-device" }> {
  if (input.credentialGeneration < 0 || !Number.isSafeInteger(input.credentialGeneration)) {
    throw new ClientPrincipalError("invalid", "Remote credential generation is invalid.");
  }
  if (input.protocolVersion < 1 || !Number.isSafeInteger(input.protocolVersion)) {
    throw new ClientPrincipalError("invalid", "Remote protocol version is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.capabilityDigest)) {
    throw new ClientPrincipalError("invalid", "Remote capability digest is invalid.");
  }
  if (typeof input.origin !== "string" || input.origin.length === 0) {
    throw new ClientPrincipalError("invalid", "Remote origin is invalid.");
  }
  // Fail closed if a caller tries to smuggle local-window fields.
  const principal = Object.freeze({
    kind: "remote-device" as const,
    hostId: input.hostId,
    deviceId: input.deviceId,
    credentialGeneration: input.credentialGeneration,
    origin: input.origin,
    protocolVersion: input.protocolVersion,
    capabilityDigest: input.capabilityDigest,
    sessionId: input.sessionId,
    ...(input.admittedBy === undefined ? {} : { admittedBy: input.admittedBy }),
    // Only a narrower level is marked, so a Full device's principal is the one
    // every route already knows.
    ...(input.admittedBy !== "host-person" ||
    input.accessLevel === undefined ||
    input.accessLevel === "full"
      ? {}
      : { accessLevel: input.accessLevel }),
  });
  if (JSON.stringify(principal).includes("local-window")) {
    throw new ClientPrincipalError("invalid", "Remote principal cannot include local-window.");
  }
  return principal;
}

export type ResolveAuthenticatedPrincipalInput =
  | ({ readonly kind: "local-window" } & ResolveLocalWindowPrincipalInput)
  | ({ readonly kind: "remote-device" } & CreateRemoteDevicePrincipalInput);

/**
 * Single entry for authenticated handlers: construct exactly one principal and
 * never mix local/remote identity materials.
 */
export function resolveAuthenticatedPrincipal(
  input: ResolveAuthenticatedPrincipalInput,
): ClientPrincipal {
  if (input.kind === "local-window") {
    // Remote session cookies must not affect local-window resolution.
    const cookie = input.request.headers.get("cookie") ?? "";
    if (cookie.toLowerCase().includes("octant-remote-session")) {
      throw new ClientPrincipalError(
        "invalid",
        "Local-window requests cannot carry remote session cookies.",
      );
    }
    return resolveLocalWindowPrincipal(input);
  }
  return createRemoteDevicePrincipal(input);
}

/**
 * Reject attempts to pass window/device identity through body or query params.
 */
export function assertNoPrincipalIdentityInPayload(request: Request, body?: unknown): void {
  const url = new URL(request.url);
  const forbiddenQuery = ["windowId", "deviceId", "sessionId", "hostId", "capability"];
  for (const key of forbiddenQuery) {
    if (url.searchParams.has(key)) {
      throw new ClientPrincipalError(
        "invalid",
        "Authenticated requests cannot supply principal identity in the query string.",
      );
    }
  }
  if (isRecord(body)) {
    for (const key of forbiddenQuery) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        throw new ClientPrincipalError(
          "invalid",
          "Authenticated requests cannot supply principal identity in the body.",
        );
      }
    }
  }
}

/**
 * Convenience for handlers that still need a WindowId after principal resolution.
 */
export function requireLocalWindowId(principal: ClientPrincipal): WindowId {
  if (principal.kind !== "local-window") {
    throw new ClientPrincipalError(
      "unauthorized",
      "This action requires a local-window principal.",
    );
  }
  return principal.windowId as WindowId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
