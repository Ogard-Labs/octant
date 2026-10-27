import type { OutsideDriverChannel } from "./outsideHarnessEndpointProxy";

/**
 * An in-memory stand-in for an outside driver's stdin and stdout, and a
 * scriptable driver on the far end of it. Lines cross asynchronously, as they
 * would between processes, and nothing crosses once the host stops the
 * channel.
 */

export interface InMemoryDriverEnd {
  readonly write: (line: string) => void;
  readonly onLine: (listener: (line: string) => void) => void;
  readonly stopped: () => boolean;
  /** Ends the driver on its own, as a process that exits would. */
  readonly exit: () => void;
}

export function makeInMemoryOutsideDriverChannel(): {
  readonly host: OutsideDriverChannel;
  readonly driver: InMemoryDriverEnd;
} {
  let stopped = false;
  const toDriver: Array<(line: string) => void> = [];
  const toHost: Array<(line: string) => void> = [];
  const closed: Array<() => void> = [];
  const deliver = (listeners: ReadonlyArray<(line: string) => void>, line: string) => {
    if (stopped) return;
    queueMicrotask(() => {
      if (stopped) return;
      for (const listener of listeners) listener(line);
    });
  };
  return {
    host: {
      write: (line) => deliver(toDriver, line),
      onLine: (listener) => toHost.push(listener),
      onClosed: (listener) => closed.push(listener),
      stop: () => {
        stopped = true;
      },
    },
    driver: {
      write: (line) => deliver(toHost, line),
      onLine: (listener) => toDriver.push(listener),
      stopped: () => stopped,
      exit: () => {
        if (stopped) return;
        stopped = true;
        for (const listener of closed) listener();
      },
    },
  };
}

/** A handler that returns this never answers the call. */
export const NO_ANSWER = Symbol("no answer");

/** What a scripted handler answers with; anything it throws becomes this error. */
export class FixtureDriverError extends Error {
  constructor(
    message: string,
    readonly data: unknown,
    readonly code = -32000,
  ) {
    super(message);
  }
}

export interface FixtureHttpResult {
  readonly status?: number;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
  readonly end?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
}

export interface FixtureDriverContext {
  readonly id: number;
  /** Streams one `session/event` for the call being answered. */
  readonly emit: (event: unknown) => void;
  /** Asks the host for a brokered request and gathers its whole answer. */
  readonly http: (params: unknown) => Promise<FixtureHttpResult>;
  /** Writes any line at all, as a misbehaving driver would. */
  readonly writeRaw: (line: string) => void;
}

export type FixtureDriverHandler = (
  params: Readonly<Record<string, unknown>>,
  context: FixtureDriverContext,
) => unknown;

export interface FixtureDriver {
  /** Every call and notification the host sent, in order. */
  readonly received: ReadonlyArray<{ readonly method: string; readonly params: unknown }>;
  readonly writeRaw: (line: string) => void;
}

/** A well-behaved driver's answers; a test overrides the ones it needs to misbehave. */
export const wellBehavedHandlers: Readonly<Record<string, FixtureDriverHandler>> = {
  initialize: () => ({ protocolVersion: "harness-endpoint/1" }),
  probe: () => ({ models: [{ id: "local-model", contextWindowTokens: 8192 }] }),
  "session/open": () => ({}),
  "session/send": (_params, context) => {
    context.emit({ kind: "text-delta", text: "Hello" });
    return { text: "Hello", toolCalls: [] };
  },
};

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function serveFixtureDriver(
  end: InMemoryDriverEnd,
  overrides: Readonly<Record<string, FixtureDriverHandler>> = {},
): FixtureDriver {
  const handlers = { ...wellBehavedHandlers, ...overrides };
  const received: Array<{ readonly method: string; readonly params: unknown }> = [];
  const httpWaiters = new Map<
    number,
    {
      response?: Record<string, unknown>;
      chunks: string[];
      settle: (result: FixtureHttpResult) => void;
    }
  >();
  let nextHttpId = 1;
  const send = (message: unknown) => end.write(JSON.stringify(message));

  end.onLine((line) => {
    const message = record(JSON.parse(line));
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = typeof message.id === "number" ? message.id : undefined;
    if (method === undefined && id !== undefined) {
      const waiter = httpWaiters.get(id);
      if (waiter === undefined) return;
      if (message.error !== undefined) {
        httpWaiters.delete(id);
        waiter.settle({ body: "", error: record(message.error) });
        return;
      }
      waiter.response = record(message.result);
      return;
    }
    if (method === undefined) return;
    received.push({ method, params: message.params });
    const params = record(message.params);
    if (method === "http/chunk" || method === "http/end") {
      const httpId = typeof params.httpId === "number" ? params.httpId : 0;
      const waiter = httpWaiters.get(httpId);
      if (waiter === undefined) return;
      if (method === "http/chunk") {
        waiter.chunks.push(typeof params.data === "string" ? params.data : "");
        return;
      }
      httpWaiters.delete(httpId);
      const status = waiter.response?.status;
      const headers = waiter.response?.headers;
      waiter.settle({
        ...(typeof status === "number" ? { status } : {}),
        ...(Array.isArray(headers)
          ? {
              headers: headers.map((pair: unknown): readonly [string, string] =>
                Array.isArray(pair) ? [String(pair[0]), String(pair[1])] : ["", ""],
              ),
            }
          : {}),
        body: waiter.chunks.join(""),
        end: params,
      });
      return;
    }
    if (id === undefined) return;
    const handler = handlers[method];
    const context: FixtureDriverContext = {
      id,
      emit: (event) =>
        send({ jsonrpc: "2.0", method: "session/event", params: { requestId: id, event } }),
      http: (httpParams) =>
        new Promise((settle) => {
          const httpId = nextHttpId;
          nextHttpId += 1;
          httpWaiters.set(httpId, { chunks: [], settle });
          send({ jsonrpc: "2.0", id: httpId, method: "http/request", params: httpParams });
        }),
      writeRaw: end.write,
    };
    void Promise.resolve()
      .then(() => {
        if (handler === undefined) {
          throw new FixtureDriverError("Unknown method", { category: "unsupported" });
        }
        return handler(params, context);
      })
      .then(
        (result) => {
          if (result !== NO_ANSWER) send({ jsonrpc: "2.0", id, result });
        },
        (error: unknown) => {
          if (error instanceof FixtureDriverError) {
            send({
              jsonrpc: "2.0",
              id,
              error: {
                code: error.code,
                message: error.message,
                ...(error.data === undefined ? {} : { data: error.data }),
              },
            });
            return;
          }
          send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error) } });
        },
      );
  });

  return { received, writeRaw: end.write };
}
