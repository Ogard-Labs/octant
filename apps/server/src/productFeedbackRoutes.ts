import type { WindowId } from "@octant/contracts/shell";
import {
  ProductFeedbackError,
  type ProductFeedbackService,
  type ProductFeedbackExecutionContext,
} from "./browser/productFeedbackService";
import { authenticateRoutePrincipal, retainRouteAdmissionCurrent } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const MAX_THREAD_ID_LENGTH = 128;

export interface ProductFeedbackRouteDependencies {
  readonly feedback: Pick<ProductFeedbackService, "list" | "execute" | "readCropForNote">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * The pointed-at feedback surface: read a thread's notes, leave one, throw one
 * away.
 *
 * The route decides nothing. It authenticates the window and hands the command
 * to the service, which checks thread access before the host reads its own page
 * and resolves the element itself rather than believing the caller.
 */
export function createProductFeedbackRouteHandler(deps: ProductFeedbackRouteDependencies) {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (!url.pathname.startsWith("/api/feedback")) return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return failure("Feedback API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/feedback/notes" && request.method === "GET") {
      return listNotes(request, url, origin, deps, now);
    }
    if (/^\/api\/feedback\/notes\/[^/]+\/crop$/.test(url.pathname) && request.method === "GET") {
      return readCrop(request, url, origin, deps, now);
    }
    if (url.pathname === "/api/feedback/commands" && request.method === "POST") {
      return executeCommand(request, url, origin, deps, now);
    }
    return undefined;
  };
}

async function listNotes(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ProductFeedbackRouteDependencies,
  now: () => number,
): Promise<Response> {
  let admission: ReturnType<typeof authenticateFeedback>;
  try {
    if (url.searchParams.size !== 1 || !url.searchParams.has("threadId")) {
      return failure("Feedback list request is invalid.", 400, origin);
    }
    admission = authenticateFeedback(request, deps.windowAuthorityStore, now);
  } catch (error) {
    return authenticationFailure(error, "Feedback list", origin);
  }
  try {
    const threadId = url.searchParams.get("threadId") ?? "";
    if (threadId.length === 0 || threadId.length > MAX_THREAD_ID_LENGTH) {
      return failure("Feedback list request is invalid.", 400, origin);
    }
    const notes = await deps.feedback.list(admission.windowId, threadId, admission.execution);
    if (!admission.responseCurrent())
      return failure("Feedback authority changed. Reconnect and refresh notes.", 401, origin);
    return json({ notes }, origin);
  } catch (error) {
    return serviceFailure(error, "Feedback list failed.", origin);
  } finally {
    admission.finish();
  }
}

async function executeCommand(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ProductFeedbackRouteDependencies,
  now: () => number,
): Promise<Response> {
  let admission: ReturnType<typeof authenticateFeedback>;
  try {
    if (url.search !== "") return failure("Feedback command is invalid.", 400, origin);
    admission = authenticateFeedback(request, deps.windowAuthorityStore, now);
  } catch (error) {
    return authenticationFailure(error, "Feedback command", origin);
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("Feedback command body is invalid.", 400, origin);
    }
    if (!admission.responseCurrent())
      return failure("Feedback authority changed. Reconnect and refresh notes.", 401, origin);
    const result = await deps.feedback.execute(admission.windowId, body, admission.execution);
    if (!admission.responseCurrent())
      return failure(
        "Feedback authority changed. Reconnect and refresh notes before retrying.",
        401,
        origin,
      );
    return json(result, origin);
  } catch (error) {
    return serviceFailure(error, "Feedback command failed.", origin);
  } finally {
    admission.finish();
  }
}

function authenticateFeedback(
  request: Request,
  store: WindowAuthorityStore,
  now: () => number,
): {
  readonly windowId: WindowId;
  readonly execution: ProductFeedbackExecutionContext;
  readonly responseCurrent: () => boolean;
  readonly finish: () => void;
} {
  const context = authenticateRoutePrincipal({ request, store, now: now() });
  if (context.principal.kind !== "local-window")
    throw new WindowAuthorityError(
      "unauthorized",
      "Pointed-at feedback requires a local person window.",
    );
  const windowId = context.scopeId;
  const capability = request.headers.get("x-octant-window-capability") ?? "";
  let inFlight: (() => boolean) | undefined = retainRouteAdmissionCurrent({
    request,
    context,
    store,
    now,
  });
  let retired = false;
  // Check the original request while it is in flight. A completed preview
  // retains only the capability and sticky retirement state after finish().
  const admissionCurrent = () => {
    if (retired) return false;
    try {
      if (store.authenticate(capability, now()) !== windowId || inFlight?.() === false)
        retired = true;
    } catch {
      retired = true;
    }
    return !retired;
  };
  if (!admissionCurrent())
    throw new WindowAuthorityError("unauthorized", "Feedback authority is unavailable.");
  return {
    windowId,
    execution: {
      admissionCurrent,
      signal:
        context.abortSignal === undefined
          ? request.signal
          : AbortSignal.any([request.signal, context.abortSignal]),
    },
    responseCurrent: admissionCurrent,
    finish: () => {
      admissionCurrent();
      // Completed previews retain only the original capability and sticky result,
      // never the HTTP request, its body or its transport lifetime.
      inFlight = undefined;
    },
  };
}

async function readCrop(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ProductFeedbackRouteDependencies,
  now: () => number,
): Promise<Response> {
  let admission: ReturnType<typeof authenticateFeedback> | undefined;
  try {
    if (url.search !== "") return failure("Feedback crop request is invalid.", 400, origin);
    admission = authenticateFeedback(request, deps.windowAuthorityStore, now);
    const noteId = url.pathname.split("/")[4] ?? "";
    const dataUrl = await deps.feedback.readCropForNote(
      admission.windowId,
      noteId,
      admission.execution,
    );
    if (!admission.responseCurrent())
      return failure("Feedback authority changed. Reconnect and refresh notes.", 401, origin);
    return json(dataUrl === undefined ? {} : { dataUrl }, origin);
  } catch (error) {
    if (error instanceof WindowAuthorityError)
      return authenticationFailure(error, "Feedback crop", origin);
    return serviceFailure(error, "Feedback crop is unavailable.", origin);
  } finally {
    admission?.finish();
  }
}

function serviceFailure(error: unknown, fallback: string, origin: string | null): Response {
  if (error instanceof ProductFeedbackError) {
    return failure(error.message, error.category === "conflict" ? 409 : 400, origin);
  }
  return failure(fallback, 500, origin);
}

function authenticationFailure(error: unknown, action: string, origin: string | null): Response {
  return error instanceof WindowAuthorityError
    ? failure(`${action} is unauthorized.`, 401, origin)
    : failure(`${action} request is invalid.`, 400, origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}

function json(body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname) || url.protocol === "file:";
  } catch {
    return false;
  }
}
