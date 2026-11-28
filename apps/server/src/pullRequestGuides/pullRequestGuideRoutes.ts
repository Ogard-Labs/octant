import {
  decodePullRequestGuideQuery,
  decodePullRequestGuideWriteCommand,
  decodePullRequestViewedCommand,
  decodePullRequestViewedQuery,
  decodePullRequestViewedView,
  type PullRequestViewedView,
} from "@octant/contracts/pull-request-guide";
import type { PullRequestReviewTarget, WindowId } from "@octant/contracts";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { PullRequestGuideRefusal, PullRequestGuideService } from "./pullRequestGuideService";

const PREFIX = "/api/code/pull-request-guides";
const BODY_LIMIT = 16_384;

const REFUSAL_COPY: Readonly<Record<PullRequestGuideRefusal, readonly [number, string]>> = {
  "not-authorized": [403, "This window cannot reach that pull request."],
  "not-effective": [
    409,
    "No pull request guide writer plugin is active. Enable one in Settings → Skills & Extensions → Installed first.",
  ],
  "no-model": [409, "Pick a guide model in this Project's settings first."],
  running: [409, "A guide is already being written for this pull request."],
  "no-thread": [409, "Guides are written for pull requests linked to a Code thread."],
  unavailable: [503, "GitHub could not be read, so no guide was started."],
};

/** GitHub's Viewed state for one pull request, read and written through the host's `gh` login. */
export interface PullRequestViewedPort {
  read(
    windowId: WindowId,
    target: PullRequestReviewTarget,
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "read"; readonly view: PullRequestViewedView }
    | { readonly status: "refused" | "unavailable" }
  >;
  write(
    windowId: WindowId,
    input: {
      readonly target: PullRequestReviewTarget;
      readonly path: string;
      readonly viewed: boolean;
      readonly headSha?: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly status: "done" | "refused" | "head-moved" | "unavailable" }>;
}

/**
 * GitHub's Viewed list as the route answers it. A path the host cannot carry
 * (GitHub may return one not in NFC) drops that file alone, never every
 * file's checkbox; an unreadable list answers undefined.
 */
export function pullRequestViewedViewOf(
  files: ReadonlyArray<{ readonly path: string; readonly state: string }>,
): PullRequestViewedView | undefined {
  const carried = files.filter((file) => {
    try {
      decodePullRequestViewedView({ files: [file] });
      return true;
    } catch {
      return false;
    }
  });
  try {
    return decodePullRequestViewedView({ files: carried });
  } catch {
    return undefined;
  }
}

export interface PullRequestGuideRouteDependencies {
  readonly service: PullRequestGuideService;
  readonly viewed: PullRequestViewedPort;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
  };
}

/**
 * Review guides and Viewed files. Any authenticated reader of the pull
 * request reads its guide, so a paired phone reads guides too; starting a
 * guide run, which spends on the person's model, and reading or writing
 * GitHub's Viewed state, which acts under the person's GitHub name, answer
 * only to a local window.
 */
export function createPullRequestGuideRouteHandler(
  dependencies: PullRequestGuideRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    const json = (body: unknown, status: number): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...corsHeaders(origin) },
      });
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Pull request guide requests must use loopback." }, 400);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    let context;
    try {
      context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: error.message }, error.category === "invalid" ? 400 : 401);
      }
      throw error;
    }
    let body: unknown;
    try {
      const text = await request.text();
      if (Buffer.byteLength(text) > BODY_LIMIT) {
        return json({ error: "Request body is too large." }, 413);
      }
      body = JSON.parse(text);
    } catch {
      return json({ error: "Pull request guide request body is invalid JSON." }, 400);
    }
    const { principal, scopeId } = context;
    const path = url.pathname.slice(PREFIX.length);

    if (path === "/query") {
      let query;
      try {
        query = decodePullRequestGuideQuery(body);
      } catch {
        return json({ error: "Pull request guide query is invalid." }, 400);
      }
      const read = await dependencies.service.read(scopeId, query.target, query.headSha);
      return read.status === "read"
        ? json(read.view, 200)
        : json({ error: REFUSAL_COPY["not-authorized"][1], reason: "not-authorized" }, 403);
    }

    if (principal.kind !== "local-window") {
      return json(
        {
          error:
            path === "/write"
              ? "Guides are written from a window on this computer; a paired device reads them."
              : "Viewed files are marked from a window on this computer.",
          reason: "not-authorized",
        },
        403,
      );
    }

    if (path === "/write") {
      let command;
      try {
        command = decodePullRequestGuideWriteCommand(body);
      } catch {
        return json({ error: "Pull request guide request is invalid." }, 400);
      }
      const started = await dependencies.service.writeForPerson(scopeId, command.target);
      if (started.status === "refused") {
        const [status, error] = REFUSAL_COPY[started.reason];
        return json({ error, reason: started.reason }, status);
      }
      const read = await dependencies.service.read(scopeId, command.target, started.headSha);
      return read.status === "read" ? json(read.view, 202) : json({ error: "Refused." }, 403);
    }

    const signal = AbortSignal.timeout(30_000);
    if (path === "/viewed/query") {
      let query;
      try {
        query = decodePullRequestViewedQuery(body);
      } catch {
        return json({ error: "Viewed query is invalid." }, 400);
      }
      const read = await dependencies.viewed.read(scopeId, query.target, signal);
      if (read.status === "read") return json(read.view, 200);
      return read.status === "refused"
        ? json({ error: REFUSAL_COPY["not-authorized"][1], reason: "not-authorized" }, 403)
        : json({ error: "GitHub could not be read.", reason: "unavailable" }, 503);
    }

    if (path === "/viewed") {
      let command;
      try {
        command = decodePullRequestViewedCommand(body);
      } catch {
        return json({ error: "Viewed change is invalid." }, 400);
      }
      const written = await dependencies.viewed.write(
        scopeId,
        {
          target: command.target,
          path: String(command.path),
          viewed: command.viewed,
          ...(command.headSha === undefined ? {} : { headSha: String(command.headSha) }),
        },
        signal,
      );
      if (written.status === "done") return json({ status: "done" }, 200);
      if (written.status === "head-moved") {
        return json(
          {
            error: "A new push changed this pull request. Refresh it and review the file again.",
            reason: "head-moved",
          },
          409,
        );
      }
      return written.status === "refused"
        ? json({ error: REFUSAL_COPY["not-authorized"][1], reason: "not-authorized" }, 403)
        : json({ error: "GitHub did not take the change.", reason: "unavailable" }, 503);
    }

    return json({ error: "Pull request guide route not found." }, 404);
  };
}
