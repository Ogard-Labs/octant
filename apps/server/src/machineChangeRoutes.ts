import {
  decodeMachineChangeFrame,
  type MachineChangeFrame,
} from "@octant/contracts/machine-changes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

export interface MachineChangeRouteDependencies {
  readonly feed: {
    readonly subscribe: (input: {
      readonly afterSequence: number;
      readonly signal: AbortSignal;
    }) => AsyncIterable<MachineChangeFrame>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

export function createMachineChangeRouteHandler(dependencies: MachineChangeRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/machine/changes") return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Machine changes require loopback.", 400, origin);
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return failure("HTTP method is not supported.", 400, origin);
    }
    try {
      authenticateRouteWindowId({ request, store: dependencies.windowAuthorityStore, now: now() });
    } catch (error) {
      return failure(
        error instanceof WindowAuthorityError
          ? "Machine change request is unauthorized."
          : "Machine change request is invalid.",
        error instanceof WindowAuthorityError ? 401 : 400,
        origin,
      );
    }
    const afterSequence = Number(url.searchParams.get("afterSequence"));
    if (url.searchParams.size !== 1 || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return failure("Machine change cursor is invalid.", 400, origin);
    }
    return streamResponse(
      dependencies.feed.subscribe({ afterSequence, signal: request.signal }),
      request.signal,
      origin,
    );
  };
}

function streamResponse(
  frames: AsyncIterable<MachineChangeFrame>,
  signal: AbortSignal,
  origin: string | null,
): Response {
  const iterator = frames[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const abort = () => void iterator.return?.(undefined);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) {
          controller.close();
          return;
        }
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`${JSON.stringify(decodeMachineChangeFrame(next.value))}\n`),
        );
      } catch {
        controller.close();
      }
    },
    async cancel() {
      signal.removeEventListener("abort", abort);
      await iterator.return?.(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return Response.json(
    { category: status === 401 ? "unauthorized" : "invalid", message },
    { status, headers: corsHeaders(origin) },
  );
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "x-octant-window-capability",
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
  };
}
