/**
 * Serves an outside provider driver over Octant's harness endpoint protocol:
 * line-delimited JSON-RPC 2.0 on the process's stdin and stdout.
 *
 * The host runs a driver's one `.mjs` entry on Bun, or on Electron's Node in
 * the packaged app, in a process that can read only its own package and has
 * no network. So this file is plain JavaScript that imports nothing but a
 * runtime built-in, and a driver package carries a copy of it beside its own
 * modules rather than importing it from anywhere outside the package.
 *
 * A driver supplies `probe` and `send` (and, when it needs them,
 * `initialize`, `open`, and `release`). This module answers the handshake,
 * numbers its brokered requests, streams events for the call being answered,
 * turns a cancel into an aborted signal, and writes every failure as the
 * structure the host reads. The driver holds no credential and makes no
 * network call: `host.http` asks the host to make one, and the host adds the
 * key and refuses any address but the one the person configured.
 */
import { createInterface } from "node:readline";

/** The one protocol version this helper speaks. */
export const HARNESS_ENDPOINT_PROTOCOL_VERSION = "harness-endpoint/1";

const FAILURE_CATEGORIES = new Set([
  "unavailable",
  "unauthenticated",
  "incompatible",
  "unsupported",
  "unauthorized",
  "interrupted",
  "stale-resume",
  "invalid-configuration",
  "protocol",
  "rate-limited",
  "provider-failed",
]);

/**
 * A failure the host can read. The host writes its own message for each
 * category and keeps nothing else a driver says, so a failure carries only a
 * category, how long to wait before trying again, and whether the request
 * outgrew the model's context window.
 */
export class OutsideDriverFailure extends Error {
  constructor(category, details = {}) {
    super(category);
    this.name = "OutsideDriverFailure";
    this.category = FAILURE_CATEGORIES.has(category) ? category : "provider-failed";
    // Values the host would refuse are dropped here, since a failure the host
    // cannot read becomes a fixed protocol failure and loses its category.
    this.retryAfterMs = boundedInteger(details.retryAfterMs, 3_600_000);
    this.contextOverflow =
      details.contextOverflow === undefined
        ? undefined
        : {
            contextWindowTokens: boundedInteger(
              details.contextOverflow.contextWindowTokens,
              100_000_000,
            ),
          };
  }
}

function boundedInteger(value, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : undefined;
}

/**
 * Serves `driver` until the host closes the channel. Without `io` it serves
 * the process's stdin and stdout, which is how the host runs a driver; a test
 * passes its own line channel to run the driver in process.
 */
