import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

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
            resolve(
              new Response(
                nullBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
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

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function defaultResolveAll(hostname: string): Promise<ReadonlyArray<string>> {
  if (isIP(hostname) !== 0) return [hostname];
  return (await lookup(hostname, { all: true })).map((result) => result.address);
}

function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Every IANA special-purpose IPv4 block that is not globally reachable. */
function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Judge IPv6 by value, including every form that carries an IPv4 address. */
function isPrivateIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (words === undefined) return true;
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  const carried = (high: number, low: number) =>
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0) {
    return w4 === 0 && w5 === 0xffff ? isPrivateIpv4(carried(w6, w7)) : true;
  }
  if (w0 === 0x64 && w1 === 0xff9b) {
    return w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 ? isPrivateIpv4(carried(w6, w7)) : true;
  }
  if (w0 === 0x2002) return isPrivateIpv4(carried(w1, w2));
  if (w0 === 0x2001 && w1 === 0) {
    return isPrivateIpv4(carried(w2, w3)) || isPrivateIpv4(carried(~w6 & 0xffff, ~w7 & 0xffff));
  }
  // The global unicast allocation is currently 2000::/3. Treat every other
  // unallocated or reserved prefix as private unless handled above as a form
  // that explicitly carries a globally reachable IPv4 address.
  if ((w0 & 0xe000) !== 0x2000) return true;
  return (
    (w0 === 0x100 && w1 === 0 && w2 === 0 && (w3 === 0 || w3 === 1)) ||
    (w0 === 0x2001 && w1 < 0x200) ||
    (w0 === 0x2001 && w1 === 0xdb8) ||
    (w0 === 0x3fff && w1 < 0x1000) ||
    w0 === 0x5f00 ||
    (w0 & 0xfe00) === 0xfc00 ||
    (w0 & 0xffc0) === 0xfe80 ||
    (w0 & 0xffc0) === 0xfec0 ||
    (w0 & 0xff00) === 0xff00
  );
}

function ipv6Words(address: string): ReadonlyArray<number> | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined) =>
    part === undefined || part.length === 0
      ? []
      : part.split(":").map((word) => parseInt(word, 16));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const gap = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (gap < 0) return undefined;
  const words = [...head, ...Array.from({ length: gap }, () => 0), ...rest];
  if (words.length !== 8 || words.some((word) => !(word >= 0 && word <= 0xffff))) {
    return undefined;
  }
  return words;
}
