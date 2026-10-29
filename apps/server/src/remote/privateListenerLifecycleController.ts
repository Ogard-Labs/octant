// Server-owned private listener lifecycle controller.
//
// The packaged host controls (enable/disable/restart) drive the real
// dual-listener gateway through this controller, not a stub that echoes
// endpoint facts. The controller is the single server-owned authority over
// the private listener lifetime: it constructs the gateway from a validated
// listener config, projects an authoritative public status from the gateway's
// native facts, and fails closed when TLS/bind/interface/shutdown recovery is
// unavailable.
//
// The loopback listener is never owned or touched here. A failed enable,
// restart, or disable leaves the loopback listener serving unchanged; the
// controller only ever creates, starts, restarts, and stops the private
// gateway generation it owns.
//
// Failure handling is deterministic and retryable:
//   - enable classifies bind/TLS/interface/occupied-port/cancelled failures on
//     a fresh construction, drops the half-started gateway, and projects a
//     typed `failed` status so a retry can re-enable.
//   - restart drives the existing gateway generation and retains its handle on
//     failure: a restart shutdown failure can leave the old generation live, so
//     dropping the handle would strand the bound listener. The retained handle
//     lets a later disable or restart finish or retry against the real gateway.
//   - disable retains the gateway handle on a `shutdown-failed` so a later
//     disable can retry the unbind without losing the handle.
//
// Every lifecycle mutation (enable/restart/disable) runs on a single-flight
// queue so concurrent host actions cannot start multiple gateway generations
// or race the owned handle across their `await` points.

import { createHash, X509Certificate } from "node:crypto";
import { classifyRemoteListenerAddress } from "@octant/domain";
import {
  isPrivateListenerFailureCode,
  validatePrivateListenerConfig,
  validatePrivateListenerNamedTls,
  type PrivateListenerConfig,
  type PrivateListenerFailureCode,
  type PrivateListenerNamedTls,
} from "../privateListener";
import type { RemoteGatewayConfig } from "./remoteGateway";
import type { SelfMadeListenerCertificateStore } from "./selfMadeListenerCertificate";

export type PrivateListenerHostState = "disabled" | "ready" | "failed";

export type PrivateListenerHostExposureClass = "lan-private" | "tailscale";

/** Whether the listener serves the certificate the host made or one the person pasted. */
export type PrivateListenerCertificateSource = "self-made" | "pasted";

/** A listener the host serves with the certificate it makes and renews itself. */
export interface SelfMadePrivateListenerConfig extends Omit<PrivateListenerConfig, "tls"> {
  readonly tls: "self-made";
}

/** What the host was asked to serve: a pasted certificate and key, or its own. */
export type RequestedPrivateListenerConfig = PrivateListenerConfig | SelfMadePrivateListenerConfig;

/**
 * The authoritative public status projection returned to the packaged host
 * controls. It carries no TLS key material, session, or auth secret — only
 * the endpoint facts and a typed error code the desktop control plane needs
 * to reconcile enable/disable/restart against the native listener state.
 */
export interface PrivateListenerHostStatus {
  readonly enabled: boolean;
  readonly state: PrivateListenerHostState;
  readonly hostname: string | null;
  readonly port: number | null;
  readonly origin: string | null;
  readonly exposureClass: PrivateListenerHostExposureClass | null;
  readonly certificateFingerprint: string | null;
  readonly certificateReady: boolean;
  readonly certificateSource: PrivateListenerCertificateSource | null;
  /**
   * The pin of a self-made certificate's key (`sha256-` and base64url). Null
   * for a pasted certificate: `certificateFingerprint` hashes that
   * certificate's key for display, and no client reads it as a pin.
   */
  readonly tlsPin: string | null;
  readonly errorCode?: PrivateListenerFailureCode;
}

/**
 * The minimal gateway lifecycle surface the controller drives. `RemoteGateway`
 * satisfies this contract; tests inject deterministic fakes. The controller
 * never reaches past this surface into route/auth/product internals.
 */
export interface PrivateListenerGatewayLifecycle {
  readonly facts: () => {
    readonly state: PrivateListenerHostState;
    readonly origin: string;
    readonly errorCode?: PrivateListenerFailureCode;
  };
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: (config: RemoteGatewayConfig) => Promise<void>;
}

