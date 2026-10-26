import { createHash, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import {
  SshHostKeyProbeRequest,
  SshTargetRegisterRequest,
  SshTargetRepinRequest,
  SshTargetRequest,
  type SshTargetList,
} from "@octant/contracts/ssh-target";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  SshTargetAdministrationResult,
  SshTargetConnectionService,
} from "./sshTargetConnectionService";

/**
 * Local administration of SSH targets. Canonical:
 * docs/design/remote-ssh-environments.md § Registering an SSH target.
 *
 * Registering a target, accepting its host key, and removing it are a
 * person's acts at this machine, as listener administration is: these routes
 * answer only on the loopback interface, to a caller holding the desktop
 * bridge secret and a window capability, with no Origin header. A paired
 * device never reaches them, because the remote gateway keeps every
 * `/api/desktop` path local and holds no bridge secret to present.
 */

const DEFAULT_BODY_LIMIT = 16 * 1_024;

export const SSH_TARGET_ROUTES = {
  list: "/api/desktop/ssh-targets",
  hostKey: "/api/desktop/ssh-targets/host-key",
  register: "/api/desktop/ssh-targets/register",
  repin: "/api/desktop/ssh-targets/repin",
  connect: "/api/desktop/ssh-targets/connect",
  remove: "/api/desktop/ssh-targets/remove",
} as const;

type RouteValue = (typeof SSH_TARGET_ROUTES)[keyof typeof SSH_TARGET_ROUTES];
const ROUTE_VALUES: ReadonlySet<string> = new Set(Object.values(SSH_TARGET_ROUTES));

export interface SshTargetAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly connections: SshTargetConnectionService;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createSshTargetAdministrationRouteHandler(
  options: SshTargetAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const maxBody = options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (!ROUTE_VALUES.has(url.pathname)) return undefined;
    const route = url.pathname as RouteValue;
    if (options.desktopBridgeSecret === undefined) return failure("unavailable", 503);
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
    try {
      options.windowAuthorityStore.authenticate(
        request.headers.get("x-octant-window-capability") ?? "",
        now(),
      );
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }
    if (url.search !== "") return failure("invalid", 400);

    const { connections } = options;
    if (route === SSH_TARGET_ROUTES.list) {
      if (request.method !== "GET") return failure("invalid", 405);
      const list: SshTargetList = { targets: connections.list() };
      return Response.json(list);
    }
    if (request.method !== "POST") return failure("invalid", 405);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return failure("invalid", 415);
    }
    const body = await readJson(request, maxBody);
    if (body.kind !== "ok") return failure("invalid", body.kind === "too-large" ? 413 : 400);

    switch (route) {
      case SSH_TARGET_ROUTES.hostKey: {
        const decoded = Schema.decodeUnknownEither(SshHostKeyProbeRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(await connections.probeHostKey(decoded.right.destination));
      }
      case SSH_TARGET_ROUTES.register: {
        const decoded = Schema.decodeUnknownEither(SshTargetRegisterRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(await connections.register(decoded.right));
      }
      case SSH_TARGET_ROUTES.repin: {
        const decoded = Schema.decodeUnknownEither(SshTargetRepinRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(await connections.repin(decoded.right));
      }
      case SSH_TARGET_ROUTES.connect: {
        const decoded = Schema.decodeUnknownEither(SshTargetRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        return answer(await connections.connect(decoded.right.targetId));
      }
      case SSH_TARGET_ROUTES.remove: {
        const decoded = Schema.decodeUnknownEither(SshTargetRequest)(body.value);
        if (decoded._tag === "Left") return failure("invalid", 400);
        const removed = connections.remove(decoded.right.targetId);
        return removed.status === "ok"
          ? new Response(null, { status: 204 })
          : Response.json(removed, { status: 409 });
      }
    }
    return failure("invalid", 400);
  };
}

function answer<T>(result: SshTargetAdministrationResult<T>): Response {
  return result.status === "ok"
    ? Response.json(result.value)
    : Response.json(result, { status: result.reason === "unknown-target" ? 404 : 409 });
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

function failure(category: "invalid" | "unauthorized" | "unavailable", status: number): Response {
  return Response.json(
    {
      category,
      message:
        category === "unavailable"
          ? "SSH target administration is unavailable."
          : category === "unauthorized"
            ? "SSH target administration is unauthorized."
            : "SSH target administration request is invalid.",
    },
    { status },
  );
}
