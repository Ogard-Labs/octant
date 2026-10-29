// Loopback administration of the hub role and of this host's hub membership.
//
// Turning the hub role on or off, making a join code, removing a member,
// joining a hub, changing what the hub may do here, and leaving are a person's
// acts at this host. Like the private listener's own routes they answer only
// the loopback desktop bridge with an authenticated window capability, and
// refuse any request that carries an Origin header. A remote device, a peer, or
// the hub reaches them on no path: the private listener refuses this whole
// prefix, and a request signed as a member carries no window capability.

import { createHash, timingSafeEqual } from "node:crypto";
import { decodeHubGrant, type AuditActingPrincipal } from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { HubService } from "./hubService";
import type { SpokeLinkService } from "./spokeLinkService";
import type { TailscaleCertificateService } from "./tailscaleCertificate";

const DEFAULT_BODY_LIMIT = 64 * 1_024;
const WINDOW_PRINCIPAL: AuditActingPrincipal = { kind: "local-window" };

export const HUB_ADMINISTRATION_ROUTES = {
  status: "/api/desktop/hub/status",
  enable: "/api/desktop/hub/enable",
  disable: "/api/desktop/hub/disable",
  joinCode: "/api/desktop/hub/join-codes",
  remove: "/api/desktop/hub/members/remove",
  join: "/api/desktop/hub/join",
  joinFinish: "/api/desktop/hub/join/finish",
  grant: "/api/desktop/hub/grant",
  leave: "/api/desktop/hub/leave",
  /** The `*.ts.net` certificate for the web app: GET reads it, POST turns it on or off or renews it. */
  certificate: "/api/desktop/hub/certificate",
} as const;

type RouteValue = (typeof HUB_ADMINISTRATION_ROUTES)[keyof typeof HUB_ADMINISTRATION_ROUTES];

export interface HubAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  readonly certificate: TailscaleCertificateService;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createHubAdministrationRouteHandler(
  options: HubAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const maxBody = options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (
      !(Object.values(HUB_ADMINISTRATION_ROUTES) as ReadonlyArray<string>).includes(url.pathname)
    ) {
      return undefined;
    }
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
    if (url.search !== "") return failure("invalid", 400);
    try {
      options.windowAuthorityStore.authenticate(
        request.headers.get("x-octant-window-capability") ?? "",
        now(),
      );
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }

    if (route === HUB_ADMINISTRATION_ROUTES.status) {
      if (request.method !== "GET") return failure("invalid", 400);
      return Response.json({ hub: options.hub.status(), spoke: options.spoke.status() });
    }
    if (route === HUB_ADMINISTRATION_ROUTES.certificate && request.method === "GET") {
      return Response.json(options.certificate.status(), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method !== "POST") return failure("invalid", 400);
    const body = await readBody(request, maxBody);
    if (body.kind !== "ok") return failure("invalid", body.kind === "too-large" ? 413 : 400);

    try {
      switch (route) {
        case HUB_ADMINISTRATION_ROUTES.enable: {
          requireNoBody(body.text);
          return outcome(options.hub.enable(WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.disable: {
          requireNoBody(body.text);
          return outcome(options.hub.disable(WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.joinCode: {
          const value = requireJson(request, body.text, ["owner"]);
          if (typeof value.owner !== "boolean") throw new Error("invalid");
          return outcome(options.hub.mintJoinCode({ owner: value.owner }));
        }
        case HUB_ADMINISTRATION_ROUTES.remove: {
          const value = requireJson(request, body.text, ["memberId"]);
          if (typeof value.memberId !== "string") throw new Error("invalid");
          return outcome(
            await options.hub.removeMember({ memberId: value.memberId }, WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.join: {
          const value = requireJson(request, body.text, ["code"]);
          if (typeof value.code !== "string" || value.code.length > 4_096)
            throw new Error("invalid");
          return outcome(await options.spoke.startJoin({ code: value.code }));
        }
        case HUB_ADMINISTRATION_ROUTES.joinFinish: {
          requireNoBody(body.text);
          return outcome(await options.spoke.finishJoin(WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.grant: {
          return outcome(
            options.spoke.setGrant(decodeHubGrant(parseJson(request, body.text)), WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.leave: {
          requireNoBody(body.text);
          return outcome(await options.spoke.leave(WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.certificate: {
          const value = parseJson(request, body.text);
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("invalid");
          }
          const { action, acknowledgedCertificateTransparency, ...rest } = value as Record<
            string,
            unknown
          >;
          if (Object.keys(rest).length !== 0) throw new Error("invalid");
          if (action === "enable") {
            // Anything but a literal true is not the person saying they read the note.
            return outcome(
              options.certificate.enable({
                acknowledgedCertificateTransparency: acknowledgedCertificateTransparency === true,
              }),
            );
          }
          if (acknowledgedCertificateTransparency !== undefined) throw new Error("invalid");
          if (action === "disable") return outcome(await options.certificate.disable());
          if (action === "renew") return outcome(await options.certificate.renewIfDue());
          throw new Error("invalid");
        }
        default:
          return failure("invalid", 400);
      }
    } catch {
      return failure("invalid", 400);
    }
  };
}

/** A refusal is a state the person can act on, so it answers 409 with its kind; anything else is the outcome. */
function outcome(value: { readonly status: string; readonly kind?: string }): Response {
  if (value.status === "refused") {
    return Response.json(value, { status: 409, headers: { "cache-control": "no-store" } });
  }
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}

function requireNoBody(text: string): void {
  if (text.trim() !== "") throw new Error("invalid");
}

function parseJson(request: Request, text: string): unknown {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new Error("invalid");
  }
  return JSON.parse(text);
}

function requireJson(
  request: Request,
  text: string,
  keys: ReadonlyArray<string>,
): Record<string, unknown> {
  const value = parseJson(request, text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid");
  }
  return value as Record<string, unknown>;
}

async function readBody(
  request: Request,
  maxBody: number,
): Promise<
  { readonly kind: "ok"; readonly text: string } | { readonly kind: "invalid" | "too-large" }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBody) return { kind: "too-large" };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { kind: "invalid" };
  }
  return Buffer.byteLength(text, "utf8") > maxBody ? { kind: "too-large" } : { kind: "ok", text };
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
          ? "Hub administration is unavailable."
          : category === "unauthorized"
            ? "Hub administration is unauthorized."
            : "Hub administration request is invalid.",
    },
    { status },
  );
}
