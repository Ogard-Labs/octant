// The two routes of the push gateway, served by a hub that sends notifications
// directly, on the private listener it already uses. A phone trades its platform
// token for a capability; a computer posts one sealed envelope signed with its
// host key. Neither carries an Octant session: the capability and the signature
// are the authority, exactly as at the Octant-run gateway, and the hub answers
// `unavailable` for both while its switch is off.

import { REMOTE_PUSH_DELIVERY_HEADERS } from "@octant/contracts";
import type { DirectPushGateway, DirectPushGatewayAnswer } from "./directPushGateway";

export const DIRECT_PUSH_GATEWAY_ROUTES = {
  capabilities: "/v1/capabilities",
  deliveries: "/v1/deliveries",
} as const;

const NO_STORE = { "cache-control": "no-store" } as const;

export function createDirectPushRouteHandler(options: {
  readonly gateway: DirectPushGateway;
}): (request: Request, facts?: { readonly sourceKey: string }) => Promise<Response | undefined> {
  return async (request, facts) => {
    const url = new URL(request.url);
    if (
      url.pathname !== DIRECT_PUSH_GATEWAY_ROUTES.capabilities &&
      url.pathname !== DIRECT_PUSH_GATEWAY_ROUTES.deliveries
    ) {
      return undefined;
    }
    if (request.method !== "POST" || url.search !== "") {
      return Response.json({ code: "malformed" }, { status: 405, headers: NO_STORE });
    }
    const body = await request.text();
    const answer: DirectPushGatewayAnswer =
      url.pathname === DIRECT_PUSH_GATEWAY_ROUTES.capabilities
        ? await options.gateway.issueCapability(body, facts?.sourceKey ?? "")
        : await options.gateway.deliver(body, {
            hostKey: request.headers.get(REMOTE_PUSH_DELIVERY_HEADERS.hostKey),
            timestamp: request.headers.get(REMOTE_PUSH_DELIVERY_HEADERS.timestamp),
            signature: request.headers.get(REMOTE_PUSH_DELIVERY_HEADERS.signature),
          });
    if ("capability" in answer) {
      return Response.json({ capability: answer.capability }, { headers: NO_STORE });
    }
    if ("code" in answer) {
      return Response.json({ code: answer.code }, { status: answer.status, headers: NO_STORE });
    }
    return new Response(null, { status: answer.status, headers: NO_STORE });
  };
}
