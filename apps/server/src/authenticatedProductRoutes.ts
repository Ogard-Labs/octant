import { authorizePrincipalAction } from "@octant/domain";
import type { ClientPrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext, resolvePrincipalRouteContext } from "./principalRouteContext";

export interface AuthenticatedProductDispatchHandoff {
  readonly request: Request;
  readonly principal: ClientPrincipal;
  readonly abortSignal?: AbortSignal;
  readonly freshness?: "current" | "rotation-due";
  readonly requestFacts?: unknown;
}

export interface AuthenticatedProductDispatchOptions {
  readonly dispatch: (request: Request) => Response | undefined | Promise<Response | undefined>;
}

/**
 * Adapt the remote authentication handoff to the existing product route
 * chain. Authentication is complete before this function runs; it binds the
 * verified principal, applies the least-authority catalog, and then lets the
 * route/service re-check mode, Project, thread, root, and approval state.
 */
export function createAuthenticatedProductDispatch(
  options: AuthenticatedProductDispatchOptions,
): (handoff: AuthenticatedProductDispatchHandoff) => Promise<Response | undefined> {
  return async (handoff) => {
    const action = classifyProductAction(handoff.request);
    const decision = authorizePrincipalAction({
      principalKind: handoff.principal.kind,
      action: action ?? "",
    });
    if (decision.kind === "deny") return unauthorizedResponse();

    const context = resolvePrincipalRouteContext({
      request: handoff.request,
      principal: handoff.principal,
      ...(handoff.abortSignal === undefined ? {} : { abortSignal: handoff.abortSignal }),
    });
    bindPrincipalRouteContext(handoff.request, context);
    const internalRequest = makeLoopbackDispatchRequest(handoff.request);
    bindPrincipalRouteContext(internalRequest, context);
    return options.dispatch(internalRequest);
  };
}

