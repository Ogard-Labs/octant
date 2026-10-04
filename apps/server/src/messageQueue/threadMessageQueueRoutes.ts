import {
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueueScope,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueueResult,
  type ThreadMessageQueueReadResult,
  type ThreadMessageQueueScope,
  type WindowId,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

const MAX_BODY_BYTES = 1024 * 1024 + 4096;

export interface ThreadMessageQueueRouteDependencies {
  readonly service: {
    readonly read: (
      windowId: WindowId,
      scope: ThreadMessageQueueScope,
    ) => Promise<ThreadMessageQueueReadResult>;
    readonly execute: (
      windowId: WindowId,
      command: ThreadMessageQueueCommand,
    ) => Promise<ThreadMessageQueueResult>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

export function createThreadMessageQueueRouteHandler(deps: ThreadMessageQueueRouteDependencies) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      url.pathname !== "/api/thread-message-queue" &&
      url.pathname !== "/api/thread-message-queue/commands"
    )
      return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || !allowedOrigin(origin))
      return response({ error: "Queue request origin is not allowed." }, 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: headers(origin) });
    const read = request.method === "GET" && url.pathname === "/api/thread-message-queue";
    const command =
      request.method === "POST" && url.pathname === "/api/thread-message-queue/commands";
    if (!read && !command)
      return response({ error: "Queue method is not supported." }, 405, origin);
    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: deps.windowAuthorityStore,
        now: (deps.now ?? Date.now)(),
      });
    } catch (error) {
      return response(
        { error: "Queue request is unauthorized." },
        error instanceof WindowAuthorityError ? 401 : 400,
        origin,
      );
    }
    if (read) {
      let scope: ThreadMessageQueueScope;
      try {
        if (url.searchParams.size !== 2)
          return response({ error: "Queue target is invalid." }, 400, origin);
        scope = decodeThreadMessageQueueScope({
          mode: url.searchParams.get("mode"),
          threadId: url.searchParams.get("threadId"),
        });
      } catch {
        return response({ error: "Queue target is invalid." }, 400, origin);
      }
      try {
        return response(await deps.service.read(windowId, scope), 200, origin);
      } catch {
        return response({ error: "Queue could not be read." }, 503, origin);
      }
    }
    if (url.search !== "")
      return response({ error: "Queue command target is invalid." }, 400, origin);
    const body = await readBoundedBody(request);
    if (body.status === "too-large")
      return response({ error: "Queue command is too large." }, 413, origin);
    if (body.status !== "ready")
      return response({ error: "Queue command is invalid." }, 400, origin);
    let decoded: ThreadMessageQueueCommand;
    try {
      decoded = decodeThreadMessageQueueCommand(body.value);
    } catch {
      return response({ error: "Queue command is invalid." }, 400, origin);
    }
    try {
      return response(await deps.service.execute(windowId, decoded), 200, origin);
    } catch {
      return response({ error: "Queue could not be updated." }, 503, origin);
    }
  };
}

async function readBoundedBody(
  request: Request,
): Promise<
  | { readonly status: "ready"; readonly value: unknown }
  | { readonly status: "invalid" | "too-large" }
> {
  if (request.body === null) return { status: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return { status: "too-large" };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { status: "ready", value };
  } catch {
    return { status: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

function allowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname) || url.protocol === "file:";
  } catch {
    return false;
  }
}
function headers(origin: string | null): Record<string, string> {
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
  };
}
function response(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}
