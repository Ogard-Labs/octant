import { createHash, timingSafeEqual } from "node:crypto";
import type {
  DeviceRegistrationV1,
  PairingDecisionV1,
  StableHostId,
} from "@octant/contracts/remote-access";
import type {
  PairingClaimResult,
  PairingDeviceLifecycleError,
} from "./pairingDeviceLifecycleService";
import type {
  RemoteCredentialLifecycleError,
  RemoteCredentialOperationReceipt,
} from "../remoteCredentialLifecycleService";
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
  readonly listPendingPairings: () => ReadonlyArray<PairingClaimResult>;
  readonly approvePairing: (input: { readonly ticketId: string }) => {
    readonly decision: PairingDecisionV1;
    readonly device: DeviceRegistrationV1;
  };
  readonly denyPairing: (input: {
    readonly ticketId: string;
    readonly reasonCode: string;
  }) => PairingDecisionV1;
  readonly listDevices: () => ReadonlyArray<DeviceRegistrationV1>;
  readonly renameDevice: (input: {
    readonly deviceId: string;
    readonly deviceLabel: string;
  }) => DeviceRegistrationV1;
  readonly revokeDevice: (input: { readonly deviceId: string }) => RemoteCredentialOperationReceipt;
  readonly revokeAll: () => RemoteCredentialOperationReceipt;
  readonly reconcileExpired: () => RemoteCredentialOperationReceipt;
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
  pending: "/api/desktop/remote/pairing-requests",
  approve: "/api/desktop/remote/pairing-requests/approve",
  deny: "/api/desktop/remote/pairing-requests/deny",
  devices: "/api/desktop/remote/devices",
  rename: "/api/desktop/remote/devices/rename",
  revoke: "/api/desktop/remote/devices/revoke",
  revokeAll: "/api/desktop/remote/devices/revoke-all",
  reconcileExpired: "/api/desktop/remote/devices/reconcile-expired",
} as const;

export function createLocalDeviceAdministrationRouteHandler(
  options: LocalDeviceAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const maxBody = options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (!Object.values(ROUTES).includes(url.pathname as (typeof ROUTES)[keyof typeof ROUTES])) {
      return undefined;
    }
    const control = typeof options.control === "function" ? options.control() : options.control;
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

    const route = url.pathname as (typeof ROUTES)[keyof typeof ROUTES];
    if (route === ROUTES.pending) {
      if (request.method !== "GET") return failure("invalid", 400);
      return Response.json({ pending: control.listPendingPairings().map(toPending) });
    }
    if (route === ROUTES.devices) {
      if (request.method !== "GET") return failure("invalid", 400);
      return Response.json({ devices: control.listDevices().map(toInventory) });
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
        case ROUTES.approve: {
          const body = decodeTicketBody(decoded.value);
          const result = control.approvePairing(body);
          return Response.json(
            { decision: result.decision, device: toInventory(result.device) },
            { status: 201 },
          );
        }
        case ROUTES.deny: {
          const body = decodeDenialBody(decoded.value);
          return Response.json({ decision: control.denyPairing(body) }, { status: 201 });
        }
        case ROUTES.rename: {
          const body = decodeRenameBody(decoded.value);
          return Response.json(
            { device: toInventory(control.renameDevice(body)) },
            { status: 201 },
          );
        }
        case ROUTES.revoke: {
          const body = decodeDeviceBody(decoded.value);
          return Response.json({ receipt: control.revokeDevice(body) }, { status: 201 });
        }
        case ROUTES.revokeAll:
          requireExactKeys(decoded.value, []);
          return Response.json({ receipt: control.revokeAll() }, { status: 201 });
        case ROUTES.reconcileExpired:
          requireExactKeys(decoded.value, []);
          return Response.json({ receipt: control.reconcileExpired() }, { status: 201 });
        default:
          return failure("invalid", 400);
      }
    } catch (error) {
      return mapOperationError(error);
    }
  };
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

function decodeTicketBody(value: unknown): { readonly ticketId: string } {
  requireExactKeys(value, ["ticketId"]);
  const ticketId = value.ticketId as string;
  if (!UUID_PATTERN.test(ticketId)) throw new Error("invalid");
  return { ticketId };
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
