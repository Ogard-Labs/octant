import {
  decodePullRequestReviewProjectQuery,
  decodePullRequestReviewProjectSettingsCommand,
  decodePullRequestReviewPullRequestQuery,
  decodePullRequestReviewPullRequestSettingsCommand,
  decodePullRequestReviewThreadOverrideCommand,
  decodePullRequestReviewThreadQuery,
} from "@octant/contracts";
import { principalActsAsHostPerson, principalAuthorityKind } from "../clientPrincipal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  PullRequestReviewService,
  PullRequestReviewSettingResult,
} from "./pullRequestReviewService";

const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 32_768;

const PREFIX = "/api/code/pull-request-reviews";
const PROJECT_QUERY_PATH = `${PREFIX}/project/query`;
const PROJECT_SET_PATH = `${PREFIX}/project`;
const THREAD_QUERY_PATH = `${PREFIX}/thread/query`;
const THREAD_SET_PATH = `${PREFIX}/thread`;
const PR_QUERY_PATH = `${PREFIX}/pr/query`;
const PR_SET_PATH = `${PREFIX}/pr`;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

function respondResult<TView>(
  result: PullRequestReviewSettingResult<TView>,
  origin: string | null,
): Response {
  if (result.status === "ok") {
    return json(result.view, 200, origin);
  }
  const status =
    result.reason === "not-authorized" ? 403 : result.reason === "not-found" ? 404 : 400;
  return json({ error: result.message, reason: result.reason }, status, origin);
}

async function readJsonBody(
  request: Request,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string }
> {
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > BODY_LIMIT) {
      return { ok: false, status: 413, message: "Request body is too large." };
    }
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: "Pull request review request body is invalid JSON." };
  }
}

export interface PullRequestReviewRouteDependencies {
  readonly service: PullRequestReviewService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * HTTP routes for pull request reviewer settings and status reads.
 *
 * Every mutation route requires `principalActsAsHostPerson(principal)` (a local
 * window or a device paired by the host's own person), refusing hub-introduced
 * and restricted devices with 403, and journals the change with
 * `eventActorForPrincipal(principal)`.
 */
export function createPullRequestReviewRouteHandler(
  dependencies: PullRequestReviewRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Pull request review requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failure("Method not allowed.", 405, origin);
    }

    let context;
    try {
      context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure(error.message, error.category === "invalid" ? 400 : 401, origin);
      }
      throw error;
    }

    const { principal, scopeId } = context;

    if (url.pathname === PROJECT_QUERY_PATH) {
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return failure(parsed.message, parsed.status, origin);
      let query;
      try {
        query = decodePullRequestReviewProjectQuery(parsed.value);
      } catch {
        return failure("Pull request review project query is invalid.", 400, origin);
      }
      return respondResult(
        await dependencies.service.queryProjectSettings(scopeId, query.projectId),
        origin,
      );
    }

    if (url.pathname === THREAD_QUERY_PATH) {
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return failure(parsed.message, parsed.status, origin);
      let query;
      try {
        query = decodePullRequestReviewThreadQuery(parsed.value);
      } catch {
        return failure("Pull request review thread query is invalid.", 400, origin);
      }
      return respondResult(
        await dependencies.service.queryThreadSettings(scopeId, query.threadId),
        origin,
      );
    }

    if (url.pathname === PR_QUERY_PATH) {
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return failure(parsed.message, parsed.status, origin);
      let query;
      try {
        query = decodePullRequestReviewPullRequestQuery(parsed.value);
      } catch {
        return failure("Pull request review query is invalid.", 400, origin);
      }
      return respondResult(
        await dependencies.service.queryPullRequestSettings(scopeId, query.target, query.threadId),
        origin,
      );
    }

    if (
      url.pathname === PROJECT_SET_PATH ||
      url.pathname === THREAD_SET_PATH ||
      url.pathname === PR_SET_PATH
    ) {
      if (!principalActsAsHostPerson(principal)) {
        return failure(
          "Pull request reviewer settings may only be changed from a local window or a device paired by the host's person.",
          403,
          origin,
        );
      }
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return failure(parsed.message, parsed.status, origin);
      const principalKind = principalAuthorityKind(principal);
      const actor = eventActorForPrincipal(principal);

      try {
        if (url.pathname === PROJECT_SET_PATH) {
          let command;
          try {
            command = decodePullRequestReviewProjectSettingsCommand(parsed.value);
          } catch {
            return failure("Pull request review project settings are invalid.", 400, origin);
          }
          return respondResult(
            await dependencies.service.updateProjectSettings(
              scopeId,
              command,
              principalKind,
              actor,
            ),
            origin,
          );
        }
        if (url.pathname === THREAD_SET_PATH) {
          let command;
          try {
            command = decodePullRequestReviewThreadOverrideCommand(parsed.value);
          } catch {
            return failure("Pull request review thread override is invalid.", 400, origin);
          }
          return respondResult(
            await dependencies.service.updateThreadOverride(scopeId, command, principalKind, actor),
            origin,
          );
        }
        let command;
        try {
          command = decodePullRequestReviewPullRequestSettingsCommand(parsed.value);
        } catch {
          return failure("Pull request review PR settings are invalid.", 400, origin);
        }
        return respondResult(
          await dependencies.service.updatePullRequestSettings(
            scopeId,
            command,
            principalKind,
            actor,
          ),
          origin,
        );
      } catch (error) {
        if (error instanceof ConcurrencyConflict) {
          return failure("Pull request review settings changed; reload and retry.", 409, origin);
        }
        return failure("Pull request review settings could not be updated.", 503, origin);
      }
    }

    return failure("Pull request review route not found.", 404, origin);
  };
}
