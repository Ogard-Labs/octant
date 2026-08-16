import type { RemoteClientPrincipal, WindowId } from "@octant/contracts";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

export const WINDOW_CAPABILITY_HEADER = "x-octant-window-capability";

export type ClientPrincipal = RemoteClientPrincipal;

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
  let windowId: WindowId;
  try {
    windowId = input.store.authenticate(capability, input.now);
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
    windowId: String(windowId),
    capabilityGeneration: input.capabilityGeneration ?? 0,
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