export interface CreatePrivateListenerLifecycleControllerOptions {
  /**
   * Construct a fresh gateway generation for a validated listener config. The
   * server binds this to `createRemoteGateway` closed over the shared
   * persistence/service graph so the controller can never inject a fetch
   * handler that bypasses route/auth policy.
   */
  readonly createGateway: (config: RemoteGatewayConfig) => PrivateListenerGatewayLifecycle;
  /** Override the certificate fingerprint derivation (test seam). */
  readonly fingerprintFromPem?: (certificatePem: string) => string;
  /**
   * Makes, loads, and renews the key and certificate for a self-made
   * listener. Without it a self-made request is refused as `invalid-tls`.
   */
  readonly selfMadeCertificate?: SelfMadeListenerCertificateStore;
}

/** Why a tailnet certificate was not applied; the listener serves what it served before. */
export type TailnetCertificateRefusal = "invalid-certificate" | "could-not-apply";

export interface PrivateListenerLifecycleController {
  readonly status: () => PrivateListenerHostStatus;
  readonly enable: (config: RequestedPrivateListenerConfig) => Promise<PrivateListenerHostStatus>;
  readonly disable: () => Promise<PrivateListenerHostStatus>;
  readonly restart: (config: RequestedPrivateListenerConfig) => Promise<PrivateListenerHostStatus>;
  /**
   * Serves a tailnet certificate to clients that ask for its name by SNI, beside
   * the certificate the listener already serves; `undefined` goes back to one
   * certificate. Neither the certificate, the key, nor the pin changes. The
   * certificate is checked first, so a bad one never touches the listener.
   */
  readonly setTailnetCertificate: (
    tls: PrivateListenerNamedTls | undefined,
  ) => Promise<
    { readonly status: "applied" } | { status: "refused"; kind: TailnetCertificateRefusal }
  >;
  /** The tailnet name the listener serves a second certificate for, if any. */
  readonly tailnetCertificateName: () => string | undefined;
}

export class PrivateListenerLifecycleError extends Error {
  readonly code: PrivateListenerFailureCode;

  constructor(code: PrivateListenerFailureCode) {
    super(`Octant private listener ${code.replaceAll("-", " ")}.`);
    this.name = "PrivateListenerLifecycleError";
    this.code = code;
  }
}

/**
 * SHA-256 (lowercase hex) of the leaf certificate's DER SubjectPublicKeyInfo.
 * It hashes the key rather than the PEM text, so a certificate reissued for
 * the same key keeps its fingerprint and any tool that reads the key agrees.
 */
export function privateListenerCertificateFingerprint(certificatePem: string): string {
  if (typeof certificatePem !== "string" || certificatePem.trim().length === 0) {
    throw new PrivateListenerLifecycleError("invalid-tls");
  }
  let spki: Buffer;
  try {
    spki = new X509Certificate(certificatePem).publicKey.export({ format: "der", type: "spki" });
  } catch {
    throw new PrivateListenerLifecycleError("invalid-tls");
  }
  return createHash("sha256").update(spki).digest("hex");
}

function disabledStatus(): PrivateListenerHostStatus {
  return {
    enabled: false,
    state: "disabled",
    hostname: null,
    port: null,
    origin: null,
    exposureClass: null,
    certificateFingerprint: null,
    certificateReady: false,
    certificateSource: null,
    tlsPin: null,
  };
}

function failedStatus(errorCode: PrivateListenerFailureCode): PrivateListenerHostStatus {
  return { ...disabledStatus(), state: "failed", errorCode };
}

function exposureClassOf(hostname: string): PrivateListenerHostExposureClass {
  const addressClass = classifyRemoteListenerAddress(hostname);
  if (addressClass === "lan-private" || addressClass === "tailscale") return addressClass;
  throw new PrivateListenerLifecycleError("invalid-bind");
}

function classifyLifecycleFailure(
  error: unknown,
  fallback: PrivateListenerFailureCode,
): PrivateListenerFailureCode {
  if (error instanceof PrivateListenerLifecycleError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    isPrivateListenerFailureCode((error as { code: unknown }).code)
  ) {
    return (error as { code: PrivateListenerFailureCode }).code;
  }
  return fallback;
}

