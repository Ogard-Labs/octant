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

import { createHash } from "node:crypto";
import { classifyRemoteListenerAddress } from "@octant/domain";
import {
  isPrivateListenerFailureCode,
  type PrivateListenerConfig,
  type PrivateListenerFailureCode,
} from "../privateListener";
import type { RemoteGatewayConfig } from "./remoteGateway";

export type PrivateListenerHostState = "disabled" | "ready" | "failed";

export type PrivateListenerHostExposureClass = "lan-private" | "tailscale";

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
}

export interface PrivateListenerLifecycleController {
  readonly status: () => PrivateListenerHostStatus;
  readonly enable: (config: PrivateListenerConfig) => Promise<PrivateListenerHostStatus>;
  readonly disable: () => Promise<PrivateListenerHostStatus>;
  readonly restart: (config: PrivateListenerConfig) => Promise<PrivateListenerHostStatus>;
}

export class PrivateListenerLifecycleError extends Error {
  readonly code: PrivateListenerFailureCode;

  constructor(code: PrivateListenerFailureCode) {
    super(`Octant private listener ${code.replaceAll("-", " ")}.`);
    this.name = "PrivateListenerLifecycleError";
    this.code = code;
  }
}

export function privateListenerCertificateFingerprint(certificatePem: string): string {
  if (typeof certificatePem !== "string" || certificatePem.trim().length === 0) {
    throw new PrivateListenerLifecycleError("invalid-tls");
  }
  return createHash("sha256").update(certificatePem.replaceAll(/\s+/g, "")).digest("hex");
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
    };
  };

  const apply = async (config: PrivateListenerConfig): Promise<PrivateListenerHostStatus> => {
    const gatewayConfig: RemoteGatewayConfig = { listener: config };
    if (gateway !== undefined) {
      // A gateway already exists (enabled or retained after a failed shutdown).
      // Restart it atomically onto the new config — this is the interface /
      // certificate change path and the retry-after-shutdown-failure path.
      try {
        await gateway.restart(gatewayConfig);
        activeConfig = config;
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

  return {
    status,
    enable: (config) => serialize(() => apply(config)),
    restart: (config) => serialize(() => apply(config)),
    disable: () => serialize(disable),
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
