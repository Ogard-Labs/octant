import { handleApi, refusal } from "./api.ts";
import type { ShareConfig } from "./config.ts";
import { PRIVATE_HEADERS, type ServiceContext } from "./context.ts";
import { handleFrame } from "./frames.ts";
import { RateLimiter, clientAddress } from "./rateLimit.ts";
import { ShareStore, type Clock, type RandomBytes } from "./store.ts";
import { handleViewer } from "./viewer.ts";

export interface ShareServiceDependencies {
  readonly clock?: Clock;
  readonly randomBytes?: RandomBytes;
}

export interface ShareService {
  readonly publicUrl: string;
  readonly usercontentUrl: string;
  stop(): void;
}

/**
 * Starts the two listeners: the public origin for the API and viewer pages,
 * and the user-content origin for design frames. Nothing is logged per
 * request; the service keeps no access log by design.
 */
export function startShareService(
  config: ShareConfig,
  dependencies: ShareServiceDependencies = {},
): ShareService {
  const clock = dependencies.clock ?? Date.now;
  const store = new ShareStore(config.dataDir, {
    clock,
    ...(dependencies.randomBytes === undefined ? {} : { randomBytes: dependencies.randomBytes }),
    maxTotalBytes: config.maxTotalBytes,
  });
  const limiter = new RateLimiter(clock);
  let context: ServiceContext | undefined;

  const publicServer = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: async (request, server) => {
      if (context === undefined) return new Response("Starting", { status: 503 });
      const url = new URL(request.url);
      const client = clientAddress(request, server.requestIP(request)?.address, config.trustProxy);
      if (url.pathname === "/healthz" && request.method === "GET") {
        return new Response("ok", {
          headers: { ...PRIVATE_HEADERS, "content-type": "text/plain; charset=utf-8" },
        });
      }
      try {
        const api = await handleApi(request, url, context, client);
        if (api !== undefined) return api;
        const viewer = await handleViewer(request, url, context, client);
        if (viewer !== undefined) return viewer;
      } catch {
        // A failure names nothing about the request it came from.
        return refusal("unavailable", "The service could not answer. Try again.");
      }
      return refusal("not-found", "There is no such route.");
    },
  });
  const usercontentServer = Bun.serve({
    hostname: config.host,
    port: config.usercontentPort,
    fetch: (request) =>
      context === undefined
        ? new Response("Starting", { status: 503 })
        : handleFrame(request, context),
  });

  const publicOrigin = config.publicOrigin ?? `http://${config.host}:${String(publicServer.port)}`;
  const usercontentOrigin =
    config.usercontentOrigin ?? `http://${config.host}:${String(usercontentServer.port)}`;
  if (new URL(publicOrigin).origin === new URL(usercontentOrigin).origin) {
    publicServer.stop(true);
    usercontentServer.stop(true);
    throw new Error("The public origin and the user-content origin must differ.");
  }
  context = { config, store, limiter, publicOrigin, usercontentOrigin };
  store.startSweeping();

  return {
    publicUrl: publicOrigin,
    usercontentUrl: usercontentOrigin,
    stop: () => {
      store.stopSweeping();
      void publicServer.stop(true);
      void usercontentServer.stop(true);
    },
  };
}
