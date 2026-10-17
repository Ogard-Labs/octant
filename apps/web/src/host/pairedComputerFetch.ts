import type { PairedComputersBridge } from "../shell/hostBridge";

/**
 * A `fetch` for a computer paired through Other computers. This window's page
 * policy lets it connect to loopback only, so the request goes to the desktop's
 * main process, which sends it over a connection held to that computer's
 * recorded certificate pin and refuses any origin it did not pair with. The
 * window still builds and signs the request with its own device key; nothing
 * here sees a key.
 *
 * Replies arrive whole, not as a stream, so this carries the pairing, session,
 * and short product requests the main window makes of another computer.
 */
export function createPairedComputerFetch(
  bridge: Pick<PairedComputersBridge, "requestPairedComputer">,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    // Read from `init` before any `Request` exists: a `Request` drops the cookie
    // and origin headers a signed request carries, and a standalone `Headers`
    // keeps them.
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = bodyOf(init?.body);
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const answered = bridge.requestPairedComputer({
      origin: url.origin,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const answer = await (signal === undefined ? answered : raceAbort(answered, signal));
    if (answer.status !== "answered") throw new TypeError(answer.message);
    const bodyless =
      answer.httpStatus === 204 || answer.httpStatus === 205 || answer.httpStatus === 304;
    return new Response(bodyless ? null : new Uint8Array(answer.body), {
      status: answer.httpStatus,
      headers: answer.headers.map(([name, value]) => [name, value]),
    });
  };
}

function bodyOf(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  throw new TypeError("A request to another computer carries text or bytes.");
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