/** Map only the bounded authenticated web product surface to catalogued actions. */
export function classifyProductAction(request: Request): string | undefined {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path.startsWith("/api/chat/")) {
    if (method === "POST" && (path.endsWith("/commands") || path === "/api/chat/attachments")) {
      return "chat.send-turn";
    }
    if (method === "GET" || method === "HEAD") return "project.overview.read";
    return undefined;
  }
  if (path.startsWith("/api/work/")) {
    if (method === "POST" && path === "/api/work/board") return "project.overview.read";
    if (method === "POST") return "work.update-document";
    if (method === "GET" || method === "HEAD") return "project.overview.read";
    return undefined;
  }
  if (path.startsWith("/api/code/")) {
    if (method === "POST" && path === "/api/code/board") return "project.overview.read";
    if (method === "PUT" && path === "/api/code/evidence") return "code.plan-turn";
    if (method === "POST" && path.includes("/threads")) return "code.create-thread";
    // Local servers is a catalogued authority of its own, so it must not
    // ride in on the Code turn action. Admission is granted at the surface's
    // least authority; the service re-derives the actor from the bound
    // principal and the domain policy still keeps a leftover Stop on the host.
    if (method === "POST" && path === "/api/code/local-servers/commands") {
      return "code.local-servers.list";
    }
    if (method === "POST" && path.endsWith("/commands")) return "code.plan-turn";
    if (method === "GET" || method === "HEAD") return "project.overview.read";
    return undefined;
  }
  if (path.startsWith("/api/projects/")) {
    return method === "GET" || method === "HEAD" ? "project.overview.read" : undefined;
  }
  if (path.startsWith("/api/context/")) {
    // Inspect and commands share one POST-only handler, so only an exact path
    // separates them: inspect returns a context snapshot, while commands
    // mutate the harness and stay denied for a remote device. Admission is
    // still only forwarding: the route authenticates the window and refuses
    // any window identity supplied by the caller before answering.
    if (method === "POST" && path === "/api/context/inspect") return "project.overview.read";
    return method === "GET" || method === "HEAD" ? "project.overview.read" : undefined;
  }
  if (path.startsWith("/api/preview/")) {
    return method === "GET" || method === "HEAD" ? "preview.open-authorized" : undefined;
  }
  if (path.startsWith("/api/artifacts")) {
    // The library gathers artifacts across every Project on this host, which is
    // wider than a window's own Project scope. A paired device is admitted to
    // read it and to nothing else here: the service clamps which Projects it
    // may see, and there is no write on this surface at all.
    if (method === "POST" && path === "/api/artifacts/library") {
      return "project.overview.read";
    }
    return undefined;
  }
  if (path.startsWith("/api/canvas/")) {
    // Opening a shared snapshot is a read, and it is POST because the request
    // carries the snapshot it is opening. Denying it here made the audience
    // check unreachable for the only caller it exists for: a paired device is
    // exactly who a share names, and the route now evaluates the asking
    // principal against that audience rather than the owner. Minting and
    // revoking a share stay owner-only and stay denied for a remote device.
    if (method === "POST" && path === "/api/canvas/share-access") {
      return "project.overview.read";
    }
    if (
      method === "POST" &&
      (path.endsWith("/revise") || path.endsWith("/refresh") || path.endsWith("/refresh-cancel"))
    ) {
      return "project.overview.read";
    }
    return method === "GET" || method === "HEAD" ? "project.overview.read" : undefined;
  }
  if (path === "/api/providers/bootstrap") {
    return method === "GET" || method === "HEAD" ? "provider.list-models" : undefined;
  }
  if (path.startsWith("/api/github/")) {
    // A paired user can explicitly confirm host-local GitHub authentication
    // lifecycle commands. The final route still rejects providers/automation
    // and validates the command confirmation; this only prevents the remote
    // gateway from making that supported headless-host path unreachable.
    if (
      method === "GET" ||
      method === "HEAD" ||
      (method === "POST" && path === "/api/github/authentication/commands")
    ) {
      return "settings.read-non-secret";
    }
    return undefined;
  }
  if (path === "/api/diagnostics/export") {
    return method === "POST" ? "diagnostics.export" : undefined;
  }
  if (path === "/api/threads/export") {
    // A thread export is a read of a thread the caller can already Open.
    // The service re-checks that Open and clamps to that one thread, so a
    // paired device never dumps the host.
    return method === "POST" ? "project.overview.read" : undefined;
  }
  if (path.startsWith("/api/automations")) {
    // Ordinary Automation Center mutations are remote-approvable per the
    // design's per-command policy; the route still re-checks host, Project,
    // and version before journaling.
    if (method === "POST" && path === "/api/automations/commands") return "automation.manage";
    return method === "GET" || method === "HEAD" ? "project.overview.read" : undefined;
  }
  if (path.startsWith("/api/automation-notifications")) {
    // Honest delivery status and preference reads are non-secret. Preference
    // mutation stays local-window and is refused by the route for remote.
    return method === "GET" || method === "HEAD" ? "settings.read-non-secret" : undefined;
  }
  if (path.startsWith("/api/usage/")) {
    // Every Usage read is POST by construction — the routes answer 405 to any
    // other method — so admitting only GET/HEAD left the whole surface
    // unreadable from a paired browser. Reset and retain purge the host-wide
    // ledger and stay denied for a remote device. Admission is still only
    // forwarding: the route authenticates the window and scopes the read to
    // that window's Projects before answering.
    if (
      method === "POST" &&
      (path === "/api/usage/dashboard" ||
        path === "/api/usage/query" ||
        path === "/api/usage/export")
    ) {
      return "settings.read-non-secret";
    }
    return method === "GET" || method === "HEAD" ? "settings.read-non-secret" : undefined;
  }
  if (path.startsWith("/api/extensions/")) {
    // The Extension API is POST-only — it answers 405 to any other method — so
    // a GET/HEAD-only classification denied every extension request the remote
    // route policy forwards. That forward list is already the read subset:
    // lifecycle and skills are local-only, and tool approvals and local folder
    // import are never forwarded and stay local-window at the route. Each of
    // these five carries exactly one read command, or no body at all for the
    // snapshot. Admission is still only forwarding: the route resolves the
    // authenticated principal before answering.
    //
    // Inspect and preview take a caller-supplied source, so what keeps this
    // from becoming remote reach into arbitrary host directories is that a
    // `local-folder` source names an opaque registry reference rather than a
    // path: an unregistered one resolves to nothing, and registering one is
    // `import-local`, which is never forwarded and stays local-window.
    if (
      method === "POST" &&
      (path === "/api/extensions/catalog" ||
        path === "/api/extensions/inspect" ||
        path === "/api/extensions/preview" ||
        path === "/api/extensions/snapshot" ||
        path === "/api/extensions/state")
    ) {
      return "settings.read-non-secret";
    }
    return method === "GET" || method === "HEAD" ? "settings.read-non-secret" : undefined;
  }
  if (path.startsWith("/api/validation/")) {
    // Validation evidence is the only route on this prefix and is POST-only by
    // construction, so admitting only GET/HEAD left every evidence pane blank
    // on a paired browser. Admission is still only forwarding: the route
    // authenticates the window and re-checks the requested tool authority
    // against it before loading any snapshot.
    if (method === "POST" && path === "/api/validation/evidence") {
      return "settings.read-non-secret";
    }
    return method === "GET" || method === "HEAD" ? "settings.read-non-secret" : undefined;
  }
  if (path.startsWith("/api/browser/")) {
    // A companion client watches the page the host already opened and acts
    // inside it. Reading the thread's scope, its current context, and the
    // latest observation are reads; the action route carries the gestures.
    // Creating, releasing, cancelling, and stopping a browser session are not
    // listed, so they stay denied. The route re-derives the principal and
    // refuses every action kind that would drive the host rather than act
    // within its view.
    if (
      method === "POST" &&
      (path === "/api/browser/scope" ||
        path === "/api/browser/contexts/current" ||
        path === "/api/browser/contexts/inspect")
    ) {
      return "browser.observe";
    }
    if (method === "POST" && path === "/api/browser/actions") return "browser.interact";
    return method === "GET" || method === "HEAD" ? "settings.read-non-secret" : undefined;
  }
  if (
    path === "/api/agent-profiles" ||
    path.startsWith("/api/agent-profiles/") ||
    path.startsWith("/api/theme/") ||
    path.startsWith("/api/apple/") ||
    path.startsWith("/api/computer-use/") ||
    path.startsWith("/api/zen")
  ) {
    return method === "GET" || method === "HEAD" ? "settings.read-non-secret" : undefined;
  }
  return undefined;
}

function unauthorizedResponse(): Response {
  return Response.json(
    { category: "unauthorized", message: "Remote action is not authorized." },
    {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

/**
 * Existing product handlers deliberately reject non-loopback origins. Remote
 * authentication has already proved the configured remote origin, so dispatch
 * a loopback-shaped internal request while retaining the remote principal in
 * the bound context. The original request URL/headers never reach a product
 * handler and the signed path/query/body remain unchanged.
 */
function makeLoopbackDispatchRequest(request: Request): Request {
  const source = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("host", "127.0.0.1");
  headers.set("origin", "http://127.0.0.1");
  if (request.body === null) {
    return new Request(`http://127.0.0.1${source.pathname}${source.search}`, {
      method: request.method,
      headers,
      signal: request.signal,
    });
  }
  const init = {
    method: request.method,
    headers,
    body: request.clone().body,
    signal: request.signal,
    duplex: "half" as const,
  } satisfies RequestInit & { duplex: "half" };
  return new Request(`http://127.0.0.1${source.pathname}${source.search}`, init);
}
