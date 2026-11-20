import {
  decodeComputerUseApprovalDecisionRequest,
  decodeComputerUseSessionList,
  decodeComputerUseSessionScope,
  decodeComputerUseSessionView,
  decodeComputerUseStopRequest,
} from "@octant/contracts";
import { ComputerUseRuntimeError, type ComputerUseRuntime } from "./computerUse/computerUseRuntime";
import { principalActsAsHostPerson } from "./clientPrincipal";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { eventActorForPrincipal } from "./principalEventActor";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;

export function createComputerUseRouteHandler(options: {
  readonly runtime: Pick<
    ComputerUseRuntime,
    | "inspect"
    | "list"
    | "decide"
    | "stop"
    | "listForHostPerson"
    | "inspectForHostPerson"
    | "decideForHostPerson"
    | "stopForHostPerson"
  >;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      path !== "/api/computer-use/inspect" &&
      path !== "/api/computer-use/sessions" &&
      path !== "/api/computer-use/approvals" &&
      path !== "/api/computer-use/stop"
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !isAllowedOrigin(origin))) {
      return failure("invalid", "Computer-use request origin is not allowed.", 400, origin);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failure("invalid", "Computer-use lifecycle requests require POST.", 405, origin);
    }
    if (
      url.search !== "" ||
      request.headers.get("content-type")?.toLowerCase().split(";", 1)[0] !== "application/json"
    ) {
      return failure("invalid", "Computer-use lifecycle request is invalid.", 400, origin);
    }

    let ownerWindowId;
    let pairedPerson = false;
    let pairedDeviceId = "";
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: options.windowAuthorityStore,
        now: (options.now ?? Date.now)(),
      });
      ownerWindowId = context.scopeId;
      // A device the host's own person paired is that person: it sees and
      // stops every session on this host, not only ones its own turns
      // started. Any other device session holds no part of this surface.
      if (context.principal.kind === "remote-device") {
        if (!principalActsAsHostPerson(context.principal)) {
          return failure(
            "unauthorized",
            "Computer use is controlled only by the host's own person.",
            403,
            origin,
          );
        }
        pairedPerson = true;
        pairedDeviceId = eventActorForPrincipal(context.principal).actorId;
      }
    } catch (error) {
      return failure(
        error instanceof WindowAuthorityError ? "unauthorized" : "invalid",
        "Computer-use lifecycle request is unauthorized.",
        401,
        origin,
      );
    }

    const body = await readJson(request, options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT);
    if (body.kind !== "ok") {
      return failure(
        "invalid",
        body.kind === "too-large"
          ? "Computer-use lifecycle request is too large."
          : "Computer-use lifecycle request body is invalid.",
        body.kind === "too-large" ? 413 : 400,
        origin,
      );
    }

    try {
      let result;
      if (path === "/api/computer-use/sessions") {
        if (!isEmptyRecord(body.value)) {
          return failure("invalid", "Computer-use session list request is invalid.", 400, origin);
        }
        return new Response(
          JSON.stringify(
            decodeComputerUseSessionList(
              pairedPerson
                ? options.runtime.listForHostPerson()
                : options.runtime.list(ownerWindowId),
            ),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json", ...corsHeaders(origin) },
          },
        );
      } else if (path === "/api/computer-use/inspect") {
        const scope = decodeComputerUseSessionScope(body.value);
        result = pairedPerson
          ? options.runtime.inspectForHostPerson(scope)
          : options.runtime.inspect({ ownerWindowId, ...scope });
        if (result === undefined) {
          return failure(
            "unavailable",
            "Computer-use session is unavailable for this authority.",
            404,
            origin,
          );
        }
      } else if (path === "/api/computer-use/approvals") {
        const decision = decodeComputerUseApprovalDecisionRequest(body.value);
        result = pairedPerson
          ? await options.runtime.decideForHostPerson(decision, { deviceId: pairedDeviceId })
          : await options.runtime.decide({ ownerWindowId, ...decision });
      } else {
        const stop = decodeComputerUseStopRequest(body.value);
        result = pairedPerson
          ? await options.runtime.stopForHostPerson(stop, { deviceId: pairedDeviceId })
          : await options.runtime.stop({ ownerWindowId, ...stop });
      }
      return new Response(JSON.stringify(decodeComputerUseSessionView(result)), {
        status: 200,
        headers: { "content-type": "application/json", ...corsHeaders(origin) },
      });
    } catch (error) {
      if (error instanceof ComputerUseRuntimeError) {
        return failure(
          error.category,
          error.message,
          error.category === "unauthorized"
            ? 401
            : error.category === "approval-denied"
              ? 403
              : error.category === "invalid"
                ? 400
                : 503,
          origin,
        );
      }
      return failure(
        "invalid",
        "Computer-use lifecycle request is invalid or unavailable.",
        400,
        origin,
      );
    }
  };
}

async function readJson(
  request: Request,
  limit: number,
): Promise<
  { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "invalid" | "too-large" }
> {
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > limit) return { kind: "too-large" };
    return {
      kind: "ok",
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return { kind: "invalid" };
  }
}

function failure(
  category: "invalid" | "unauthorized" | "unavailable" | "approval-denied",
  message: string,
  status: number,
  origin: string | null,
): Response {
  return Response.json({ category, message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin === null
    ? {}
    : {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-octant-window-capability",
        vary: "Origin",
      };
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHostname(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isEmptyRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
