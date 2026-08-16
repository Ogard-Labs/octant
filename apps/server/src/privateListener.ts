import { createPublicKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { createSecureContext } from "node:tls";
import { classifyRemoteListenerAddress } from "@octant/domain";
import {
  createRemoteAdmissionPolicy,
  createRemoteBoundaryFetch,
  type RemoteAdmissionDeviceKeyResolver,
  type RemoteAdmissionLimits,
} from "./remote/remoteAdmissionPolicy";
import type { OctantServer, RequestTransportFacts, Serve } from "./server";

const DEFAULT_MAX_REQUEST_BODY_SIZE = 1_048_576;

export type PrivateListenerFailureCode =
  | "invalid-bind"
  | "invalid-origin"
  | "invalid-tls"
  | "occupied-port"
  | "interface-unavailable"
  | "cancelled"
  | "shutdown-failed"
  | "bind-failed";

const PRIVATE_LISTENER_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid-bind",
  "invalid-origin",
  "invalid-tls",
  "occupied-port",
  "interface-unavailable",
  "cancelled",
  "shutdown-failed",
  "bind-failed",
]);

export function isPrivateListenerFailureCode(value: unknown): value is PrivateListenerFailureCode {
  return typeof value === "string" && PRIVATE_LISTENER_FAILURE_CODES.has(value);
}

export class PrivateListenerError extends Error {
  readonly code: PrivateListenerFailureCode;

  constructor(code: PrivateListenerFailureCode) {
    super(`Octant private listener ${code.replaceAll("-", " ")}.`);
    this.name = "PrivateListenerError";
    this.code = code;
  }
}

export interface PrivateListenerTls {
  readonly cert: string | Buffer;
  readonly key: string | Buffer;
}

export interface PrivateListenerConfig {
  readonly hostname: string;
  readonly port: number;
  /** Test/smoke-only seam; product configurations must use an explicit port. */
  readonly allowEphemeralPort?: true;
  readonly origin?: string;
  readonly tls: PrivateListenerTls;
  /**
   * Override admission bucket limits (disposable-host/smoke seam). Product
   * configurations keep the default remote admission limits.
   */
  readonly admissionLimits?: Partial<RemoteAdmissionLimits>;
}

export interface PrivateListenerFacts {
  readonly state: "disabled" | "ready" | "failed";
  readonly addressClass: "lan-private" | "tailscale";
  readonly origin: string;
  readonly port: number;
  readonly tls: "ready";
  readonly errorCode?: PrivateListenerFailureCode;
}

export interface PrivateListenerOptions {
  readonly config: PrivateListenerConfig;
  readonly fetch: (request: Request, facts?: RequestTransportFacts) => Response | Promise<Response>;
  readonly serve: Serve;
  readonly maxRequestBodySize?: number;
  readonly signal?: AbortSignal;
  readonly admissionLimits?: Partial<RemoteAdmissionLimits>;
  /**
   * Resolve an opaque device key for authenticated requests. When the
   * session-cookie/request-proof boundary supplies a verified device identity,
   * this resolver activates per-device admission limits (8 concurrent,
   * 12 auth/min, 60 state-changing/min). Until then the default returns
   * `undefined` and per-device caps are not exercised.
   */
  readonly deviceKeyResolver?: RemoteAdmissionDeviceKeyResolver;
  readonly validateTls?: (
    tls: PrivateListenerTls,
    identity: PrivateListenerTlsValidationOptions,
  ) => void;
}

export interface PrivateListenerTlsValidationOptions {
  readonly hostname: string;
  readonly origin?: string;
  readonly now?: () => Date;
}

export interface PrivateListener {
  readonly facts: () => PrivateListenerFacts;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: (config: PrivateListenerConfig) => Promise<void>;
}

