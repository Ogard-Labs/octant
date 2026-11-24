import { createHash, timingSafeEqual } from "node:crypto";
import type { EventActor } from "@octant/contracts";
import {
  isDeviceAccessLevel,
  type DeviceAccessLevel,
  type DeviceRegistrationV1,
  type PairingDecisionV1,
  type PairingTicketV1,
  type StableHostId,
} from "@octant/contracts/remote-access";
import { authorizeRemoteAccessPause } from "@octant/domain/remote-access-policy";
import type {
  CreatePairingTicketResult,
  PairingClaimResult,
  PairingDeviceLifecycleError,
} from "./pairingDeviceLifecycleService";
import type {
  RemoteCredentialLifecycleError,
  RemoteCredentialOperationReceipt,
} from "../remoteCredentialLifecycleService";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { readPrincipalRouteContext } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 64 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_LABEL_PATTERN = /^(?!.*[\\/])[^\r\n]{1,128}$/;
const REDACTED_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface LocalDeviceInventoryEntry {
  readonly hostId: StableHostId;
  readonly deviceId: string;
  readonly deviceKeyFingerprint: string;
  readonly deviceLabel: string;
  readonly origin: string;
  readonly protocolFloor: number;
  readonly credentialGeneration: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly state: DeviceRegistrationV1["state"];
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface LocalDeviceAdministrationPort {
  readonly createPairingTicket: (input: {
    readonly sourceClass: PairingTicketV1["sourceClass"];
  }) => CreatePairingTicketResult;
  readonly listPendingPairings: () => ReadonlyArray<PairingClaimResult>;
  /**
   * `actor` on a change is the paired device that asked for it, which the
   * journal then names; a change made at the host carries none.
   */
  readonly approvePairing: (input: {
    readonly ticketId: string;
    readonly actor?: EventActor;
    /** Full unless the person picked a narrower level for the new device. */
    readonly accessLevel?: DeviceAccessLevel;
  }) => {
    readonly decision: PairingDecisionV1;
    readonly device: DeviceRegistrationV1;
  };
  readonly denyPairing: (input: {
    readonly ticketId: string;
    readonly reasonCode: string;
    readonly actor?: EventActor;
  }) => PairingDecisionV1;
  readonly listDevices: () => ReadonlyArray<DeviceRegistrationV1>;
  readonly renameDevice: (input: {
    readonly deviceId: string;
    readonly deviceLabel: string;
    readonly actor?: EventActor;
  }) => DeviceRegistrationV1;
  readonly revokeDevice: (input: {
    readonly deviceId: string;
    readonly actor?: EventActor;
  }) => RemoteCredentialOperationReceipt;
  readonly revokeAll: (input?: {
    readonly actor?: EventActor;
    /** The asking device, kept when it signs out every other device. */
    readonly exceptDeviceId?: string;
  }) => RemoteCredentialOperationReceipt;
  readonly reconcileExpired: () => RemoteCredentialOperationReceipt;
  /** A device's level, for a device the host's person paired; absent for any other. */
  readonly deviceAccessLevel: (deviceId: string) => DeviceAccessLevel | undefined;
  readonly setDeviceAccessLevel: (input: {
    readonly deviceId: string;
    readonly accessLevel: DeviceAccessLevel;
    readonly actor: EventActor;
    /** The device request making the change, left to finish its reply while the rest ends. */
    readonly askingRequest?: AbortSignal;
  }) => { readonly previousLevel: DeviceAccessLevel; readonly accessLevel: DeviceAccessLevel };
  readonly remoteAccessPaused: () => boolean;
  readonly setRemoteAccessPaused: (input: {
    readonly paused: boolean;
    readonly actor: EventActor;
    readonly askingRequest?: AbortSignal;
  }) => boolean;
}

export interface LocalDeviceAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly control:
    | LocalDeviceAdministrationPort
    | undefined
    | (() => LocalDeviceAdministrationPort | undefined);
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

const ROUTES = {
  tickets: "/api/desktop/remote/pairing-tickets",
  pending: "/api/desktop/remote/pairing-requests",
  approve: "/api/desktop/remote/pairing-requests/approve",
  deny: "/api/desktop/remote/pairing-requests/deny",
  devices: "/api/desktop/remote/devices",
  rename: "/api/desktop/remote/devices/rename",
  revoke: "/api/desktop/remote/devices/revoke",
  revokeAll: "/api/desktop/remote/devices/revoke-all",
  reconcileExpired: "/api/desktop/remote/devices/reconcile-expired",
  accessLevel: "/api/desktop/remote/devices/access-level",
  // A window reads the pause with GET; a device only ever sets it, since a
  // paused host answers no device.
  pause: "/api/desktop/remote/access-pause",
} as const;

/**
 * Revoking every paired device but the asking one. Only a device asks it: a
 * window has no device of its own, so at the host it is Revoke all.
 */
const SIGN_OUT_OTHERS = "/api/remote/devices/sign-out-others";

type Route = (typeof ROUTES)[keyof typeof ROUTES] | typeof SIGN_OUT_OTHERS;

const DESKTOP_ROUTE_PREFIX = "/api/desktop/remote/";
const PAIRED_DEVICE_ROUTE_PREFIX = "/api/remote/";

/**
 * The same administration, as a device the host's own person paired reaches
 * it: each route under `/api/remote/` in place of the desktop bridge's prefix
 * (maintainer decision, 2026-11-12). The private listener forwards exactly
 * these paths, and they answer no other caller.
 */
export const PAIRED_DEVICE_ADMINISTRATION_ROUTES: ReadonlyArray<{
  readonly path: string;
  readonly method: "GET" | "POST";
}> = [
  ...Object.values(ROUTES).map((route) => ({
    path: `${PAIRED_DEVICE_ROUTE_PREFIX}${route.slice(DESKTOP_ROUTE_PREFIX.length)}`,
    method:
      route === ROUTES.pending || route === ROUTES.devices ? ("GET" as const) : ("POST" as const),
  })),
  { path: SIGN_OUT_OTHERS, method: "POST" },
];

function pairedDeviceRoute(pathname: string): Route | undefined {
  if (!PAIRED_DEVICE_ADMINISTRATION_ROUTES.some((route) => route.path === pathname)) {
    return undefined;
  }
  if (pathname === SIGN_OUT_OTHERS) return SIGN_OUT_OTHERS;
  const route = `${DESKTOP_ROUTE_PREFIX}${pathname.slice(PAIRED_DEVICE_ROUTE_PREFIX.length)}`;
  return Object.values(ROUTES).find((candidate) => candidate === route);
}

export function createLocalDeviceAdministrationRouteHandler(
  options: LocalDeviceAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const maxBody = options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    const deviceRoute = pairedDeviceRoute(url.pathname);
    const bridgeRoutes: ReadonlyArray<string> = Object.values(ROUTES);
    if (deviceRoute === undefined && !bridgeRoutes.includes(url.pathname)) {
      return undefined;
    }
    const route = deviceRoute ?? (url.pathname as Route);
    const control = typeof options.control === "function" ? options.control() : options.control;
    // The device named as a change's actor, and the device a pairing request
    // may not be its own; absent for the host's own caller.
    let asking:
      | {
          readonly deviceId: string;
          readonly actor: EventActor;
          /** This request, which a change it makes leaves running to reply. */
          readonly request: AbortSignal | undefined;
        }
      | undefined;
    if (deviceRoute !== undefined) {
      // The bound principal is the whole authority here: the product dispatch
      // set it from the device's verified session.
      const context = readPrincipalRouteContext(request);
      const principal = context?.principal;
      if (
        principal === undefined ||
        principal.kind !== "remote-device" ||
        !principalActsAsHostPerson(principal)
      ) {
        return failure("unauthorized", 401);
      }
      if (control === undefined) return failure("unavailable", 503);
      if (url.search !== "") return failure("invalid", 400);
      asking = {
        deviceId: String(principal.deviceId),
        actor: eventActorForPrincipal(principal),
        request: context?.abortSignal,
      };
    } else {
      if (options.desktopBridgeSecret === undefined || control === undefined) {
        return failure("unavailable", 503);
      }
      if (
        !isLoopbackHostname(url.hostname) ||
        request.headers.has("origin") ||
        !secretsEqual(
          options.desktopBridgeSecret,
          request.headers.get("x-octant-desktop-secret") ?? "",
        )
      ) {
        return failure("unauthorized", 401);
      }
      if (url.search !== "") return failure("invalid", 400);
      try {
        options.windowAuthorityStore.authenticate(
          request.headers.get("x-octant-window-capability") ?? "",
          now(),
        );
      } catch (error) {
        return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
      }
    }
    const actor = asking === undefined ? {} : { actor: asking.actor };
    // Level and pause changes always name who made them: the asking device,
    // or the local person at a window on the host.
    const changedBy = asking?.actor ?? eventActorForPrincipal(undefined);
    const askingRequest = asking?.request === undefined ? {} : { askingRequest: asking.request };

    if (route === ROUTES.pending) {
      if (request.method !== "GET") return failure("invalid", 400);
      return Response.json({ pending: control.listPendingPairings().map(toPending) });
    }
    if (route === ROUTES.devices) {
      if (request.method !== "GET") return failure("invalid", 400);
      return Response.json({
        devices: control.listDevices().map((device) => {
          const accessLevel =
            device.state === "active" ? control.deviceAccessLevel(device.deviceId) : undefined;
          const entry = toInventory(device);
          return accessLevel === undefined ? entry : Object.freeze({ ...entry, accessLevel });
        }),
      });
    }
    if (route === ROUTES.pause && request.method === "GET" && asking === undefined) {
      return Response.json({ paused: control.remoteAccessPaused() });
    }
    if (request.method !== "POST") return failure("invalid", 400);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return failure("invalid", 400);
    }
    const decoded = await readJson(request, maxBody);
    if (decoded.kind !== "ok") {
      return failure("invalid", decoded.kind === "too-large" ? 413 : 400);
    }

    try {
      switch (route) {
        case ROUTES.tickets: {
          const body = decodeTicketRequestBody(decoded.value);
          return Response.json({ ticket: control.createPairingTicket(body) }, { status: 201 });
        }
        case ROUTES.approve: {
          const body = decodeApprovalBody(decoded.value);
          // A new device is approved by a party the host already trusts. A
          // request made with the asking device's own key is that device
          // vouching for itself, so it is left for another party to decide.
          if (asking !== undefined && requestIsOwn(control, body.ticketId, asking.deviceId)) {
            return failure("unauthorized", 401);
          }
          const result = control.approvePairing({ ...body, ...actor });
          return Response.json(
            { decision: result.decision, device: toInventory(result.device) },
            { status: 201 },
          );
        }
        case ROUTES.deny: {
          const body = decodeDenialBody(decoded.value);
          return Response.json(
            { decision: control.denyPairing({ ...body, ...actor }) },
            { status: 201 },
          );
        }
        case ROUTES.rename: {
          const body = decodeRenameBody(decoded.value);
          return Response.json(
            { device: toInventory(control.renameDevice({ ...body, ...actor })) },
            { status: 201 },
          );
        }
        case ROUTES.revoke: {
          const body = decodeDeviceBody(decoded.value);
          return Response.json(
            { receipt: control.revokeDevice({ ...body, ...actor }) },
            { status: 201 },
          );
        }
        case ROUTES.revokeAll:
          requireExactKeys(decoded.value, []);
          return Response.json(
            { receipt: asking === undefined ? control.revokeAll() : control.revokeAll(actor) },
            { status: 201 },
          );
        case SIGN_OUT_OTHERS:
          requireExactKeys(decoded.value, []);
          if (asking === undefined) return failure("invalid", 400);
          return Response.json(
            {
              receipt: control.revokeAll({ actor: asking.actor, exceptDeviceId: asking.deviceId }),
            },
            { status: 201 },
          );
        case ROUTES.reconcileExpired:
          requireExactKeys(decoded.value, []);
          return Response.json({ receipt: control.reconcileExpired() }, { status: 201 });
        case ROUTES.accessLevel: {
          const body = decodeAccessLevelBody(decoded.value);
          return Response.json(
            {
              change: control.setDeviceAccessLevel({
                ...body,
                actor: changedBy,
                ...askingRequest,
              }),
            },
            { status: 201 },
          );
        }
        case ROUTES.pause: {
          const body = decodePauseBody(decoded.value);
          const decision = authorizeRemoteAccessPause({
            principalKind: asking === undefined ? "local-window" : "person-paired-device",
            paused: body.paused,
          });
          if (decision.kind === "deny") return failure("unauthorized", 401);
          return Response.json(
            {
              paused: control.setRemoteAccessPaused({
                paused: body.paused,
                actor: changedBy,
                ...askingRequest,
              }),
            },
            { status: 201 },
          );
        }
        default:
          return failure("invalid", 400);
      }
    } catch (error) {
      return mapOperationError(error);
    }
  };
}

