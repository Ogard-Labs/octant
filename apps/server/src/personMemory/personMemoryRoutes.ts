import {
  decodePersonMemoryCommand,
  decodePersonMemoryResult,
  type PersonMemoryCommand,
} from "@octant/contracts/person-memory";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { PersonMemoryStore } from "./personMemoryStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 8_192;
export const PERSON_MEMORY_PATH = "/api/person-memory";
export const PERSON_MEMORY_COMMAND_PATH = "/api/person-memory/commands";

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

export interface PersonMemoryRouteDependencies {
  readonly store: Pick<PersonMemoryStore, "view" | "change">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Settings › Memory. Reading and changing both need a window on this host: a
 * paired device may be granted only some Projects, and person memory crosses
 * them, so a device is refused even a read.
 */
export function createPersonMemoryRouteHandler(dependencies: PersonMemoryRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PERSON_MEMORY_PATH && url.pathname !== PERSON_MEMORY_COMMAND_PATH) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Memory requests must use loopback." }, 400, null);
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
    if (principal.kind !== "local-window") {
      return json(
        decodePersonMemoryResult({
          kind: "person-memory-refused",
          reason: "unauthorized",
          message: "Memory can be seen and changed only from a window on this computer.",
        }),
        403,
        origin,
      );
    }
    if (url.pathname === PERSON_MEMORY_PATH && request.method === "GET") {
      return json(dependencies.store.view(), 200, origin);
    }
    if (url.pathname === PERSON_MEMORY_COMMAND_PATH && request.method === "POST") {
      let command: PersonMemoryCommand;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        command = decodePersonMemoryCommand(JSON.parse(text) as unknown);
      } catch {
        return json(
          decodePersonMemoryResult({
            kind: "person-memory-refused",
            reason: "malformed",
            message: "That change is not valid.",
          }),
          400,
          origin,
        );
      }
      const result = dependencies.store.change(command);
      return json(result, result.kind === "person-memory-refused" ? 409 : 200, origin);
    }
    return json({ error: "Memory route is not found." }, 404, origin);
  };
}
