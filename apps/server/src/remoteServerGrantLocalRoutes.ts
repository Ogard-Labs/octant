import {
  decodeRemoteServerGrantRequest,
  encodeRemoteServerGrantResult,
  type RemoteServerGrantRequest,
  type WindowId,
} from "@octant/contracts";
import { authenticateProjectRequest } from "./projectBindingRoutes";
import { readPrincipalRouteContext } from "./principalRouteContext";
import type { RemoteServerGrantOpening } from "./remote/remoteServerGrantService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const GRANTS_PATH = "/api/server-proxy/grants";
const JSON_BODY_LIMIT = 4_096;

export interface RemoteServerGrantLocalRouteDependencies {
  readonly grants: {
    open(input: {
      readonly principal: { readonly kind: "local-window" };
      readonly scopeId: WindowId;
      readonly request: RemoteServerGrantRequest;
    }): Promise<RemoteServerGrantOpening>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * The grant route as a local window reaches it on the loopback listener.
 *
 * A grant is a paired device's way to open a server from another computer; a
 * window on this computer opens the server directly, so it is answered with
 * the policy's `local-principal` refusal and nothing about the server is read.
 * The route still authenticates the window, so an unauthenticated caller learns
 * nothing either. A paired device never reaches this handler: its proxy route
 * is served by the private listener, and product dispatch classifies no action
 * for this path. A request carrying a bound paired-device principal is refused
 * all the same.
 */
export function createRemoteServerGrantLocalRouteHandler(
  dependencies: RemoteServerGrantLocalRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== GRANTS_PATH) return undefined;
    if (readPrincipalRouteContext(request)?.principal.kind === "remote-device") {
      return failure("Remote server grants are not served to this session.", 403);
    }
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Remote server grant requests must use loopback.", 400);
    }
    if (request.method !== "POST" || url.search !== "") {
      return failure("Remote server grant request is invalid.", 400);
    }
    if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
      return failure("Remote server grant content type is invalid.", 400);
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > JSON_BODY_LIMIT) {
      return failure("Request body is too large.", 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return failure("Remote server grant request is invalid.", 400);
    }
    let scopeId: WindowId;
    try {
      scopeId = authenticateProjectRequest({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Remote server grant request is unauthorized.", 401)
        : failure("Remote server grant request is invalid.", 400);
    }
    let grantRequest: RemoteServerGrantRequest;
    try {
      grantRequest = decodeRemoteServerGrantRequest(body);
    } catch {
      return failure("Remote server grant request is invalid.", 400);
    }
    const opening = await dependencies.grants.open({
      principal: { kind: "local-window" },
      scopeId,
      request: grantRequest,
    });
    if (opening.kind !== "answered") {
      return failure("Octant remote server grants are unavailable.", 503);
    }
    return Response.json(encodeRemoteServerGrantResult(opening.result), {
      headers: { "cache-control": "no-store" },
    });
  };
}

function failure(message: string, status: number): Response {
  return Response.json({ message }, { status, headers: { "cache-control": "no-store" } });
}
