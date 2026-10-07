import {
  decodeProviderInstanceId,
  type ProviderInstance,
  type ProviderInstanceId,
} from "@octant/contracts";

import { authenticateProjectRequest } from "../projectBindingRoutes";
import { readPrincipalRouteContext } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ClaudeHelperSignInStore } from "./claudeHelperSignIn";
import type { ClaudeSetupTokenOutcome } from "./claudeSetupToken";

/** What Settings shows for "Connect Claude for helpers". Never carries the token. */
export type ClaudeHelperSignInView =
  | { readonly kind: "not-connected" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "expired" }
  | { readonly kind: "refused"; readonly reason: string };

export interface ClaudeHelperSignInService {
  readonly status: (instanceId: ProviderInstanceId) => Promise<ClaudeHelperSignInView>;
  readonly connect: (instanceId: ProviderInstanceId) => Promise<ClaudeHelperSignInView>;
  readonly disconnect: (instanceId: ProviderInstanceId) => Promise<ClaudeHelperSignInView>;
}

/**
 * One connect attempt per Claude Code instance at a time. The attempt runs
 * the installed `claude setup-token` and waits for the person's browser
 * approval, so Settings polls `status` until it settles.
 */
export function createClaudeHelperSignInService(dependencies: {
  readonly store: ClaudeHelperSignInStore;
  readonly readInstance: (instanceId: ProviderInstanceId) => ProviderInstance | undefined;
  readonly runSetupToken: (
    binaryPath: string,
    signal: AbortSignal,
  ) => Promise<ClaudeSetupTokenOutcome>;
}): ClaudeHelperSignInService & {
  /** Stops a waiting connect for a removed provider, then deletes the token it held. */
  readonly forgetRemovedProvider: (instanceId: ProviderInstanceId) => Promise<void>;
} {
  const attempts = new Map<
    string,
    { readonly settled: Promise<void>; readonly controller: AbortController }
  >();
  const refusals = new Map<string, string>();
  const subscriptionInstance = (instanceId: ProviderInstanceId) => {
    const instance = dependencies.readInstance(instanceId);
    if (
      instance === undefined ||
      instance.driverKind !== "claude" ||
      instance.configuration.authentication !== "subscription"
    ) {
      return undefined;
    }
    return instance;
  };
  const status = async (instanceId: ProviderInstanceId): Promise<ClaudeHelperSignInView> => {
    if (subscriptionInstance(instanceId) === undefined) {
      return { kind: "refused", reason: "Helpers connect only to a Claude subscription." };
    }
    if (attempts.has(String(instanceId))) return { kind: "connecting" };
    const stored = await dependencies.store.read(String(instanceId));
    if (stored.kind === "connected") return { kind: "connected" };
    const refusal = refusals.get(String(instanceId));
    if (refusal !== undefined) return { kind: "refused", reason: refusal };
    if (stored.kind === "expired") return { kind: "expired" };
    if (stored.kind === "unavailable") {
      return { kind: "refused", reason: "Octant's credential store is unavailable." };
    }
    return { kind: "not-connected" };
  };
  return {
    status,
    connect: async (instanceId) => {
      const instance = subscriptionInstance(instanceId);
      if (instance === undefined) return status(instanceId);
      const key = String(instanceId);
      if (attempts.has(key)) return { kind: "connecting" };
      refusals.delete(key);
      const controller = new AbortController();
      const settled = dependencies
        .runSetupToken(instance.configuration.binaryPath, controller.signal)
        .then(async (outcome) => {
          if (outcome.kind === "refused") {
            refusals.set(key, outcome.reason);
            return;
          }
          // The browser approval can take minutes. A provider removed or
          // switched to an API key meanwhile no longer names this token, so
          // keeping it would leave a year-long sign-in nothing can disconnect.
          if (subscriptionInstance(instanceId) === undefined) return;
          await dependencies.store.connect(key, outcome.token);
        })
        .catch(() => {
          refusals.set(key, "Octant could not keep the Claude sign-in. Try again.");
        })
        .finally(() => attempts.delete(key));
      attempts.set(key, { settled, controller });
      return { kind: "connecting" };
    },
    forgetRemovedProvider: async (instanceId) => {
      const key = String(instanceId);
      const attempt = attempts.get(key);
      attempt?.controller.abort();
      // Waiting lets an attempt already storing its token finish first, so
      // the delete below cannot run ahead of that write.
      await attempt?.settled;
      refusals.delete(key);
      await dependencies.store.disconnect(key);
    },
    disconnect: async (instanceId) => {
      if (subscriptionInstance(instanceId) === undefined) return status(instanceId);
      refusals.delete(String(instanceId));
      try {
        await dependencies.store.disconnect(String(instanceId));
      } catch {
        return { kind: "refused", reason: "Octant's credential store is unavailable." };
      }
      return status(instanceId);
    },
  };
}

const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export function createClaudeHelperSignInRouteHandler(dependencies: {
  readonly service: ClaudeHelperSignInService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly allowedRendererHttpOrigin?: string | null;
  readonly now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/providers/claude-helpers") return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || url.search !== "") {
      return json(refused("Octant did not accept this request."), 400, null);
    }
    if (
      origin !== null &&
      !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin)
    ) {
      return json(refused("Octant did not accept this request."), 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== "POST")
      return json(refused("Octant did not accept this request."), 400, origin);
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > 4_096)
        return json(refused("Octant did not accept this request."), 413, origin);
      body = JSON.parse(text) as unknown;
    } catch {
      return json(refused("Octant did not accept this request."), 400, origin);
    }
    try {
      authenticateProjectRequest({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError)
        return json(refused("Octant did not accept this request."), 401, origin);
      return json(refused("Octant is unavailable right now. Try again."), 503, origin);
    }
    const command = readCommand(body);
    if (command === undefined)
      return json(refused("Octant did not accept this request."), 400, origin);
    // The sign-in opens a browser on this Mac and waits for the person at it,
    // so only a local window may start or remove it.
    if (
      command.kind !== "status" &&
      readPrincipalRouteContext(request)?.principal.kind === "remote-device"
    ) {
      return json(
        { kind: "refused", reason: "Connect Claude for helpers on the Mac that runs Octant." },
        403,
        origin,
      );
    }
    try {
      const view =
        command.kind === "connect"
          ? await dependencies.service.connect(command.instanceId)
          : command.kind === "disconnect"
            ? await dependencies.service.disconnect(command.instanceId)
            : await dependencies.service.status(command.instanceId);
      return json(view, 200, origin);
    } catch {
      return json(refused("Octant is unavailable right now. Try again."), 503, origin);
    }
  };
}

function readCommand(
  value: unknown,
):
  | { readonly kind: "status" | "connect" | "disconnect"; readonly instanceId: ProviderInstanceId }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "status" && kind !== "connect" && kind !== "disconnect") return undefined;
  try {
    return { kind, instanceId: decodeProviderInstanceId(record.instanceId) };
  } catch {
    return undefined;
  }
}

function refused(reason: string): ClaudeHelperSignInView {
  return { kind: "refused", reason };
}

function json(body: ClaudeHelperSignInView, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(origin) },
  });
}

function cors(origin: string | null): Record<string, string> {
  return {
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "origin",
  };
}
