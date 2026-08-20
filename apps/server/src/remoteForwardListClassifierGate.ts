import { classifyRemoteAction } from "@octant/domain";
import { classifyProductAction } from "./authenticatedProductRoutes";
import { createRemoteRoutePolicy, listDefaultRemoteAuthenticatedRoutes } from "./remoteRoutePolicy";

const GATE_ORIGIN = "https://octant.example:8443";

/**
 * Paths the private listener must never forward: host-wide ledger purges,
 * diagnostics export, and local-only administration.
 */
const LOCAL_ONLY_PROBES = [
  { path: "/api/usage/reset", method: "POST" },
  { path: "/api/usage/retain", method: "POST" },
  { path: "/api/diagnostics/export", method: "POST" },
  { path: "/api/host-control/status", method: "GET" },
  { path: "/api/host-control/lifecycle", method: "POST" },
  { path: "/api/extensions/lifecycle", method: "POST" },
  { path: "/api/desktop/window-authorities", method: "GET" },
] as const;

/**
 * Representative product paths under each forwarded prefix.
 */
const PRODUCT_PROBES = [
  { path: "/api/chat/bootstrap", method: "GET" },
  { path: "/api/chat/commands", method: "POST" },
  { path: "/api/chat/attachments", method: "POST" },
  { path: "/api/code/board", method: "POST" },
  { path: "/api/code/evidence", method: "PUT" },
  { path: "/api/code/local-servers/commands", method: "POST" },
  { path: "/api/providers/bootstrap", method: "GET" },
  { path: "/api/github/authentication", method: "GET" },
  { path: "/api/github/authentication/commands", method: "POST" },
  { path: "/api/usage/dashboard", method: "POST" },
  { path: "/api/usage/query", method: "POST" },
  { path: "/api/usage/export", method: "POST" },
  { path: "/api/extensions/catalog", method: "POST" },
  { path: "/api/extensions/inspect", method: "POST" },
  { path: "/api/extensions/preview", method: "POST" },
  { path: "/api/extensions/snapshot", method: "POST" },
  { path: "/api/extensions/state", method: "POST" },
  { path: "/api/validation/evidence", method: "POST" },
  { path: "/api/context/inspect", method: "POST" },
  { path: "/api/browser/scope", method: "POST" },
  { path: "/api/browser/actions", method: "POST" },
  { path: "/api/automations/list", method: "GET" },
  { path: "/api/automations/commands", method: "POST" },
  { path: "/api/canvas/share-access", method: "POST" },
  { path: "/api/agent-profiles", method: "GET" },
] as const;

export interface ForwardListClassifierMismatch {
  readonly path: string;
  readonly method: string;
  readonly reason:
    | "forwarded-local-host-required"
    | "local-only-forwarded"
    | "classified-remote-not-forwarded";
  readonly action?: string;
}

/**
 * Compare the default remote forward list with the product route classifier.
 *
 * A forwarded path must never classify as local-host-required. A local-only
 * path must never be forwarded. A classified remote-approvable product path
 * in the probe set must be forwarded, or the two lists have drifted.
 */
export function compareRemoteForwardListToClassifier(): ReadonlyArray<ForwardListClassifierMismatch> {
  const policy = createRemoteRoutePolicy({ origin: GATE_ORIGIN });
  const mismatches: Array<ForwardListClassifierMismatch> = [];
  const probes = [
    ...PRODUCT_PROBES,
    ...listDefaultRemoteAuthenticatedRoutes().flatMap((route) =>
      route.methods.map((method) => ({ path: route.match.path, method })),
    ),
  ];
  const seen = new Set<string>();
  for (const probe of probes) {
    const key = `${probe.method} ${probe.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const forwarded = isForwarded(policy, probe.path, probe.method);
    const action = classifyProductAction(productRequest(probe.path, probe.method));
    const remote = classifyRemoteAction(action ?? "");
    if (forwarded && remote.kind === "local-host-required") {
      mismatches.push({
        path: probe.path,
        method: probe.method,
        reason: "forwarded-local-host-required",
        ...(action === undefined ? {} : { action }),
      });
    }
    if (!forwarded && remote.kind === "remote-approvable") {
      mismatches.push({
        path: probe.path,
        method: probe.method,
        reason: "classified-remote-not-forwarded",
        ...(action === undefined ? {} : { action }),
      });
    }
  }

  for (const probe of LOCAL_ONLY_PROBES) {
    if (isForwarded(policy, probe.path, probe.method)) {
      mismatches.push({
        path: probe.path,
        method: probe.method,
        reason: "local-only-forwarded",
      });
    }
  }

  return mismatches;
}

export function defaultRemoteAuthenticatedRouteCount(): number {
  return listDefaultRemoteAuthenticatedRoutes().length;
}

function isForwarded(
  policy: ReturnType<typeof createRemoteRoutePolicy>,
  path: string,
  method: string,
): boolean {
  const decision = policy.inspect(productRequest(path, method));
  return decision.kind === "allow" && decision.surface === "authenticated-product";
}

function productRequest(path: string, method: string): Request {
  return new Request(`${GATE_ORIGIN}${path}`, {
    method,
    headers: {
      host: "octant.example:8443",
      origin: GATE_ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json" }),
    },
  });
}