/** Whether a pending pairing request was made with the key the asking device is registered under. */
function requestIsOwn(
  control: LocalDeviceAdministrationPort,
  ticketId: string,
  askingDeviceId: string,
): boolean {
  const claim = control
    .listPendingPairings()
    .find((pending) => String(pending.ticketId) === ticketId);
  const own = control.listDevices().find((device) => String(device.deviceId) === askingDeviceId);
  return (
    claim !== undefined &&
    own !== undefined &&
    claim.deviceKeyFingerprint === own.deviceKeyFingerprint
  );
}

function toPending(value: PairingClaimResult): PairingClaimResult {
  return Object.freeze({ ...value });
}

function toInventory(value: DeviceRegistrationV1): LocalDeviceInventoryEntry {
  return Object.freeze({
    hostId: value.hostId,
    deviceId: value.deviceId,
    deviceKeyFingerprint: value.deviceKeyFingerprint,
    deviceLabel: value.deviceLabel,
    origin: value.origin,
    protocolFloor: value.protocolFloor,
    credentialGeneration: value.credentialGeneration,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    lastSeenAt: value.lastSeenAt,
    state: value.state,
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
    ...(value.revokedReason === undefined ? {} : { revokedReason: value.revokedReason }),
  });
}

function decodeTicketRequestBody(value: unknown): {
  readonly sourceClass: PairingTicketV1["sourceClass"];
} {
  requireExactKeys(value, ["sourceClass"]);
  const sourceClass = value.sourceClass;
  // A ticket names the network class its device may claim it over, and
  // `unknown` is never a class a caller may ask for.
  if (sourceClass !== "loopback" && sourceClass !== "lan-private" && sourceClass !== "tailscale") {
    throw new Error("invalid");
  }
  return { sourceClass };
}

