// Loopback private listener administration routes.
//
// The packaged desktop main process drives the server-owned private listener
// lifecycle over the local desktop bridge. These routes are bounded to the
// loopback interface, require the desktop bridge secret plus an authenticated
// window capability, and reject any request that carries an Origin header
// (there is no browser-reachable surface here). No TLS key, session, or auth
// secret is ever returned — only the authoritative public status projection.

import { createHash, timingSafeEqual } from "node:crypto";
import { isLoopbackHostname } from "../shellRoutes";
import type { PrivateListenerConfig, PrivateListenerFailureCode } from "../privateListener";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  PrivateListenerLifecycleError,
  type PrivateListenerHostStatus,
  type PrivateListenerLifecycleController,
} from "./privateListenerLifecycleController";

const DEFAULT_BODY_LIMIT = 64 * 1_024;

const ROUTES = {
  hostIdentityFingerprint: "/api/desktop/private-listener/host-identity-fingerprint",
  status: "/api/desktop/private-listener/status",
  enable: "/api/desktop/private-listener/enable",
  disable: "/api/desktop/private-listener/disable",
  restart: "/api/desktop/private-listener/restart",
} as const;

type RouteValue = (typeof ROUTES)[keyof typeof ROUTES];

export interface PrivateListenerAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Public persisted proof for migrating the former unscoped host identity.
   * It is intentionally a callback so the server reads its authoritative
   * projection at request time rather than handing SQLite access to desktop.
   */
  readonly hostIdentityFingerprint?: () => string | undefined;
  readonly control:
    | PrivateListenerLifecycleController
    | undefined
    | (() => PrivateListenerLifecycleController | undefined);
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createPrivateListenerAdministrationRouteHandler(
  options: PrivateListenerAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const maxBody = options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (!Object.values(ROUTES).includes(url.pathname as RouteValue)) return undefined;

    const control = typeof options.control === "function" ? options.control() : options.control;
    if (options.desktopBridgeSecret === undefined) {
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
      const route = url.pathname as RouteValue;
      // This proof is a public fingerprint, but it remains available only to
      // the loopback desktop bridge. The native helper uses it to prove that a
      // legacy singleton key belongs to the selected store before it migrates
      // the key; desktop does not open or query the SQLite store directly.
      if (route === ROUTES.hostIdentityFingerprint) {
        if (request.method !== "GET") return failure("invalid", 400);
        return Response.json({ fingerprint: options.hostIdentityFingerprint?.() ?? null });
      }
      if (control === undefined) return failure("unavailable", 503);
      options.windowAuthorityStore.authenticate(
        request.headers.get("x-octant-window-capability") ?? "",
        now(),
      );
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }

    const route = url.pathname as RouteValue;
    if (route === ROUTES.status) {
      if (request.method !== "GET") return failure("invalid", 400);
      return statusResponse(control.status());
    }
    if (request.method !== "POST") return failure("invalid", 400);

    try {
      if (route === ROUTES.disable) {
        await readNoBody(request);
        return statusResponse(await control.disable());
      }
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
        return failure("invalid", 400);
      }
      const decoded = await readJson(request, maxBody);
      if (decoded.kind !== "ok") {
        return failure("invalid", decoded.kind === "too-large" ? 413 : 400);
      }
      const config = decodeListenerConfig(decoded.value);
      const status =
        route === ROUTES.enable ? await control.enable(config) : await control.restart(config);
      return statusResponse(status);
    } catch (error) {
      return mapError(error);
    }
  };
}

function statusResponse(status: PrivateListenerHostStatus): Response {
  return Response.json({ status: projectStatus(status) });
}

function projectStatus(status: PrivateListenerHostStatus): PrivateListenerHostStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    hostname: status.hostname,
    port: status.port,
    origin: status.origin,
    exposureClass: status.exposureClass,
    certificateFingerprint: status.certificateFingerprint,
    certificateReady: status.certificateReady,
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  });
}

function decodeListenerConfig(value: unknown): PrivateListenerConfig {
  requireExactKeys(value, ["certificatePem", "hostname", "origin", "port", "privateKeyPem"]);
  const hostname = value.hostname;
  const origin = value.origin;
  const certificatePem = value.certificatePem;
  const privateKeyPem = value.privateKeyPem;
  const port = value.port;
  if (
    typeof hostname !== "string" ||
    hostname.trim().length === 0 ||
    hostname.trim() !== hostname ||
    typeof origin !== "string" ||
    origin.length === 0 ||
    typeof certificatePem !== "string" ||
    certificatePem.trim().length === 0 ||
    typeof privateKeyPem !== "string" ||
    privateKeyPem.trim().length === 0 ||
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("invalid");
  }
  return {
    hostname,
    port,
    origin,
    tls: { cert: certificatePem, key: privateKeyPem },
  };
}

function requireExactKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid");
  }
}

async function readNoBody(request: Request): Promise<void> {
  try {
    const text = await request.text();
    if (text.trim() !== "") throw new Error("invalid");
  } catch {
    // A body-read failure on a no-body route is a benign disconnect; the
    // disable path is idempotent, so continue to the controller.
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

function mapError(error: unknown): Response {
  if (error instanceof PrivateListenerLifecycleError) {
    return listenerFailure(error.code);
  }
  return failure("invalid", 400);
}

function listenerFailure(code: PrivateListenerFailureCode): Response {
  const status =
    code === "invalid-bind" || code === "invalid-origin" || code === "invalid-tls" ? 400 : 503;
  return Response.json(
    {
      category: status === 400 ? "invalid" : "unavailable",
      errorCode: code,
      message: `Octant private listener ${code.replaceAll("-", " ")}.`,
    },
    { status },
  );
}

function failure(category: "invalid" | "unauthorized" | "unavailable", status: number): Response {
  return Response.json(
    {
      category,
      message:
        category === "unavailable"
          ? "Private listener administration is unavailable."
          : category === "unauthorized"
            ? "Private listener administration is unauthorized."
            : "Private listener administration request is invalid.",
    },
    { status },
  );
}
