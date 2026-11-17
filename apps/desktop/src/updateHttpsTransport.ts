import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isPrivateAddress } from "./privateAddress";

export { isPrivateAddress };

const MAX_CONTENT_ENCODINGS = 4;

export class UpdateDestinationRefused extends Error {
  override readonly name = "UpdateDestinationRefused";

  constructor(readonly reason: "credentials" | "private-address" | "scheme") {
    super(`Update destination refused: ${reason}.`);
  }
}

/**
 * HTTPS transport for a redirect that widens an update request to a new
 * origin. DNS answers are checked in the socket's lookup callback, so a name
 * cannot pass a separate check and then rebind to a private address before the
 * connection opens.
 */
export function createPinnedUpdateFetch(
  dependencies: {
    readonly resolveAll?: (hostname: string) => Promise<ReadonlyArray<string>>;
    readonly request?: typeof httpsRequest;
  } = {},
): typeof globalThis.fetch {
  const resolveAll = dependencies.resolveAll ?? defaultResolveAll;
  const requestHttps = dependencies.request ?? httpsRequest;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input : undefined;
    const url = new URL(source?.url ?? input.toString());
    if (url.protocol !== "https:") {
      return Promise.reject(new UpdateDestinationRefused("scheme"));
    }
    if (url.username !== "" || url.password !== "") {
      return Promise.reject(new UpdateDestinationRefused("credentials"));
    }
    const method = init?.method ?? source?.method ?? "GET";
    if (method.toUpperCase() !== "GET") {
      return Promise.reject(new TypeError("The update transport only supports GET."));
    }
    const hostname = bareHostname(url.hostname);
    if (isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
      return Promise.reject(new UpdateDestinationRefused("private-address"));
    }
    const headers = new Headers(source?.headers);
    if (init?.headers !== undefined) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    }
    const signal = init?.signal ?? source?.signal;

    return new Promise<Response>((resolve, reject) => {
      const pinnedLookup = (
        requestedHostname: string,
        _options: unknown,
        callback: (
          error: Error | null,
          addresses?: ReadonlyArray<{ readonly address: string; readonly family: number }>,
        ) => void,
      ) => {
        resolveAll(bareHostname(requestedHostname)).then(
          (addresses) => {
            if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
              callback(new UpdateDestinationRefused("private-address"));
              return;
            }
            callback(
              null,
              addresses.map((address) => ({ address, family: isIP(address) })),
            );
          },
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      };
      const request = requestHttps(
        {
          host: hostname,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: Object.fromEntries(headers),
          lookup: pinnedLookup as never,
          ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
          ...(signal === undefined || signal === null ? {} : { signal }),
        },
        (incoming) => {
          try {
            const status = incoming.statusCode ?? 0;
            if (status < 200 || status > 599) {
              throw new TypeError("The update server returned an invalid HTTP status.");
            }
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (typeof value === "string") responseHeaders.set(name, value);
              else if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
            }
            const nullBody = status === 204 || status === 205 || status === 304;
            if (nullBody) incoming.resume();
            const decoded = nullBody
              ? { body: null, decoded: false }
              : decodeResponseBody(incoming, responseHeaders.get("content-encoding"));
            if (decoded.decoded) {
              responseHeaders.delete("content-encoding");
              responseHeaders.delete("content-length");
            }
            resolve(
              new Response(
                decoded.body === null
                  ? null
                  : (Readable.toWeb(decoded.body) as ReadableStream<Uint8Array>),
                {
                  status,
                  ...(incoming.statusMessage === undefined
                    ? {}
                    : { statusText: incoming.statusMessage }),
                  headers: responseHeaders,
                },
              ),
            );
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        },
      );
      request.on("error", reject);
      request.end();
    });
  }) as typeof globalThis.fetch;
}

function decodeResponseBody(
  incoming: Readable,
  contentEncoding: string | null,
): { readonly body: Readable; readonly decoded: boolean } {
  const codings = (contentEncoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
  if (codings.length === 0) return { body: incoming, decoded: false };
  if (codings.length > MAX_CONTENT_ENCODINGS) {
    throw new TypeError("The update response has too many content encodings.");
  }
  const decoders = codings.reverse().map((coding) => {
    if (coding === "gzip" || coding === "x-gzip") return createGunzip();
    if (coding === "deflate") return createInflate();
    if (coding === "br") return createBrotliDecompress();
    throw new TypeError("The update response uses an unsupported content encoding.");
  });
  // Canceling the Web stream destroys every Node stream in the composition
  // with AbortError. The composition still propagates real errors downstream;
  // these listeners keep cancellation from also escaping as an uncaught
  // EventEmitter error in Electron's main process.
  incoming.on("error", () => undefined);
  for (const decoder of decoders) decoder.on("error", () => undefined);
  let body = incoming;
  for (const decoder of decoders) body = body.compose(decoder);
  return { body, decoded: true };
}

async function defaultResolveAll(hostname: string): Promise<ReadonlyArray<string>> {
  if (isIP(hostname) !== 0) return [hostname];
  return (await lookup(hostname, { all: true })).map((result) => result.address);
}

function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
