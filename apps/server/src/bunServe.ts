import { MAX_CHAT_ATTACHMENT_BYTES } from "./chat/chatAttachmentStore";
import { parseListenerRequestHost, requestUrlStaysOnHost } from "./listenerRequestHost";
import { deriveTransportFactsFromPeer } from "./remoteRequestFacts";
import type { RequestTransportFacts, Serve } from "./server";
import {
  WEBSOCKET_RELAY_MAX_MESSAGE_BYTES,
  takeWebSocketUpgrade,
  type WebSocketPeerEvents,
  type WebSocketUpgradeAcceptance,
} from "./webSocketRelay";

interface BunRequestAddress {
  readonly address: string;
  readonly family: string;
  readonly port: number;
}

interface RelayedSocketData {
  readonly acceptance: WebSocketUpgradeAcceptance;
  events?: WebSocketPeerEvents;
}

type BunServer = {
  readonly requestIP: (request: Request) => BunRequestAddress | null;
  readonly upgrade: (
    request: Request,
    options: { readonly data: RelayedSocketData; readonly headers?: HeadersInit },
  ) => boolean;
  readonly url: URL;
  readonly stop: (closeActiveConnections?: boolean) => void;
};

export const bunServe: Serve = (options) => {
  const listenerTrust = options.listenerTrust ?? "loopback";
  const server = Bun.serve<RelayedSocketData>({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: options.maxRequestBodySize ?? MAX_CHAT_ATTACHMENT_BYTES,
    // Bun drops a request that has had no bytes for ten seconds by default. A
    // provider check or tool verification waits on a remote endpoint and
    // answers only when it is done, so a slow listing came back to the browser
    // as ERR_EMPTY_RESPONSE while the host kept working on it. 255 seconds is
    // Bun's maximum; the endpoint's own deadlines still bound the wait.
    idleTimeout: 255,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    fetch: (request, runtime: BunServer) => {
      const hostUrl = parseListenerRequestHost(
        request.headers.get("host"),
        runtime.url,
        options.hostname,
      );
      if (hostUrl === undefined) return invalidHostResponse();
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url);
      } catch {
        return invalidHostResponse();
      }
      if (!requestUrlStaysOnHost(requestUrl, hostUrl)) return invalidHostResponse();
      if (safeMethodDeclaresBody(request)) {
        return new Response("Request body too large", {
          status: 413,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const peer = runtime.requestIP(request);
      const facts = deriveTransportFactsFromPeer({
        peerAddress: peer === null ? undefined : peer.address,
        ...(peer === null ? {} : { family: peer.family }),
        listenerTrust,
      });
      return answerOrUpgrade(request, runtime, options.fetch(request, facts));
    },
    // Only an upgrade a route accepted reaches these; every other request
    // that asks to upgrade gets the route's ordinary answer.
    websocket: {
      maxPayloadLength: WEBSOCKET_RELAY_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      open: (socket) => {
        socket.data.events = socket.data.acceptance.open({
          send: (message) => {
            if (message.text) socket.sendText(new TextDecoder().decode(message.data));
            else socket.sendBinary(message.data);
          },
          close: (code, reason) => socket.close(code, reason),
        });
      },
      message: (socket, message) => {
        socket.data.events?.message(
          typeof message === "string"
            ? { text: true, data: new TextEncoder().encode(message) }
            : { text: false, data: new Uint8Array(message) },
        );
      },
      close: (socket, code, reason) => socket.data.events?.closed(code, reason),
    },
  });
  return server as unknown as ReturnType<Serve>;
};

/**
 * Switch the connection when the route's answer carries an accepted upgrade;
 * otherwise send the answer as it is.
 */
async function answerOrUpgrade(
  request: Request,
  runtime: BunServer,
  answer: Response | Promise<Response>,
): Promise<Response | undefined> {
  const response = await answer;
  const acceptance = takeWebSocketUpgrade(response);
  if (acceptance === undefined) return response;
  const upgraded = runtime.upgrade(request, {
    data: { acceptance },
    ...(acceptance.protocol === undefined
      ? {}
      : { headers: { "sec-websocket-protocol": acceptance.protocol } }),
  });
  if (upgraded) return undefined;
  acceptance.cancel();
  return new Response("Bad WebSocket handshake", { status: 400 });
}

function invalidHostResponse(): Response {
  return new Response("Invalid Host header", {
    status: 400,
    headers: {
      connection: "close",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function safeMethodDeclaresBody(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const contentLength = request.headers.get("content-length");
  const hasPositiveContentLength =
    contentLength !== null && /^\d+$/.test(contentLength) && BigInt(contentLength) > 0n;
  return hasPositiveContentLength || request.headers.has("transfer-encoding");
}

export type { RequestTransportFacts };
