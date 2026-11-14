import { decodeHostAnswer } from "@octant/contracts";
import {
  TodoListView,
  TodoResult,
  type TodoCommand,
  type TodoRefused,
} from "@octant/contracts/todos";
import type { MobileRemoteTransport } from "./mobileInboxClient";

/**
 * What reading or changing the list came to. A refusal (a device the host's
 * person did not pair, a list kept on another computer) and a failed request
 * are answers the screen shows, so none of them is thrown.
 */
export type MobileTodoResult =
  | { readonly status: "loaded"; readonly view: TodoListView }
  | { readonly status: "refused"; readonly refusal: TodoRefused }
  /**
   * `signed-out`: the computer answered but no longer accepts this phone's
   * pairing, which is not the same as being out of reach.
   */
  | { readonly status: "failed"; readonly reason: "unreachable" | "invalid" | "signed-out" };

async function answer(response: Promise<Response>): Promise<MobileTodoResult> {
  let reply: Response;
  try {
    reply = await response;
  } catch {
    return { status: "failed", reason: "unreachable" };
  }
  const notAccepted = reply.status === 401 || reply.status === 403;
  let body: unknown;
  try {
    body = await reply.json();
  } catch {
    if (notAccepted) return { status: "failed", reason: "signed-out" };
    return { status: "failed", reason: reply.ok ? "invalid" : "unreachable" };
  }
  try {
    const result = decodeHostAnswer(TodoResult)(body);
    return result.kind === "todo-refused"
      ? { status: "refused", refusal: result }
      : { status: "loaded", view: result };
  } catch {
    if (notAccepted) return { status: "failed", reason: "signed-out" };
    return { status: "failed", reason: reply.ok ? "invalid" : "unreachable" };
  }
}

/**
 * The person's to-do list on the host this phone is paired with, over the
 * paired session. The host serves it only to a device its own person paired,
 * and it decides every change.
 */
export function readMobileTodos(
  transport: MobileRemoteTransport,
  signal?: AbortSignal,
): Promise<MobileTodoResult> {
  return answer(
    transport.authenticatedFetch({
      method: "GET",
      path: "/api/todos",
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}

export function changeMobileTodos(
  transport: MobileRemoteTransport,
  command: TodoCommand,
): Promise<MobileTodoResult> {
  return answer(
    transport.authenticatedFetch({
      method: "POST",
      path: "/api/todos/commands",
      body: JSON.stringify(command),
      contentType: "application/json",
    }),
  );
}