function decodeApprovalBody(value: unknown): {
  readonly ticketId: string;
  readonly accessLevel?: DeviceAccessLevel;
} {
  const withLevel = typeof value === "object" && value !== null && "accessLevel" in value;
  requireExactKeys(value, withLevel ? ["accessLevel", "ticketId"] : ["ticketId"]);
  const ticketId = value.ticketId as string;
  if (!UUID_PATTERN.test(ticketId)) throw new Error("invalid");
  if (!withLevel) return { ticketId };
  if (!isDeviceAccessLevel(value.accessLevel)) throw new Error("invalid");
  return { ticketId, accessLevel: value.accessLevel };
}

function decodeAccessLevelBody(value: unknown): {
  readonly deviceId: string;
  readonly accessLevel: DeviceAccessLevel;
} {
  requireExactKeys(value, ["accessLevel", "deviceId"]);
  const deviceId = value.deviceId as string;
  if (!UUID_PATTERN.test(deviceId) || !isDeviceAccessLevel(value.accessLevel)) {
    throw new Error("invalid");
  }
  return { deviceId, accessLevel: value.accessLevel };
}

function decodePauseBody(value: unknown): { readonly paused: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid");
  }
  const keys = Object.keys(value);
  const paused = (value as Record<string, unknown>).paused;
  if (keys.length !== 1 || typeof paused !== "boolean") throw new Error("invalid");
  return { paused };
}