export function serveOutsideDriver(driver, io = standardIo()) {
  const cancels = new Map();
  const brokered = new Map();
  let nextHttpId = 1;
  let configuration;
  const write = (message) => io.write(JSON.stringify(message));

  const host = {
    get configuration() {
      return configuration;
    },
    http: (request) => {
      const httpId = nextHttpId;
      nextHttpId += 1;
      return new Promise((resolve, reject) => {
        const body = bodyStream();
        brokered.set(httpId, {
          head: (result) => resolve(brokeredResponse(result, body)),
          refuse: (error) => {
            brokered.delete(httpId);
            reject(new OutsideDriverFailure(error?.data?.category ?? "unavailable"));
          },
          chunk: (data) => body.push(data),
          end: (params) => {
            brokered.delete(httpId);
            body.end(params);
          },
        });
        write({ jsonrpc: "2.0", id: httpId, method: "http/request", params: request });
      });
    },
  };

  const call = async (id, method, params) => {
    switch (method) {
      case "initialize": {
        if (!params.protocolVersions?.includes(HARNESS_ENDPOINT_PROTOCOL_VERSION)) {
          throw new OutsideDriverFailure("incompatible");
        }
        configuration = params.configuration;
        await driver.initialize?.(configuration, host);
        return { protocolVersion: HARNESS_ENDPOINT_PROTOCOL_VERSION };
      }
      case "probe":
        return driver.probe(host);
      case "session/open":
        return (await driver.open?.(params, host)) ?? {};
      case "session/send": {
        const controller = new AbortController();
        cancels.set(id, controller);
        try {
          return await driver.send(params, {
            signal: controller.signal,
            // The host has already answered a cancelled send, so nothing
            // more is streamed for it.
            emit: (event) => {
              if (controller.signal.aborted) return;
              write({ jsonrpc: "2.0", method: "session/event", params: { requestId: id, event } });
            },
            host,
          });
        } catch (error) {
          if (controller.signal.aborted) throw new OutsideDriverFailure("interrupted");
          throw error;
        } finally {
          cancels.delete(id);
        }
      }
      default:
        throw new OutsideDriverFailure("unsupported");
    }
  };

  io.onLine((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const { id, method } = message;
    const params = message.params ?? {};
    if (typeof method !== "string") {
      const waiter = brokered.get(id);
      if (waiter === undefined) return;
      if (message.error !== undefined) waiter.refuse(message.error);
      else waiter.head(message.result);
      return;
    }
    switch (method) {
      case "http/chunk":
        brokered.get(params.httpId)?.chunk(params.data);
        return;
      case "http/end":
        brokered.get(params.httpId)?.end(params);
        return;
      case "session/cancel":
        cancels.get(params.requestId)?.abort();
        return;
      case "session/release":
        driver.release?.(params.sessionRef);
        return;
    }
    if (typeof id !== "number") return;
    Promise.resolve()
      .then(() => call(id, method, params))
      .then(
        (result) => write({ jsonrpc: "2.0", id, result }),
        (error) => write({ jsonrpc: "2.0", id, error: wireError(error) }),
      );
  });
}

function wireError(error) {
  // Read by name rather than by class, so a failure built by another copy of
  // this file (a driver that bundles one, say) keeps its category.
  const failure =
    error instanceof Error && error.name === "OutsideDriverFailure"
      ? new OutsideDriverFailure(error.category, error)
      : new OutsideDriverFailure("provider-failed");
  return {
    code: -32000,
    message: failure.category,
    data: {
      category: failure.category,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      ...(failure.contextOverflow === undefined
        ? {}
        : {
            contextOverflow:
              failure.contextOverflow.contextWindowTokens === undefined
                ? {}
                : { contextWindowTokens: failure.contextOverflow.contextWindowTokens },
          }),
    },
  };
}

/** A brokered response's body as the host streams it: chunks of text, then an end. */
function bodyStream() {
  const chunks = [];
  let ended;
  let wake;
  let consumed = false;
  const notify = () => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  return {
    push: (data) => {
      chunks.push(typeof data === "string" ? data : "");
      notify();
    },
    end: (params) => {
      ended = params;
      notify();
    },
    async *read() {
      if (consumed) throw new Error("A brokered response body can be read once.");
      consumed = true;
      for (;;) {
        if (chunks.length > 0) {
          yield chunks.shift();
          continue;
        }
        if (ended !== undefined) {
          if (ended.outcome === "failed") throw new OutsideDriverFailure(ended.category);
          return;
        }
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function brokeredResponse(result, body) {
  const status = typeof result?.status === "number" ? result.status : 0;
  const headers = Array.isArray(result?.headers) ? result.headers : [];
  const text = async () => {
    let collected = "";
    for await (const chunk of body.read()) collected += chunk;
    return collected;
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    header: (name) => headers.find(([key]) => key === name.toLowerCase())?.[1],
    chunks: () => body.read(),
    text,
    json: async () => JSON.parse(await text()),
  };
}

function standardIo() {
  // The host stops a driver at the first stdout line that is not a protocol
  // message, so console output goes to stderr, which the host bounds and
  // never shows anyone.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // The host closes stdin when it stops the driver; nothing is left to serve.
  lines.on("close", () => process.exit(0));
  return {
    onLine: (listener) => {
      lines.on("line", listener);
    },
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}
