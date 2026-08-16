import { createHash } from "node:crypto";
import { classifyRemoteListenerAddress } from "@octant/domain";

export type PrivateListenerExposureClass = "lan-private" | "tailscale";

export type PrivateListenerControlFailureCode =
  | "local-confirmation-required"
  | "invalid-bind"
  | "invalid-origin"
  | "invalid-tls"
  | "occupied-port"
  | "interface-unavailable"
  | "bind-failed"
  | "shutdown-failed"
  | "cancelled"
  | "unavailable";

const FAILURE_CODES: ReadonlySet<string> = new Set([
  "local-confirmation-required",
  "invalid-bind",
  "invalid-origin",
  "invalid-tls",
  "occupied-port",
  "interface-unavailable",
  "bind-failed",
  "shutdown-failed",
  "cancelled",
  "unavailable",
]);

const FAILURE_MESSAGES: Readonly<Record<PrivateListenerControlFailureCode, string>> = {
  "local-confirmation-required":
    "Octant enables the private listener only after local confirmation.",
  "invalid-bind": "Octant rejected an invalid private listener address.",
  "invalid-origin": "Octant rejected an invalid private listener origin.",
  "invalid-tls": "Octant rejected an invalid private listener certificate.",
  "occupied-port": "Octant could not bind the private listener because the port is occupied.",
  "interface-unavailable":
    "Octant could not bind the private listener because the interface is unavailable.",
  "bind-failed": "Octant could not bind the private listener.",
  "shutdown-failed": "Octant could not disable the private listener cleanly.",
  cancelled: "Octant cancelled the private listener change before it completed.",
  unavailable: "Octant private listener controls are unavailable.",
};

export class PrivateListenerControlFailure extends Error {
  readonly code: PrivateListenerControlFailureCode;

  constructor(code: PrivateListenerControlFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "PrivateListenerControlFailure";
    this.code = code;
  }
}

export interface PrivateListenerEnableRequest {
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly localConfirmation: boolean;
}

export interface PrivateListenerPublicStatus {
  readonly enabled: boolean;
  readonly state: "disabled" | "ready" | "failed";
  readonly hostname: string | null;
  readonly port: number | null;
  readonly origin: string | null;
  readonly exposureClass: PrivateListenerExposureClass | null;
  readonly certificateFingerprint: string | null;
  readonly certificateReady: boolean;
  readonly errorCode?: PrivateListenerControlFailureCode;
}

export interface PrivateListenerRuntimeStartResult {
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly exposureClass: PrivateListenerExposureClass;
  readonly certificateFingerprint: string;
  readonly certificateReady: boolean;
}

export interface PrivateListenerRuntimeStartInput {
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly certificateFingerprint: string;
  readonly exposureClass: PrivateListenerExposureClass;
}

export interface PrivateListenerRuntimePort {
  readonly start: (
    input: PrivateListenerRuntimeStartInput,
  ) => Promise<PrivateListenerRuntimeStartResult>;
  readonly stop: () => Promise<void>;
  /**
   * Apply a new bind/interface/certificate to an already-enabled listener.
   * When absent, restart falls back to a stop followed by a fresh start so
   * the interface-change path still reconciles against the native listener.
   */
  readonly restart?: (
    input: PrivateListenerRuntimeStartInput,
  ) => Promise<PrivateListenerRuntimeStartResult>;
  /**
   * Read the authoritative native status projection. When present, the
   * control service reconciles its local status against the server-owned
   * lifecycle rather than trusting only the last local mutation result.
   */
  readonly getStatus?: () => Promise<PrivateListenerPublicStatus>;
}

export interface PrivateListenerControlService {
  readonly getStatus: () => PrivateListenerPublicStatus;
  readonly enable: (request: PrivateListenerEnableRequest) => Promise<PrivateListenerPublicStatus>;
  readonly disable: () => Promise<PrivateListenerPublicStatus>;
  /**
   * Reconfigure an enabled listener onto a new interface/certificate. Fails
   * closed with a retryable code without touching the loopback listener.
   */
  readonly restart: (request: PrivateListenerEnableRequest) => Promise<PrivateListenerPublicStatus>;
  /**
   * Reconcile the local status against the authoritative native projection.
   * A native projection failure fails closed to an `unavailable` status.
   */
  readonly syncStatus: () => Promise<PrivateListenerPublicStatus>;
}

