import {
  decodeDesktopFrameRequest,
  decodeDesktopPaneAnswer,
  decodeDesktopPaneRequest,
  decodeEventActor,
  type DesktopPaneAnswer,
  type DesktopPaneRequest,
  type EventActor,
} from "@octant/contracts";
import type { ClientPrincipal } from "./clientPrincipal";
import { leasableProvidersOf } from "./computerUse/computerUseDestination";
import type { DesktopLeaseCaller, DesktopLeaseService } from "./computerUse/desktopLeaseService";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

/** Typed text is at most 4 KiB; everything else in a request is ids. */
const BODY_LIMIT = 16 * 1024;
const PANE_PATH = "/api/code/desktops";
const FRAME_PATH = "/api/code/desktops/frame";

export interface DesktopPaneRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: Pick<
    DesktopLeaseService,
    | "overview"
    | "acquire"
    | "release"
    | "retryRelease"
    | "extend"
    | "openView"
    | "closeView"
    | "frame"
    | "input"
    | "destination"
    | "recipeMachines"
  >;
  /** The actor id the journal gives a person at a local window. */
  readonly localActorId: string;
  readonly now?: () => number;
}

/**
 * A person's Desktop tab for a Code thread's disposable desktops
 * (docs/design/disposable-desktops.md). A local window and a paired device
 * both reach it; the person is the authenticated principal that sent the
 * request, never a field in it, and the lease service checks that window or
 * device against the thread on every request, each frame included. Frames
 * answer as the image itself and are never stored.
 */
export function createDesktopPaneRouteHandler(dependencies: DesktopPaneRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PANE_PATH && url.pathname !== FRAME_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    ) {
      return failure("Desktop requests must use an allowed loopback origin.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (
      request.method !== "POST" ||
      url.search !== "" ||
      request.headers.get("content-type")?.toLowerCase() !== "application/json"
    ) {
      return failure("Desktop request is invalid.", 400, origin);
    }
    let body: unknown;
    try {
      const text = await request.text();
      if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) {
        return failure("Desktop request body is too large.", 413, origin);
      }
      body = JSON.parse(text);
    } catch {
      return failure("Desktop request is invalid.", 400, origin);
    }
    let principal: ClientPrincipal;
    let scopeId: string;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
        body,
      });
      principal = context.principal;
      scopeId = String(context.scopeId);
    } catch (error) {
      return failure(
        "Desktop request is unauthorized.",
        error instanceof WindowAuthorityError && error.category !== "invalid" ? 401 : 400,
        origin,
      );
    }
    const actor = personOf(principal, dependencies.localActorId);
    try {
      if (url.pathname === FRAME_PATH) {
        const frameRequest = decodeDesktopFrameRequest(body);
        const answered = await dependencies.service.frame({
          ...callerFor(frameRequest.threadId, actor, scopeId),
          leaseId: frameRequest.leaseId,
          viewId: frameRequest.viewId,
        });
        if (answered.status !== "frame") return encoded(answered, origin);
        return new Response(answered.frame.bytes.slice(), {
          status: 200,
          headers: {
            ...corsHeaders(origin),
            "content-type": answered.frame.mediaType,
            "x-content-type-options": "nosniff",
          },
        });
      }
      const paneRequest = decodeDesktopPaneRequest(body);
      return encoded(await answer(dependencies.service, paneRequest, actor, scopeId), origin);
    } catch {
      return failure("Desktop request is invalid.", 400, origin);
    }
  };
}

async function answer(
  service: DesktopPaneRouteDependencies["service"],
  request: DesktopPaneRequest,
  actor: EventActor,
  scopeId: string,
): Promise<DesktopPaneAnswer> {
  // The recipe editor asks which providers a recipe may name: the ones this
  // host offers for leasing now, the same list destination reporting uses.
  // It names no thread, and reading it changes nothing.
  if (request.kind === "recipe-providers") {
    return { status: "recipe-providers", providers: leasableProvidersOf(service.destination()) };
  }
  // The person's machines for a placement that chooses one. Only a local
  // window sets a recipe, so the service answers only a person there.
  if (request.kind === "recipe-machines") {
    return service.recipeMachines({
      actor,
      providerId: request.providerId,
      placementId: request.placementId,
    });
  }
  const caller = callerFor(request.threadId, actor, scopeId);
  switch (request.kind) {
    case "overview":
      return service.overview(caller);
    case "acquire":
      return service.acquire({
        ...caller,
        ...(request.confirmedProvider === undefined
          ? {}
          : { confirmedProvider: request.confirmedProvider }),
        ...(request.confirmedPlacement === undefined
          ? {}
          : { confirmedPlacement: request.confirmedPlacement }),
        ...(request.confirmedMachine === undefined
          ? {}
          : { confirmedMachine: request.confirmedMachine }),
      });
    case "release":
      return service.release({ ...caller, leaseId: request.leaseId });
    case "retry-release":
      return service.retryRelease({ leaseId: request.leaseId, actor });
    case "extend":
      return service.extend({ ...caller, leaseId: request.leaseId, byMinutes: request.byMinutes });
    case "open-view":
      return service.openView({ ...caller, leaseId: request.leaseId });
    case "close-view":
      return service.closeView({ ...caller, leaseId: request.leaseId, viewId: request.viewId });
    case "input":
      return service.input({
        ...caller,
        leaseId: request.leaseId,
        viewId: request.viewId,
        event: request.event,
      });
  }
}

/** The Desktop tab is a Code thread's; Work threads do not lease yet. */
function callerFor(threadId: string, actor: EventActor, scopeId: string): DesktopLeaseCaller {
  return { owner: { mode: "code", threadId }, actor, scopeId };
}

/**
 * A local window is the person at this machine; a paired device is that
 * device's person. Neither is ever an agent, so nothing a person does in the
 * tab is asked or attributed to one.
 */
function personOf(principal: ClientPrincipal, localActorId: string): EventActor {
  return principal.kind === "remote-device"
    ? decodeEventActor({
        kind: "remote-device",
        actorId: String(principal.deviceId),
        deviceId: String(principal.deviceId),
      })
    : decodeEventActor({ kind: "local-user", actorId: localActorId });
}

function encoded(body: DesktopPaneAnswer, origin: string | null): Response {
  return Response.json(decodeDesktopPaneAnswer(body), {
    status: 200,
    headers: corsHeaders(origin),
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    vary: "Origin",
    "cache-control": "no-store",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    ...(origin === null || !isAllowedRendererOrigin(origin)
      ? {}
      : { "access-control-allow-origin": origin }),
  };
}
