import { MAX_CHAT_ATTACHMENT_BYTES } from "./chat/chatAttachmentStore";
import { deriveTransportFactsFromPeer } from "./remoteRequestFacts";
import type { RequestTransportFacts, Serve } from "./server";

interface BunRequestAddress {
  readonly address: string;
  readonly family: string;
  readonly port: number;
}

type BunServer = {
  readonly requestIP: (request: Request) => BunRequestAddress | null;
  readonly url: URL;
  readonly stop: (closeActiveConnections?: boolean) => void;
};

export const bunServe: Serve = (options) => {
  const listenerTrust = options.listenerTrust ?? "loopback";
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: options.maxRequestBodySize ?? MAX_CHAT_ATTACHMENT_BYTES,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    fetch: (request, runtime: BunServer) => {
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
      return options.fetch(request, facts);
    },
  });
  return server as unknown as ReturnType<Serve>;
};

function safeMethodDeclaresBody(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const contentLength = request.headers.get("content-length");
  const hasPositiveContentLength =
    contentLength !== null && /^\d+$/.test(contentLength) && BigInt(contentLength) > 0n;
  return hasPositiveContentLength || request.headers.has("transfer-encoding");
}

export type { RequestTransportFacts };
