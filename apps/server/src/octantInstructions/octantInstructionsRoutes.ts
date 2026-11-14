import {
  decodeOctantInstructionsCommand,
  decodeOctantInstructionsResult,
  type OctantInstructionsCommand,
} from "@octant/contracts/octant-instructions";
import { isAgentGrantSession, principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { refusedOctantInstructions, type OctantInstructionsStore } from "./octantInstructionsStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
/** The longest text with JSON escaping and the command around it. */
const BODY_LIMIT = 65_536;
export const OCTANT_INSTRUCTIONS_PATH = "/api/octant-instructions";
export const OCTANT_INSTRUCTIONS_COMMAND_PATH = "/api/octant-instructions/commands";

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

export interface OctantInstructionsRouteDependencies {
  readonly store: Pick<OctantInstructionsStore, "view" | "change">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Settings › General: Your instructions. Only the host's own person changes
 * them, from a window on this host or a device that person paired. Any other
 * authenticated client reads them read-only, except an agent grant's session:
 * agents read the texts only as the context blocks a turn receives.
 */
export function createOctantInstructionsRouteHandler(
  dependencies: OctantInstructionsRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      url.pathname !== OCTANT_INSTRUCTIONS_PATH &&
      url.pathname !== OCTANT_INSTRUCTIONS_COMMAND_PATH
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Instruction requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      }).principal;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: error.message }, error.category === "invalid" ? 400 : 401, origin);
      }
      throw error;
    }
    if (isAgentGrantSession(principal)) {
      return json(refusedOctantInstructions("not-the-person"), 403, origin);
    }
    const actsAsPerson = principalActsAsHostPerson(principal);
    if (url.pathname === OCTANT_INSTRUCTIONS_PATH && request.method === "GET") {
      return json(dependencies.store.view(actsAsPerson), 200, origin);
    }
    if (url.pathname === OCTANT_INSTRUCTIONS_COMMAND_PATH && request.method === "POST") {
      if (!actsAsPerson) return json(refusedOctantInstructions("not-the-person"), 403, origin);
      let command: OctantInstructionsCommand;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        command = decodeOctantInstructionsCommand(JSON.parse(text) as unknown);
      } catch {
        return json(refusedOctantInstructions("malformed"), 400, origin);
      }
      const result = decodeOctantInstructionsResult(
        dependencies.store.change(command, eventActorForPrincipal(principal)),
      );
      const status =
        result.kind === "octant-instructions"
          ? 200
          : result.reason === "not-the-person"
            ? 403
            : 409;
      return json(result, status, origin);
    }
    return json({ error: "Instruction route is not found." }, 404, origin);
  };
}
