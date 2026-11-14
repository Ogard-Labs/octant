import {
  decodeTodoCommand,
  decodeTodoResult,
  type TodoCommand,
  type TodoResult,
} from "@octant/contracts/todos";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { TodoStore } from "./todoStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
/** A full to-do: notes at their bound, every Project and tag, with room for the JSON around them. */
const BODY_LIMIT = 32_768;
export const TODOS_PATH = "/api/todos";
export const TODO_COMMAND_PATH = "/api/todos/commands";

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

function refusal(reason: "malformed" | "unauthorized" | "changed-elsewhere", message: string) {
  return decodeTodoResult({ kind: "todo-refused", reason, message });
}

function statusFor(result: TodoResult): number {
  if (result.kind === "todo-list") return 200;
  if (result.reason === "not-found") return 404;
  return 409;
}

export interface TodoRouteDependencies {
  readonly store: Pick<TodoStore, "view" | "change">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * The person's to-do list. A window on this host and a device the host's
 * own person paired are that person and may read and change it. Every other
 * caller is refused, a read included: a device the hub introduced, a peer
 * host, and an agent grant's session act for someone other than the person,
 * and the list is the person's own words.
 */
export function createTodoRouteHandler(dependencies: TodoRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== TODOS_PATH && url.pathname !== TODO_COMMAND_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "To-do requests must use loopback." }, 400, null);
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
    if (!principalActsAsHostPerson(principal)) {
      return json(
        refusal(
          "unauthorized",
          "The to-do list can be seen and changed only by you, from a window on this computer or a device you paired.",
        ),
        403,
        origin,
      );
    }
    if (url.pathname === TODOS_PATH && request.method === "GET") {
      return json(dependencies.store.view(), 200, origin);
    }
    if (url.pathname === TODO_COMMAND_PATH && request.method === "POST") {
      let command: TodoCommand;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        command = decodeTodoCommand(JSON.parse(text) as unknown);
      } catch {
        return json(refusal("malformed", "That change to a to-do is not valid."), 400, origin);
      }
      let result: TodoResult;
      try {
        result = dependencies.store.change(command, eventActorForPrincipal(principal));
      } catch (error) {
        if (error instanceof ConcurrencyConflict) {
          return json(
            refusal("changed-elsewhere", "The list changed while saving. Reload it and try again."),
            409,
            origin,
          );
        }
        throw error;
      }
      return json(result, statusFor(result), origin);
    }
    return json({ error: "To-do route is not found." }, 404, origin);
  };
}