export function createPrivateListener(options: PrivateListenerOptions): PrivateListener {
  validatePrivateListenerConfig(options.config);
  const validateTls = options.validateTls ?? validatePrivateListenerTls;
  validateTls(options.config.tls, tlsValidationOptions(options.config));

  const admission = createRemoteAdmissionPolicy(
    options.admissionLimits === undefined ? {} : { limits: options.admissionLimits },
  );
  const boundaryFetch = createRemoteBoundaryFetch({
    fetch: options.fetch,
    admission,
    ...(options.deviceKeyResolver === undefined
      ? {}
      : { deviceKeyResolver: options.deviceKeyResolver }),
  });

  let config = options.config;
  let activeServer: OctantServer | undefined;
  let state: PrivateListenerFacts["state"] = "disabled";
  let errorCode: PrivateListenerFailureCode | undefined;

  const facts = (): PrivateListenerFacts => ({
    state,
    addressClass: classifyPrivateAddress(config.hostname),
    origin: listenerOrigin(config, activeServer?.url),
    port:
      activeServer?.url.port === undefined || activeServer.url.port === ""
        ? config.port
        : Number(activeServer.url.port),
    tls: "ready",
    ...(errorCode === undefined ? {} : { errorCode }),
  });

  const stop = async (): Promise<void> => {
    const server = activeServer;
    if (server === undefined) {
      state = "disabled";
      errorCode = undefined;
      admission.reset();
      return;
    }
    try {
      await server.stop(true);
      activeServer = undefined;
      state = "disabled";
      errorCode = undefined;
      admission.reset();
    } catch {
      state = "failed";
      errorCode = "shutdown-failed";
      throw new PrivateListenerError("shutdown-failed");
    }
  };

  const start = async (): Promise<void> => {
    if (options.signal?.aborted) {
      state = "failed";
      errorCode = "cancelled";
      throw new PrivateListenerError("cancelled");
    }
    if (activeServer !== undefined) return;
    state = "disabled";
    errorCode = undefined;
    try {
      activeServer = await serveWithCancellation(
        () =>
          options.serve({
            hostname: config.hostname,
            port: config.port,
            maxRequestBodySize: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE,
            listenerTrust: "remote",
            fetch: boundaryFetch,
            tls: config.tls,
          }),
        options.signal,
      );
      assertListenerServerIdentity(config, activeServer.url);
      state = "ready";
    } catch (error) {
      try {
        await activeServer?.stop(true);
      } catch {
        // The listener is already failed closed; keep the bounded startup code.
      }
      activeServer = undefined;
      state = "failed";
      errorCode = classifyBindError(error);
      throw new PrivateListenerError(errorCode);
    }
  };

  const onAbort = () => {
    void stop().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    facts,
    start,
    stop: async () => {
      options.signal?.removeEventListener("abort", onAbort);
      await stop();
    },
    restart: async (nextConfig) => {
      validatePrivateListenerConfig(nextConfig);
      validateTls(nextConfig.tls, tlsValidationOptions(nextConfig));
      await stop();
      config = nextConfig;
      await start();
    },
  };
}

export function validatePrivateListenerConfig(config: PrivateListenerConfig): void {
  if (
    config.hostname.trim() !== config.hostname ||
    config.hostname === "" ||
    config.port < 0 ||
    config.port > 65_535 ||
    !Number.isSafeInteger(config.port) ||
    (config.port === 0 && config.allowEphemeralPort !== true)
  ) {
    throw new PrivateListenerError("invalid-bind");
  }
  const addressClass = classifyRemoteListenerAddress(config.hostname);
  if (addressClass !== "lan-private" && addressClass !== "tailscale") {
    throw new PrivateListenerError("invalid-bind");
  }

  if (config.origin !== undefined) {
    const origin = parseOrigin(config.origin);
    const expectedHost = normalizeHostname(config.hostname);
    if (normalizeHostname(origin.hostname) !== expectedHost) {
      throw new PrivateListenerError("invalid-origin");
    }
    if (config.port !== 0 && originPort(origin) !== config.port) {
      throw new PrivateListenerError("invalid-origin");
    }
  }
}

export function validatePrivateListenerTls(
  tls: PrivateListenerTls,
  identity?: PrivateListenerTlsValidationOptions,
): void {
  if (String(tls.cert).trim() === "" || String(tls.key).trim() === "") {
    throw new PrivateListenerError("invalid-tls");
  }
  try {
    createSecureContext({ cert: tls.cert, key: tls.key });
    const certificate = new X509Certificate(tls.cert);
    const certificatePublicKey = certificate.publicKey.export({ format: "der", type: "spki" });
    const configuredPublicKey = createPublicKey(tls.key).export({
      format: "der",
      type: "spki",
    });
    if (Buffer.compare(certificatePublicKey, configuredPublicKey) !== 0) {
      throw new Error("certificate key mismatch");
    }
    if (identity !== undefined) {
      const now = identity.now?.() ?? new Date();
      const validFrom = Date.parse(certificate.validFrom);
      const validTo = Date.parse(certificate.validTo);
      if (
        !Number.isFinite(validFrom) ||
        !Number.isFinite(validTo) ||
        now.getTime() < validFrom ||
        now.getTime() >= validTo
      ) {
        throw new Error("certificate outside validity window");
      }
      const hostname = normalizeHostname(identity.hostname);
      const matchedHost =
        isIP(hostname) === 0 ? certificate.checkHost(hostname) : certificate.checkIP(hostname);
      if (certificate.subjectAltName === undefined || matchedHost !== hostname) {
        throw new Error("certificate host mismatch");
      }
    }
  } catch {
    throw new PrivateListenerError("invalid-tls");
  }
}

