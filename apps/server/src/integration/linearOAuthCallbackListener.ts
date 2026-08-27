import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export const LINEAR_OAUTH_CALLBACK_PORTS = [52_693, 52_694, 52_695] as const;
export const LINEAR_OAUTH_CALLBACK_PATH = "/oauth/linear/callback";

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;
const ALLOWED_QUERY_KEYS = new Set(["code", "state", "error", "error_description"]);

export interface LinearOAuthCallbackListener {
  readonly redirectUri: string;
  readonly close: () => Promise<void>;
}

export async function startLinearOAuthCallbackListener(options: {
  readonly onAuthorize: (input: {
    readonly state: string;
    readonly code: string;
  }) => Promise<
    { readonly kind: "stored" } | { readonly kind: "refused"; readonly reason: string }
  >;
  readonly ports?: ReadonlyArray<number>;
  readonly timeoutMs?: number;
}): Promise<LinearOAuthCallbackListener> {
  const ports = options.ports ?? LINEAR_OAUTH_CALLBACK_PORTS;
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  let used = false;
  let closing: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const server = createServer((incoming, outgoing) => {
    void handleIncoming(
      incoming,
      options.onAuthorize,
      () => used,
      () => {
        used = true;
      },
    ).then((response) => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(response.body, () => {
        incoming.destroy();
        if (used) void close();
      });
    });
  });

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    if (timeout !== undefined) clearTimeout(timeout);
    closing = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    return closing;
  };

  const address = await listenLoopback(server, ports);
  timeout = setTimeout(() => {
    void close();
  }, timeoutMs);
  timeout.unref?.();

  return {
    redirectUri: `http://127.0.0.1:${address.port}${LINEAR_OAUTH_CALLBACK_PATH}`,
    close,
  };
}

async function listenLoopback(
  server: ReturnType<typeof createServer>,
  ports: ReadonlyArray<number>,
): Promise<AddressInfo> {
  let lastError: unknown;
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Linear OAuth callback listener is unavailable.");
      }
      return address;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Linear OAuth callback listener is unavailable.");
}

type AuthorizeCallback = (input: {
  readonly state: string;
  readonly code: string;
}) => Promise<{ readonly kind: "stored" } | { readonly kind: "refused"; readonly reason: string }>;

async function handleIncoming(
  incoming: IncomingMessage,
  onAuthorize: AuthorizeCallback,
  isUsed: () => boolean,
  markUsed: () => void,
): Promise<{ readonly status: number; readonly headers: Headers; readonly body: string }> {
  const peer = incoming.socket.remoteAddress ?? "";
  if (!isLoopbackPeer(peer)) return html("Linear connection failed.", 400);
  if (incoming.method !== "GET") return html("Linear connection failed.", 405);
  const origin = incoming.headers.origin;
  if (origin !== undefined && origin !== "null") return html("Linear connection failed.", 400);
  const host = incoming.headers.host ?? "127.0.0.1";
  const url = new URL(incoming.url ?? "/", `http://${host}`);
  if (url.pathname !== LINEAR_OAUTH_CALLBACK_PATH) return html("Linear connection failed.", 404);
  if ([...url.searchParams.keys()].some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    return html("Linear connection failed.", 400);
  }
  if (isUsed()) return html("Linear connection failed.", 400);
  markUsed();
  if (url.searchParams.get("error") !== null) {
    return html("Linear connection was cancelled.", 200);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null || code.length === 0 || state.length === 0) {
    return html("Linear connection failed.", 400);
  }
  const completed = await onAuthorize({ code, state });
  if (completed.kind !== "stored") return html("Linear connection failed.", 400);
  return html("Linear is connected. You can close this window and return to Octant.", 200);
}

function isLoopbackPeer(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function html(
  message: string,
  status: number,
): {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
} {
  const safe = message.replace(/[<>&]/g, "");
  return {
    status,
    headers: new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Octant</title></head><body><p>${safe}</p></body></html>`,
  };
}
