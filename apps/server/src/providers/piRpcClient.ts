import type { Readable, Writable } from "node:stream";

export type PiRpcFailureKind = "capacity" | "closed" | "protocol" | "remote" | "timeout";

export class PiRpcFailure extends Error {
  override readonly name = "PiRpcFailure";

  constructor(
    readonly kind: PiRpcFailureKind,
    message: string,
  ) {
    super(message);
  }
}

export interface PiRpcResponse {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface PiRpcEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiExtensionUiRequest extends PiRpcEvent {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text";
}

export interface PiRpcClient {
  readonly exited: Promise<void>;
  request(type: string, fields?: Readonly<Record<string, unknown>>): Promise<PiRpcResponse>;
  send(fields: Readonly<Record<string, unknown>> & { readonly type: string }): Promise<void>;
  respondToUi(
    id: string,
    response: {
      readonly confirmed?: boolean;
      readonly value?: string;
      readonly cancelled?: boolean;
    },
  ): Promise<void>;
  onEvent(listener: (event: PiRpcEvent) => void): () => void;
  close(): Promise<void>;
}

interface Options {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly signal?: AbortSignal;
  readonly limits?: {
    readonly lineBytes?: number;
    readonly pendingRequests?: number;
    readonly requestTimeoutMs?: number;
  };
}

interface Pending {
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (failure: PiRpcFailure) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const KNOWN_UI_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);
const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function makePiRpcClient(options: Options): PiRpcClient {
  const lineBytes = options.limits?.lineBytes ?? 1_048_576;
  const pendingLimit = options.limits?.pendingRequests ?? 64;
  const requestTimeoutMs = options.limits?.requestTimeoutMs ?? 30_000;
  const pending = new Map<string, Pending>();
  const listeners = new Set<(event: PiRpcEvent) => void>();
  let input = Buffer.alloc(0);
  let sequence = 0;
  let terminal = false;
  let writeQueue = Promise.resolve();
  let resolveExited!: () => void;
  let rejectExited!: (failure: PiRpcFailure) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExited = resolve;
    rejectExited = reject;
  });

  const cleanup = () => {
    options.stdout.off("data", onData);
    options.stdout.off("end", onEnd);
    options.stdout.off("error", onError);
    options.stdin.off("error", onError);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const finish = (failure?: PiRpcFailure) => {
    if (terminal) return;
    terminal = true;
    cleanup();
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(failure ?? new PiRpcFailure("closed", "Pi RPC transport closed."));
    }
    pending.clear();
    listeners.clear();
    input = Buffer.alloc(0);
    if (failure === undefined) resolveExited();
    else rejectExited(failure);
  };

  const protocol = () => finish(new PiRpcFailure("protocol", "Pi sent invalid RPC data."));

  function onError(): void {
    finish(new PiRpcFailure("closed", "Pi RPC transport failed."));
  }

  function onAbort(): void {
    void close();
  }

  function onEnd(): void {
    if (input.length > 0) protocol();
    else finish();
  }

  function dispatch(value: unknown): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return protocol();
    const record = value as Record<string, unknown>;
    if (typeof record.type !== "string" || record.type.length === 0) return protocol();
    if (record.type === "response") {
      if (
        typeof record.id !== "string" ||
        typeof record.command !== "string" ||
        typeof record.success !== "boolean"
      ) {
        return protocol();
      }
      const request = pending.get(record.id);
      if (request === undefined) return protocol();
      pending.delete(record.id);
      clearTimeout(request.timeout);
      if (!record.success) {
        request.reject(new PiRpcFailure("remote", "Pi RPC request failed."));
        return;
      }
      request.resolve(record as unknown as PiRpcResponse);
      return;
    }
    if (record.type === "extension_ui_request") {
      if (typeof record.method !== "string" || !KNOWN_UI_METHODS.has(record.method))
        return protocol();
      if (
        DIALOG_UI_METHODS.has(record.method) &&
        (typeof record.id !== "string" || record.id.length === 0)
      ) {
        return protocol();
      }
    }
    const event = record as PiRpcEvent;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Consumer failures cannot break transport framing or correlation.
      }
    }
  }

  function onData(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    input = Buffer.concat([input, bytes]);
    while (!terminal) {
      const newline = input.indexOf(0x0a);
      if (newline === -1) {
        if (input.length > lineBytes) protocol();
        return;
      }
      let line = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      if (line.length > lineBytes) return protocol();
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) return protocol();
      try {
        dispatch(JSON.parse(line.toString("utf8")));
      } catch {
        return protocol();
      }
    }
  }

  const write = (message: unknown): Promise<void> => {
    if (terminal) return Promise.reject(new PiRpcFailure("closed", "Pi RPC transport closed."));
    const serialized = `${JSON.stringify(message)}\n`;
    writeQueue = writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          options.stdin.write(serialized, (error) => {
            if (error) {
              const failure = new PiRpcFailure("closed", "Pi RPC transport failed.");
              finish(failure);
              reject(failure);
            } else resolve();
          });
        }),
    );
    return writeQueue;
  };

  const request = (type: string, fields: Readonly<Record<string, unknown>> = {}) => {
    if (pending.size >= pendingLimit) {
      return Promise.reject(new PiRpcFailure("capacity", "Pi RPC request capacity reached."));
    }
    const id = `octant-${++sequence}`;
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new PiRpcFailure("timeout", "Pi RPC request timed out."));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timeout });
      void write({ id, type, ...fields }).catch((error: unknown) => {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      });
    });
  };

  const close = async () => {
    if (terminal) return;
    options.stdin.end();
    finish();
  };

  options.stdout.on("data", onData);
  options.stdout.on("end", onEnd);
  options.stdout.on("error", onError);
  options.stdin.on("error", onError);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    exited,
    request,
    send: (fields) => write(fields),
    respondToUi: (id, response) => write({ type: "extension_ui_response", id, ...response }),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
}