export interface CreatePrivateListenerControlServiceOptions {
  readonly runtime: PrivateListenerRuntimePort;
  readonly fingerprintFromPem?: (certificatePem: string) => string;
}

export function certificateFingerprintFromPem(certificatePem: string): string {
  if (typeof certificatePem !== "string" || certificatePem.trim().length === 0) {
    throw new PrivateListenerControlFailure("invalid-tls");
  }
  return createHash("sha256").update(certificatePem.replaceAll(/\s+/g, "")).digest("hex");
}

export function createPrivateListenerControlService(
  options: CreatePrivateListenerControlServiceOptions,
): PrivateListenerControlService {
  const fingerprintFromPem = options.fingerprintFromPem ?? certificateFingerprintFromPem;
  let status: PrivateListenerPublicStatus = disabledStatus();

  const getStatus = (): PrivateListenerPublicStatus => ({ ...status });

  const applyStart = async (
    request: PrivateListenerEnableRequest,
    operation: "start" | "restart",
  ): Promise<PrivateListenerPublicStatus> => {
    validateEnableRequest(request);
    const exposureClass = requirePrivateExposureClass(request.hostname);
    validateExactOrigin(request.hostname, request.port, request.origin);
    if (
      typeof request.certificatePem !== "string" ||
      request.certificatePem.trim().length === 0 ||
      typeof request.privateKeyPem !== "string" ||
      request.privateKeyPem.trim().length === 0
    ) {
      throw new PrivateListenerControlFailure("invalid-tls");
    }

    let fingerprint: string;
    try {
      fingerprint = fingerprintFromPem(request.certificatePem);
    } catch (error) {
      throw toControlFailure(error, "invalid-tls");
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new PrivateListenerControlFailure("invalid-tls");
    }

    const input: PrivateListenerRuntimeStartInput = {
      hostname: request.hostname,
      port: request.port,
      origin: request.origin,
      certificatePem: request.certificatePem,
      privateKeyPem: request.privateKeyPem,
      certificateFingerprint: fingerprint,
      exposureClass,
    };
    try {
      // Restart applies a new config to the running listener. When the runtime
      // lacks a dedicated restart, fall back to stop-then-start so the
      // interface change still reconciles against the native listener.
      const started =
        operation === "restart" && options.runtime.restart !== undefined
          ? await options.runtime.restart(input)
          : operation === "restart"
            ? await restartViaStopStart(options.runtime, input)
            : await options.runtime.start(input);
      status = {
        enabled: true,
        state: "ready",
        hostname: started.hostname,
        port: started.port,
        origin: started.origin,
        exposureClass: started.exposureClass,
        certificateFingerprint: started.certificateFingerprint,
        certificateReady: started.certificateReady,
      };
      return getStatus();
    } catch (error) {
      status = {
        ...disabledStatus(),
        state: "failed",
        errorCode: classifyRuntimeFailure(error),
      };
      throw new PrivateListenerControlFailure(status.errorCode!);
    }
  };

  return {
    getStatus,
    enable: (request) => applyStart(request, "start"),
    restart: (request) => applyStart(request, "restart"),
    disable: async () => {
      try {
        await options.runtime.stop();
        status = disabledStatus();
        return getStatus();
      } catch (error) {
        status = {
          ...status,
          state: "failed",
          errorCode: classifyRuntimeFailure(error, "shutdown-failed"),
        };
        throw new PrivateListenerControlFailure(status.errorCode!);
      }
    },
    syncStatus: async () => {
      if (options.runtime.getStatus === undefined) return getStatus();
      try {
        status = normalizeStatus(await options.runtime.getStatus());
        return getStatus();
      } catch (error) {
        status = {
          ...disabledStatus(),
          state: "failed",
          errorCode: classifyRuntimeFailure(error, "unavailable"),
        };
        throw new PrivateListenerControlFailure(status.errorCode!);
      }
    },
  };
}