function decodeDenialBody(value: unknown): {
  readonly ticketId: string;
  readonly reasonCode: string;
} {
  requireExactKeys(value, ["reasonCode", "ticketId"]);
  const ticketId = value.ticketId as string;
  const reasonCode = value.reasonCode as string;
  if (!UUID_PATTERN.test(ticketId) || !REDACTED_CODE_PATTERN.test(reasonCode)) {
    throw new Error("invalid");
  }
  return { ticketId, reasonCode };
}

function decodeDeviceBody(value: unknown): { readonly deviceId: string } {
  requireExactKeys(value, ["deviceId"]);
  const deviceId = value.deviceId as string;
  if (!UUID_PATTERN.test(deviceId)) throw new Error("invalid");
  return { deviceId };
}

function decodeRenameBody(value: unknown): {
  readonly deviceId: string;
  readonly deviceLabel: string;
} {
  requireExactKeys(value, ["deviceId", "deviceLabel"]);
  const deviceId = value.deviceId as string;
  const deviceLabel = value.deviceLabel as string;
  if (!UUID_PATTERN.test(deviceId) || !DEVICE_LABEL_PATTERN.test(deviceLabel.trim())) {
    throw new Error("invalid");
  }
  return { deviceId, deviceLabel: deviceLabel.trim() };
}

function requireExactKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid");
  }
  for (const key of keys) {
    if (typeof (value as Record<string, unknown>)[key] !== "string") {
      throw new Error("invalid");
    }
  }
}

async function readJson(
  request: Request,
  maxBody: number,
): Promise<
  { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "invalid" | "too-large" }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBody) return { kind: "too-large" };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { kind: "invalid" };
  }
  if (Buffer.byteLength(text, "utf8") > maxBody) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function secretsEqual(expected: string, actual: string): boolean {
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(left, right);
}

function mapOperationError(error: unknown): Response {
  if (isPairingError(error)) {
    return failure(
      error.category,
      error.category === "unavailable" ? 503 : error.category === "unauthorized" ? 401 : 400,
    );
  }
  if (isCredentialError(error)) {
    return failure(
      error.category === "not-found" ? "not-found" : error.category,
      error.category === "not-found" ? 404 : error.category === "conflict" ? 409 : 400,
    );
  }
  return failure("invalid", 400);
}

function isPairingError(value: unknown): value is PairingDeviceLifecycleError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "PairingDeviceLifecycleError" &&
    "category" in value &&
    (value.category === "invalid" ||
      value.category === "unauthorized" ||
      value.category === "unavailable")
  );
}

function isCredentialError(value: unknown): value is RemoteCredentialLifecycleError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "RemoteCredentialLifecycleError" &&
    "category" in value &&
    (value.category === "invalid" ||
      value.category === "not-found" ||
      value.category === "conflict")
  );
}

function failure(
  category: "invalid" | "unauthorized" | "unavailable" | "not-found" | "conflict",
  status: number,
): Response {
  return Response.json(
    {
      category,
      message:
        category === "unavailable"
          ? "Local device administration is unavailable."
          : category === "unauthorized"
            ? "Local device administration is unauthorized."
            : category === "not-found"
              ? "The requested device is unavailable."
              : category === "conflict"
                ? "The device state changed; refresh and retry."
                : "Local device administration request is invalid.",
    },
    { status },
  );
}