export function createPrivateListenerLifecycleController(
  options: CreatePrivateListenerLifecycleControllerOptions,
): PrivateListenerLifecycleController {
  const fingerprintFromPem = options.fingerprintFromPem ?? privateListenerCertificateFingerprint;

  // The owned gateway generation. `undefined` means the private listener is
  // disabled and nothing is bound. It is retained through a failed shutdown or
  // a failed restart so a retry can complete the unbind against the real
  // generation instead of losing the handle.
  let gateway: PrivateListenerGatewayLifecycle | undefined;
  let activeConfig: PrivateListenerConfig | undefined;
  // What the host was last asked to serve, so a tailnet certificate change
  // re-applies the same request: a self-made listener resolves to the same key,
  // certificate, and pin, and a pasted one is served exactly as given.
  let activeRequested: RequestedPrivateListenerConfig | undefined;
  // Held across a disable and enable of the listener, and dropped when the
  // listener's name is no longer the one the certificate was made for.
  let tailnetTls: PrivateListenerNamedTls | undefined;
  let activeSource: PrivateListenerCertificateSource = "pasted";
  let activePin: string | null = null;
  let state: PrivateListenerHostState = "disabled";
  let errorCode: PrivateListenerFailureCode | undefined;

  const status = (): PrivateListenerHostStatus => {
    if (state === "disabled") return disabledStatus();
    if (state === "failed") return failedStatus(errorCode ?? "bind-failed");
    // Ready: project authoritative endpoint facts. `activeConfig` and
    // `gateway` are always set in the ready state.
    const config = activeConfig!;
    const facts = gateway!.facts();
    let fingerprint: string | null;
    try {
      fingerprint = fingerprintFromPem(String(config.tls.cert));
    } catch {
      fingerprint = null;
    }
    let exposureClass: PrivateListenerHostExposureClass | null;
    try {
      exposureClass = exposureClassOf(config.hostname);
    } catch {
      exposureClass = null;
    }
    const port = derivePort(facts.origin, config.port);
    return {
      enabled: true,
      state: "ready",
      hostname: config.hostname,
      port,
      origin: facts.origin,
      exposureClass,
      certificateFingerprint: fingerprint,
      certificateReady: true,
      certificateSource: activeSource,
      tlsPin: activeSource === "self-made" ? activePin : null,
    };
  };

  const apply = async (
    requested: RequestedPrivateListenerConfig,
  ): Promise<PrivateListenerHostStatus> => {
    const resolved = resolveCertificate(requested);
    if (resolved.status === "refused") return await refuse(resolved.code);
    const { source, pin } = resolved;
    const config: PrivateListenerConfig =
      tailnetTls !== undefined &&
      resolved.config.hostname.toLowerCase() === tailnetTls.serverName.toLowerCase()
        ? { ...resolved.config, tailnetTls }
        : resolved.config;
    const gatewayConfig: RemoteGatewayConfig = { listener: config };
    if (gateway !== undefined) {
      // A gateway already exists (enabled or retained after a failed shutdown).
      // Restart it atomically onto the new config — this is the interface /
      // certificate change path and the retry-after-shutdown-failure path.
      try {
        await gateway.restart(gatewayConfig);
        activeConfig = config;
        activeRequested = requested;
        activeSource = source;
        activePin = pin;
        state = "ready";
        errorCode = undefined;
        return status();
      } catch (error) {
        // A failed restart can leave the previous gateway generation live —
        // `RemoteGateway.restart` stops the old generation before rebinding,
        // and a shutdown failure there deliberately retains the still-bound
        // listener for a later unbind retry. Discarding the handle here would
        // strand that listener: a subsequent disable would report disabled
        // without calling stop(), and server shutdown could not finalize it.
        // Retain the handle so disable/restart can retry against the real
        // generation instead of silently losing it.
        state = "failed";
        errorCode = classifyLifecycleFailure(error, "bind-failed");
        throw new PrivateListenerLifecycleError(errorCode);
      }
    }
    // No gateway yet — construct and start a fresh generation. Construction
    // validates bind/origin/TLS synchronously and fails closed before the
    // loopback listener is ever touched.
    let created: PrivateListenerGatewayLifecycle;
    try {
      created = options.createGateway(gatewayConfig);
    } catch (error) {
      state = "failed";
      errorCode = classifyLifecycleFailure(error, "invalid-tls");
      throw new PrivateListenerLifecycleError(errorCode);
    }
    try {
      await created.start();
      gateway = created;
      activeConfig = config;
      activeRequested = requested;
      activeSource = source;
      activePin = pin;
      state = "ready";
      errorCode = undefined;
      return status();
    } catch (error) {
      gateway = undefined;
      activeConfig = undefined;
      state = "failed";
      errorCode = classifyLifecycleFailure(error, "bind-failed");
      throw new PrivateListenerLifecycleError(errorCode);
    }
  };

  // A pasted certificate is served exactly as given and never touches the
  // self-made key on disk. A self-made one is loaded, made, or renewed here on
  // every enable, restart, and server start.
  const resolveCertificate = (
    requested: RequestedPrivateListenerConfig,
  ):
    | {
        readonly status: "ready";
        readonly config: PrivateListenerConfig;
        readonly source: PrivateListenerCertificateSource;
        readonly pin: string | null;
      }
    | { readonly status: "refused"; readonly code: PrivateListenerFailureCode } => {
    if (requested.tls !== "self-made") {
      return { status: "ready", config: requested, source: "pasted", pin: null };
    }
    if (options.selfMadeCertificate === undefined)
      return { status: "refused", code: "invalid-tls" };
    // The bind and origin are checked before any key or certificate is made,
    // so a public or malformed address never writes one.
    try {
      validatePrivateListenerConfig(requested);
    } catch (error) {
      return { status: "refused", code: classifyLifecycleFailure(error, "invalid-bind") };
    }
    const made = options.selfMadeCertificate.ensure(requested.hostname);
    if (made.status === "refused") return { status: "refused", code: made.code };
    return {
      status: "ready",
      config: { ...requested, tls: made.tls },
      source: "self-made",
      pin: made.tlsPin,
    };
  };

  // A refused certificate leaves nothing served, as a failed restart does: a
  // running generation is stopped rather than left serving the old config.
  const refuse = async (code: PrivateListenerFailureCode): Promise<never> => {
    if (gateway !== undefined) {
      try {
        await gateway.stop();
        gateway = undefined;
        activeConfig = undefined;
      } catch {
        // Keep the handle so a later disable can retry the unbind.
      }
    }
    state = "failed";
    errorCode = code;
    throw new PrivateListenerLifecycleError(code);
  };

  const disable = async (): Promise<PrivateListenerHostStatus> => {
    if (gateway === undefined) {
      state = "disabled";
      errorCode = undefined;
      activeConfig = undefined;
      return disabledStatus();
    }
    try {
      await gateway.stop();
      gateway = undefined;
      activeConfig = undefined;
      state = "disabled";
      errorCode = undefined;
      return disabledStatus();
    } catch (error) {
      // Retain the gateway handle so a later disable can retry the unbind.
      state = "failed";
      errorCode = classifyLifecycleFailure(error, "shutdown-failed");
      throw new PrivateListenerLifecycleError(errorCode);
    }
  };

  // Serialize every lifecycle mutation onto a single-flight queue. enable,
  // restart, and disable all read-modify-write the same owned gateway
  // generation across `await` points (construction, start, stop, restart).
  // Without this boundary, two concurrent mutations could both observe
  // `gateway === undefined` and start independent generations, binding two
  // listeners where only the last is retained — orphaning a bound private
  // listener that a later disable can never reach. The queue guarantees each
  // mutation observes the previous mutation's committed state before it runs.
  let mutations: Promise<unknown> = Promise.resolve();
  const serialize = <T>(mutation: () => Promise<T>): Promise<T> => {
    const result = mutations.then(mutation);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  // Neither server can swap its TLS contexts in place, so a change restarts the
  // listener the way the administration routes already do, onto the request it
  // last served. A certificate that fails its checks never reaches the restart,
  // and one that fails the restart is dropped and the listener restarted
  // without it.
  const setTailnetCertificate = async (
    tls: PrivateListenerNamedTls | undefined,
  ): Promise<
    { readonly status: "applied" } | { status: "refused"; kind: TailnetCertificateRefusal }
  > => {
    if (tls !== undefined) {
      try {
        validatePrivateListenerNamedTls(tls);
      } catch {
        return { status: "refused", kind: "invalid-certificate" };
      }
    }
    const previous = tailnetTls;
    if (previous === undefined && tls === undefined) return { status: "applied" };
    tailnetTls = tls;
    if (state !== "ready" || gateway === undefined || activeRequested === undefined) {
      return { status: "applied" };
    }
    try {
      await apply(activeRequested);
      return { status: "applied" };
    } catch {
      tailnetTls = previous;
      try {
        await apply(activeRequested);
      } catch {
        // The failed state is already projected; a later restart or disable retries.
      }
      return { status: "refused", kind: "could-not-apply" };
    }
  };

  return {
    status,
    enable: (config) => serialize(() => apply(config)),
    restart: (config) => serialize(() => apply(config)),
    disable: () => serialize(disable),
    setTailnetCertificate: (tls) => serialize(() => setTailnetCertificate(tls)),
    tailnetCertificateName: () => tailnetTls?.serverName,
  };
}

function derivePort(origin: string, configuredPort: number): number {
  try {
    const url = new URL(origin);
    if (url.port !== "") return Number(url.port);
    if (url.protocol === "https:") return 443;
  } catch {
    // Fall through to the configured port below.
  }
  return configuredPort;
}