function tlsValidationOptions(config: PrivateListenerConfig): PrivateListenerTlsValidationOptions {
  return {
    hostname: config.hostname,
    ...(config.origin === undefined ? {} : { origin: config.origin }),
  };
}

function classifyPrivateAddress(hostname: string): "lan-private" | "tailscale" {
  const addressClass = classifyRemoteListenerAddress(hostname);
  if (addressClass !== "lan-private" && addressClass !== "tailscale") {
    throw new PrivateListenerError("invalid-bind");
  }
  return addressClass;
}

function listenerOrigin(config: PrivateListenerConfig, activeUrl: URL | undefined): string {
  if (config.origin !== undefined && config.port !== 0) return config.origin;
  const port =
    activeUrl?.port === undefined || activeUrl.port === "" ? config.port : activeUrl.port;
  return `https://${formatHostname(config.hostname)}${port === 443 ? "" : `:${port}`}`;
}

function parseOrigin(value: string): URL {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== "https:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      throw new Error("invalid");
    }
    return origin;
  } catch {
    throw new PrivateListenerError("invalid-origin");
  }
}

function originPort(origin: URL): number {
  return origin.port === "" ? 443 : Number(origin.port);
}

function normalizeHostname(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function formatHostname(value: string): string {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function classifyBindError(error: unknown): PrivateListenerFailureCode {
  if (error instanceof PrivateListenerError) return error.code;
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "EADDRINUSE") return "occupied-port";
  if (code === "EADDRNOTAVAIL") return "interface-unavailable";
  return "bind-failed";
}

function serveWithCancellation(
  serve: () => OctantServer | Promise<OctantServer>,
  signal: AbortSignal | undefined,
): Promise<OctantServer> {
  const pending = Promise.resolve().then(serve);
  if (signal === undefined) return pending;
  if (signal.aborted) {
    void pending.then(stopServer, () => undefined);
    return Promise.reject(new PrivateListenerError("cancelled"));
  }
  return new Promise<OctantServer>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PrivateListenerError("cancelled"));
      void pending.then(stopServer, () => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (server) => {
        if (settled) {
          void stopServer(server);
          return;
        }
        settled = true;
        cleanup();
        resolve(server);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function stopServer(server: OctantServer): Promise<void> {
  try {
    await server.stop(true);
  } catch {
    // Cancellation is already fail closed; the late server must not escape.
  }
}

function assertListenerServerIdentity(config: PrivateListenerConfig, url: URL): void {
  if (url.protocol !== "https:") throw new PrivateListenerError("invalid-origin");
  const configuredClass = classifyPrivateAddress(config.hostname);
  const runtimeHostname = normalizeHostname(url.hostname);
  if (classifyRemoteListenerAddress(runtimeHostname) !== configuredClass) {
    throw new PrivateListenerError("invalid-origin");
  }
  const configuredHostname = normalizeHostname(config.hostname);
  if (
    (isIP(configuredHostname) !== 0 || isIP(runtimeHostname) === 0) &&
    runtimeHostname !== configuredHostname
  ) {
    throw new PrivateListenerError("invalid-origin");
  }
  const actualPort = url.port === "" ? 443 : Number(url.port);
  if ((config.port !== 0 && actualPort !== config.port) || actualPort < 1) {
    throw new PrivateListenerError("invalid-origin");
  }
  if (
    config.origin !== undefined &&
    (config.port !== 0 || parseOrigin(config.origin).port !== "") &&
    originPort(parseOrigin(config.origin)) !== actualPort
  ) {
    throw new PrivateListenerError("invalid-origin");
  }
}