async function restartViaStopStart(
  runtime: PrivateListenerRuntimePort,
  input: PrivateListenerRuntimeStartInput,
): Promise<PrivateListenerRuntimeStartResult> {
  await runtime.stop();
  return runtime.start(input);
}

function normalizeStatus(status: PrivateListenerPublicStatus): PrivateListenerPublicStatus {
  if (status.state === "ready" && status.enabled) {
    return {
      enabled: true,
      state: "ready",
      hostname: status.hostname,
      port: status.port,
      origin: status.origin,
      exposureClass: status.exposureClass,
      certificateFingerprint: status.certificateFingerprint,
      certificateReady: status.certificateReady,
    };
  }
  if (status.state === "failed") {
    return {
      ...disabledStatus(),
      state: "failed",
      ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
    };
  }
  return disabledStatus();
}

function disabledStatus(): PrivateListenerPublicStatus {
  return {
    enabled: false,
    state: "disabled",
    hostname: null,
    port: null,
    origin: null,
    exposureClass: null,
    certificateFingerprint: null,
    certificateReady: false,
  };
}

function validateEnableRequest(request: PrivateListenerEnableRequest): void {
  if (request.localConfirmation !== true) {
    throw new PrivateListenerControlFailure("local-confirmation-required");
  }
  if (
    typeof request.hostname !== "string" ||
    request.hostname.trim().length === 0 ||
    !Number.isSafeInteger(request.port) ||
    request.port < 1 ||
    request.port > 65_535
  ) {
    throw new PrivateListenerControlFailure("invalid-bind");
  }
}

function requirePrivateExposureClass(hostname: string): PrivateListenerExposureClass {
  const addressClass = classifyRemoteListenerAddress(hostname);
  if (addressClass === "lan-private" || addressClass === "tailscale") return addressClass;
  throw new PrivateListenerControlFailure("invalid-bind");
}

function validateExactOrigin(hostname: string, port: number, origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new PrivateListenerControlFailure("invalid-origin");
  }
  if (parsed.protocol !== "https:") {
    throw new PrivateListenerControlFailure("invalid-origin");
  }
  const expectedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  if (parsed.hostname !== hostname && parsed.hostname !== expectedHost) {
    throw new PrivateListenerControlFailure("invalid-origin");
  }
  const expectedPort = String(port);
  const actualPort = parsed.port === "" ? "443" : parsed.port;
  if (actualPort !== expectedPort) {
    throw new PrivateListenerControlFailure("invalid-origin");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new PrivateListenerControlFailure("invalid-origin");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new PrivateListenerControlFailure("invalid-origin");
  }
}

function classifyRuntimeFailure(
  error: unknown,
  fallback: PrivateListenerControlFailureCode = "bind-failed",
): PrivateListenerControlFailureCode {
  if (error instanceof PrivateListenerControlFailure) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    FAILURE_CODES.has((error as { code: string }).code)
  ) {
    return (error as { code: PrivateListenerControlFailureCode }).code;
  }
  return fallback;
}

function toControlFailure(
  error: unknown,
  fallback: PrivateListenerControlFailureCode,
): PrivateListenerControlFailure {
  if (error instanceof PrivateListenerControlFailure) return error;
  return new PrivateListenerControlFailure(classifyRuntimeFailure(error, fallback));
}

const PRIVATE_LISTENER_ROUTES = {
  status: "/api/desktop/private-listener/status",
  enable: "/api/desktop/private-listener/enable",
  disable: "/api/desktop/private-listener/disable",
  restart: "/api/desktop/private-listener/restart",
} as const;

