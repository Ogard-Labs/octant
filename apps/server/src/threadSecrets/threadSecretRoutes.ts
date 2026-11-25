import {
  decodePairedThreadSecretCommand,
  decodeThreadSecretCommand,
} from "@octant/contracts/thread-secrets";
import { Either } from "effect";
import { isAgentGrantSession, principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { readPrincipalRouteContext, resolvePrincipalRouteContext } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { ThreadSecretService } from "./threadSecretService";

export const THREAD_SECRETS_PATH = "/api/thread-secrets";
/** The one path the private listener forwards; nothing of a linked store is on it. */
export const PAIRED_THREAD_SECRETS_PATH = "/api/thread-secrets/paired";
/** Eight fields of the largest value, escaped. */
const MAX_BODY_BYTES = 262_144;

/**
 * The card's private submission. A value is read from the request's body into
 * the service and nowhere else: no reply, error or log repeats any part of it.
 */
export function createThreadSecretRoutes(
  service: ThreadSecretService,
  store: WindowAuthorityStore,
) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== THREAD_SECRETS_PATH) return undefined;
    const origin = request.headers.get("origin");
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(origin !== null && isAllowedRendererOrigin(origin)
        ? { "access-control-allow-origin": origin, vary: "Origin" }
        : {}),
    };
    const reply = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers });
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !isAllowedRendererOrigin(origin)))
      return reply({ status: "refused" }, 403);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type, x-octant-window-capability",
        },
      });
    const localWindow = (): string | undefined => {
      const context = resolvePrincipalRouteContext({ request, store, now: Date.now() });
      return context.principal.kind === "local-window" ? String(context.scopeId) : undefined;
    };
    let windowId: string | undefined;
    try {
      windowId = localWindow();
    } catch {
      return reply({ status: "refused" }, 401);
    }
    if (windowId === undefined) return reply({ status: "refused" }, 403);
    if (request.method === "GET") {
      if (url.search === "") return reply(service.hostView());
      const threadId = url.searchParams.get("threadId");
      if (
        !threadId ||
        threadId.length > 128 ||
        [...url.searchParams.keys()].some((key) => key !== "threadId")
      )
        return reply({ status: "invalid" }, 400);
      return reply(service.view(windowId, threadId));
    }
    if (
      request.method !== "POST" ||
      url.search ||
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
    )
      return reply({ status: "invalid" }, 400);
    const body = await boundedText(request);
    if (body === "too-large") return reply({ status: "invalid" }, 413);
    let command;
    try {
      command = decodeThreadSecretCommand(JSON.parse(body.text));
    } catch {
      return reply({ status: "invalid" }, 400);
    }
    if (Either.isLeft(command)) return reply({ status: "invalid" }, 400);
    // The body may have arrived slowly; the window may be gone.
    try {
      if (localWindow() !== windowId) return reply({ status: "refused" }, 403);
    } catch {
      return reply({ status: "refused" }, 401);
    }
    const { right } = command;
    switch (right.kind) {
      case "revoke":
        return reply(service.revoke(right.threadId, right.secretId));
      case "browse":
        return reply(await service.browse(windowId, right.threadId, right.requestId, right.step));
      case "forget":
        return reply(await service.forget(right.id));
      case "answer":
        return reply(
          await service.answer(windowId, right.threadId, right.answer, { paired: false }),
        );
    }
  };
}

/** Bounds the stream itself: a declared length can be wrong. */
async function boundedText(request: Request): Promise<{ readonly text: string } | "too-large"> {
  const reader = request.body?.getReader();
  if (reader === undefined) return { text: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return { text: Buffer.concat(chunks).toString("utf8") };
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) return "too-large";
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

type RemotePrincipal = Extract<
  NonNullable<ReturnType<typeof readPrincipalRouteContext>>["principal"],
  { readonly kind: "remote-device" }
>;

/**
 * The card on a phone. Only a device the person at this host paired reaches it,
 * over its authenticated session: an agent's grant, a device the hub introduced
 * and a local window are all refused. Nothing of a linked store is on it.
 */
export function createPairedThreadSecretRoutes(
  service: ThreadSecretService,
  deps: {
    readonly sessionCurrent: (principal: RemotePrincipal, sessionNow?: () => number) => boolean;
  },
) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PAIRED_THREAD_SECRETS_PATH) return undefined;
    const reply = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    const context = readPrincipalRouteContext(request);
    const principal = context?.principal;
    if (
      context === undefined ||
      principal?.kind !== "remote-device" ||
      !principalActsAsHostPerson(principal) ||
      isAgentGrantSession(principal)
    )
      return reply({ status: "refused" }, 403);
    if (
      request.method !== "POST" ||
      url.search ||
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
    )
      return reply({ status: "invalid" }, 400);
    const body = await boundedText(request);
    if (body === "too-large") return reply({ status: "invalid" }, 413);
    let command;
    try {
      command = decodePairedThreadSecretCommand(JSON.parse(body.text));
    } catch {
      return reply({ status: "invalid" }, 400);
    }
    if (Either.isLeft(command)) return reply({ status: "invalid" }, 400);
    // The body may have arrived slowly; the device may have been signed out.
    const current = () =>
      context.abortSignal?.aborted !== true && deps.sessionCurrent(principal, context.sessionNow);
    if (!current()) return reply({ status: "refused" }, 401);
    const { right } = command;
    const scopeId = String(context.scopeId);
    const reader = { paired: true, actor: eventActorForPrincipal(principal), current };
    return reply(
      right.kind === "list"
        ? { requests: service.view(scopeId, right.threadId, reader).requests, active: [] }
        : await service.answer(scopeId, right.threadId, right.answer, reader),
    );
  };
}
