import {
  decodeThreadExternalContentRequest,
  decodeThreadMessageQueueScope,
  type OctantMode,
  type ThreadExternalContentRequest,
  type WindowId,
} from "@octant/contracts";
import type { ContextFailure } from "@octant/contracts/context-rpc";
import { authorizePrincipalAction } from "@octant/domain";
import { ClientPrincipalError } from "./clientPrincipal";
import type { ExternalContentClearStore } from "./context/externalContentClearStore";
import type { ThreadMessageQueueModePort } from "./messageQueue/threadMessageQueuePort";
import { resolvePrincipalRouteContext, type PrincipalRouteContext } from "./principalRouteContext";
import { isRoutineHostScope } from "./routineHostScope";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

const ROUTE = "/api/thread-external-content";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 4_096;

/**
 * How the thread's own mode sees it for this window: `idle` with no turn
 * running or queued, `active` with one, `unconfirmed` when its last turn ended
 * without the host learning how, and `unavailable` when the thread is missing,
 * its mode is off, or the window may not reach its Project.
 */
export type ExternalContentThreadInspection = "idle" | "active" | "unconfirmed" | "unavailable";

export interface ExternalContentRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly clears: Pick<ExternalContentClearStore, "read" | "clear">;
  readonly inspectThread: (input: {
    readonly windowId: WindowId;
    readonly mode: OctantMode;
    readonly threadId: string;
  }) => Promise<ExternalContentThreadInspection>;
  readonly now?: () => number;
}

/**
 * Reads a thread the way the message queue does before it dispatches a
 * follow-up. That read is the one place all three modes answer the same two
 * questions: may this live window reach the thread's mode and Project, and is
 * a turn running or queued. Anything it holds back is `unavailable` here, and
 * a turn it could not confirm the end of is `unconfirmed`, so a thread whose
 * state cannot be told is never cleared.
 */
export function inspectThreadAsMessageQueue(
  queue: Pick<ThreadMessageQueueModePort, "inspect">,
): ExternalContentRouteDependencies["inspectThread"] {
  return async ({ windowId, mode, threadId }) => {
    const inspection = await queue.inspect({
      scope: decodeThreadMessageQueueScope({ mode, threadId }),
      windowId,
      intent: "read",
    });
    if (inspection.status === "held") return "unavailable";
    if (inspection.status === "busy") return "active";
    return inspection.tail?.unconfirmed === true ? "unconfirmed" : "idle";
  };
}

/**
 * Where a person reviews what a thread read and clears its outside-content
 * mark. One POST route with two requests: `read` and `clear`.
 *
 * Authority model:
 * - loopback only, an allow-listed renderer origin, and the window capability;
 * - the principal must be a local window and not the host's own scope, checked
 *   against the shared least-authority catalogue before the thread is read;
 * - the handler is registered on the loopback chain only and its path is a
 *   remote local-only prefix, so the private listener never forwards it.
 *
 * No tool, command, model output, structured reference, agent message, or
 * host-run turn holds this route or the store behind it. Nothing here adds a
 * mark; ingestion is the only writer of one.
 */
export function createExternalContentRouteHandler(dependencies: ExternalContentRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("invalid", "External-content requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure("invalid", "Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failure("invalid", "External-content requests must use POST.", 405, origin);
    }
    if (url.search !== "") {
      return failure("invalid", "External-content request is invalid.", 400, origin);
    }

    let context: PrincipalRouteContext;
    try {
      context = resolvePrincipalRouteContext({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      return error instanceof ClientPrincipalError && error.category !== "invalid"
        ? failure("unauthorized", "External-content request is unauthorized.", 401, origin)
        : failure("invalid", "External-content request is invalid.", 400, origin);
    }
    // Reviewing what a thread read is a person's act at this machine. A paired
    // device is refused the read as well, and the host's own scope is refused
    // although it resolves as local: nobody is at the window of a host-run turn.
    if (
      context.principal.kind !== "local-window" ||
      isRoutineHostScope(context.scopeId) ||
      authorizePrincipalAction({
        principalKind: context.principal.kind,
        action: "thread.external-content.clear",
      }).kind !== "allow"
    ) {
      return failure("unauthorized", "External-content request is unauthorized.", 401, origin);
    }

    const body = await readJson(request);
    if (body.kind === "too-large") {
      return failure("invalid", "External-content request is too large.", 413, origin);
    }
    let decoded: ThreadExternalContentRequest;
    try {
      if (body.kind !== "ok") throw new Error("invalid");
      decoded = decodeThreadExternalContentRequest(body.value);
    } catch {
      return failure("invalid", "External-content request is invalid.", 400, origin);
    }

    const threadId = String(decoded.threadId);
    const inspection = await dependencies.inspectThread({
      windowId: context.scopeId,
      mode: decoded.mode,
      threadId,
    });
    if (decoded.kind === "read") {
      return inspection === "unavailable"
        ? failure("unavailable", "This thread is unavailable.", 404, origin)
        : json(dependencies.clears.read(threadId), origin);
    }
    // A refusal is an answer the surface shows, so it travels as the outcome.
    return json(
      dependencies.clears.clear({
        threadId,
        windowId: context.scopeId,
        expectedVersion: decoded.expectedVersion,
        principal: "local-window",
        turn: inspection === "unavailable" ? "unknown" : inspection,
      }),
      origin,
    );
  };
}

async function readJson(
  request: Request,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function json(body: unknown, origin: string | null): Response {
  return Response.json(body, { status: 200, headers: corsHeaders(origin) });
}

function failure(
  category: ContextFailure["category"],
  message: string,
  status: number,
  origin: string | null,
): Response {
  return Response.json({ category, message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}