export interface PrivateListenerHostRuntimeOptions {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The packaged host runtime that drives the server-owned private listener
 * lifecycle over the loopback desktop bridge. Every request is bounded to the
 * local server URL and carries the desktop bridge secret plus the owned
 * window capability; no key, session, or auth secret is returned to the
 * renderer — only the authoritative public status projection.
 */
export function createPrivateListenerHostRuntime(
  options: PrivateListenerHostRuntimeOptions,
): PrivateListenerRuntimePort {
  const fetch = options.fetch ?? globalThis.fetch;
  const apply = async (
    route: string,
    input: PrivateListenerRuntimeStartInput,
  ): Promise<PrivateListenerRuntimeStartResult> =>
    requireReady(await request(fetch, options, "POST", route, enableBody(input)));
  return {
    start: (input) => apply(PRIVATE_LISTENER_ROUTES.enable, input),
    restart: (input) => apply(PRIVATE_LISTENER_ROUTES.restart, input),
    stop: async () => {
      await request(fetch, options, "POST", PRIVATE_LISTENER_ROUTES.disable);
    },
    getStatus: async () =>
      decodeStatus(await request(fetch, options, "GET", PRIVATE_LISTENER_ROUTES.status)),
  };
}

function enableBody(input: PrivateListenerRuntimeStartInput): Record<string, unknown> {
  return {
    hostname: input.hostname,
    port: input.port,
    origin: input.origin,
    certificatePem: input.certificatePem,
    privateKeyPem: input.privateKeyPem,
  };
}

function requireReady(status: PrivateListenerPublicStatus): PrivateListenerRuntimeStartResult {
  if (
    !status.enabled ||
    status.state !== "ready" ||
    status.hostname === null ||
    status.port === null ||
    status.origin === null ||
    status.exposureClass === null ||
    status.certificateFingerprint === null
  ) {
    throw new PrivateListenerControlFailure(status.errorCode ?? "bind-failed");
  }
  return {
    hostname: status.hostname,
    port: status.port,
    origin: status.origin,
    exposureClass: status.exposureClass,
    certificateFingerprint: status.certificateFingerprint,
    certificateReady: status.certificateReady,
  };
}

async function request(
  fetch: typeof globalThis.fetch,
  options: PrivateListenerHostRuntimeOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<PrivateListenerPublicStatus> {
  let response: Response;
  try {
    response = await fetch(new URL(path, options.serverUrl), {
      method,
      headers: {
        "x-octant-desktop-secret": options.desktopBridgeSecret,
        "x-octant-window-capability": options.windowCapability,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new PrivateListenerControlFailure("unavailable");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new PrivateListenerControlFailure("unavailable");
  }
  if (!response.ok) throw new PrivateListenerControlFailure(decodeFailureCode(value));
  return decodeStatusEnvelope(value);
}

function decodeStatusEnvelope(value: unknown): PrivateListenerPublicStatus {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    throw new PrivateListenerControlFailure("unavailable");
  }
  return decodeStatus((value as { status: unknown }).status);
}

function decodeStatus(value: unknown): PrivateListenerPublicStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PrivateListenerControlFailure("unavailable");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.enabled !== "boolean" ||
    (record.state !== "disabled" && record.state !== "ready" && record.state !== "failed") ||
    !nullableString(record.hostname) ||
    !nullableInteger(record.port) ||
    !nullableString(record.origin) ||
    !nullableExposureClass(record.exposureClass) ||
    !nullableString(record.certificateFingerprint) ||
    typeof record.certificateReady !== "boolean" ||
    (record.errorCode !== undefined && !FAILURE_CODES.has(String(record.errorCode)))
  ) {
    throw new PrivateListenerControlFailure("unavailable");
  }
  return {
    enabled: record.enabled,
    state: record.state,
    hostname: record.hostname as string | null,
    port: record.port as number | null,
    origin: record.origin as string | null,
    exposureClass: record.exposureClass as PrivateListenerExposureClass | null,
    certificateFingerprint: record.certificateFingerprint as string | null,
    certificateReady: record.certificateReady,
    ...(record.errorCode === undefined
      ? {}
      : { errorCode: record.errorCode as PrivateListenerControlFailureCode }),
  };
}

function decodeFailureCode(value: unknown): PrivateListenerControlFailureCode {
  if (
    typeof value === "object" &&
    value !== null &&
    "errorCode" in value &&
    FAILURE_CODES.has(String((value as { errorCode: unknown }).errorCode))
  ) {
    return (value as { errorCode: PrivateListenerControlFailureCode }).errorCode;
  }
  return "unavailable";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableInteger(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function nullableExposureClass(value: unknown): boolean {
  return value === null || value === "lan-private" || value === "tailscale";
}
