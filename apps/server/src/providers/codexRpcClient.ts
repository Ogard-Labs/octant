import type { Readable, Writable } from "node:stream";

import {
  decodeCodexServerMessage,
  type CodexRpcId,
  type CodexServerNotification,
  type CodexServerRequest,
} from "./codexProtocol";

export const CODEX_RPC_LIMITS = {
  lineBytes: 1_048_576,
  pendingRequests: 64,
  queuedNotifications: 256,
  stderrBytes: 65_536,
  requestTimeoutMs: 30_000,
} as const;

export type CodexRpcClientFailureKind =
  | "capacity"
  | "closed"
  | "protocol"
  | "remote"
  | "saturated"
  | "timeout";

export class CodexRpcClientFailure extends Error {
  readonly kind: CodexRpcClientFailureKind;

  constructor(kind: CodexRpcClientFailureKind, message: string) {
    super(message);
    this.name = "CodexRpcClientFailure";
    this.kind = kind;
  }
}

export interface CodexRpcClientLimits {
  readonly lineBytes: number;
  readonly pendingRequests: number;
  readonly queuedNotifications: number;
  readonly stderrBytes: number;
  readonly requestTimeoutMs: number;
}

export interface CodexRpcClientOptions {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  readonly limits?: Partial<CodexRpcClientLimits>;
  readonly onStderr?: (capture: CodexRpcStderrCapture) => void;
  readonly signal?: AbortSignal;
}

export interface CodexRpcStderrCapture {
  readonly capturedBytes: number;
  readonly truncated: boolean;
}

export interface CodexRpcClient {
  request<T>(method: string, params: unknown, decode: (value: unknown) => T): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  respond(id: CodexRpcId, result: unknown): Promise<void>;
  reject(id: CodexRpcId, code: number, message: string): Promise<void>;
  onNotification(listener: (message: CodexServerNotification) => void): () => void;
  onRequest(listener: (message: CodexServerRequest) => void): () => void;
  readonly exited: Promise<void>;
  close(): Promise<void>;
}

interface PendingRequest {
  readonly decode: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (failure: CodexRpcClientFailure) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type QueuedMessage = CodexServerNotification | CodexServerRequest;

const closedFailure = () => new CodexRpcClientFailure("closed", "Codex transport closed.");

function positiveInteger(value: number, name: keyof CodexRpcClientLimits): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Codex RPC limit ${name} must be a positive integer.`);
  }
  return value;
}

function resolveLimits(overrides: Partial<CodexRpcClientLimits> = {}): CodexRpcClientLimits {
  return {
    lineBytes: positiveInteger(overrides.lineBytes ?? CODEX_RPC_LIMITS.lineBytes, "lineBytes"),
    pendingRequests: positiveInteger(
      overrides.pendingRequests ?? CODEX_RPC_LIMITS.pendingRequests,
      "pendingRequests",
    ),
    queuedNotifications: positiveInteger(
      overrides.queuedNotifications ?? CODEX_RPC_LIMITS.queuedNotifications,
      "queuedNotifications",
    ),
    stderrBytes: positiveInteger(
      overrides.stderrBytes ?? CODEX_RPC_LIMITS.stderrBytes,
      "stderrBytes",
    ),
    requestTimeoutMs: positiveInteger(
      overrides.requestTimeoutMs ?? CODEX_RPC_LIMITS.requestTimeoutMs,
      "requestTimeoutMs",
    ),
  };
}

export function makeCodexRpcClient(options: CodexRpcClientOptions): CodexRpcClient {
  const limits = resolveLimits(options.limits);
  const pending = new Map<CodexRpcId, PendingRequest>();
  const notificationListeners = new Set<(message: CodexServerNotification) => void>();
  const requestListeners = new Set<(message: CodexServerRequest) => void>();
  const dispatchQueue: QueuedMessage[] = [];
  let input = Buffer.alloc(0);
  let nextRequestId = 1;
  let writeQueue = Promise.resolve();
  let dispatchScheduled = false;
  let terminal = false;
  let closePromise: Promise<void> | undefined;
  let stderrCapturedBytes = 0;
  let stderrTruncated = false;
  let stderrDelivered = false;

  let resolveExited!: () => void;
  let rejectExited!: (failure: CodexRpcClientFailure) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExited = resolve;
    rejectExited = reject;
  });

  const removeListeners = () => {
    options.stdout.off("data", onStdoutData);
    options.stdout.off("end", onStdoutEnd);
    options.stdout.off("error", onStdoutError);
    if (options.stdin.errored !== null && options.stdin.listeners("error").includes(onStdinError)) {
      options.stdin.once("close", removePendingStdinErrorListener);
    } else {
      options.stdin.off("error", onStdinError);
    }
    options.stderr?.off("data", onStderrData);
    options.stderr?.off("end", onStderrEnd);
    options.stderr?.off("error", onStderrError);
    options.signal?.removeEventListener("abort", onAbort);
  };

  function removePendingStdinErrorListener(): void {
    options.stdin.off("error", onStdinError);
  }

  const rejectPending = (failure: CodexRpcClientFailure) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(failure);
    }
    pending.clear();
  };

  const finish = (failure?: CodexRpcClientFailure) => {
    if (terminal) return;
    terminal = true;
    deliverStderr();
    removeListeners();
    input = Buffer.alloc(0);
    dispatchQueue.length = 0;
    dispatchScheduled = false;
    notificationListeners.clear();
    requestListeners.clear();
    rejectPending(failure ?? closedFailure());
    if (failure === undefined) resolveExited();
    else rejectExited(failure);
  };

  const failProtocol = (message: string) => {
    finish(new CodexRpcClientFailure("protocol", message));
  };

  function deliverStderr(): void {
    if (stderrDelivered) return;
    stderrDelivered = true;
    try {
      options.onStderr?.({ capturedBytes: stderrCapturedBytes, truncated: stderrTruncated });
    } catch {
      // A diagnostic consumer cannot affect transport lifecycle.
    }
  }

  function onStderrData(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = limits.stderrBytes - stderrCapturedBytes;
    if (remaining > 0) stderrCapturedBytes += Math.min(bytes.length, remaining);
    if (bytes.length > remaining) stderrTruncated = true;
  }

  function onStderrEnd(): void {
    deliverStderr();
  }

  function onStderrError(): void {
    deliverStderr();
  }

  function onStdoutEnd(): void {
    if (input.length > 0) {
      failProtocol("Codex sent an incomplete JSON-RPC line.");
      return;
    }
    finish();
  }

  function onStdoutError(): void {
    finish(new CodexRpcClientFailure("closed", "Codex transport failed."));
  }

  function onStdinError(): void {
    finish(new CodexRpcClientFailure("closed", "Codex transport failed."));
  }

  function onAbort(): void {
    void close();
  }

  const dispatch = () => {
    dispatchScheduled = false;
    while (!terminal) {
      const message = dispatchQueue.shift();
      if (message === undefined) return;
      if (message.kind === "notification") {
        for (const listener of notificationListeners) {
          try {
            listener(message);
          } catch {
            // A consumer listener cannot corrupt transport correlation or framing.
          }
        }
      } else {
        for (const listener of requestListeners) {
          try {
            listener(message);
          } catch {
            // A consumer listener cannot corrupt transport correlation or framing.
          }
        }
      }
    }
  };

  const enqueue = (message: QueuedMessage) => {
    if (dispatchQueue.length >= limits.queuedNotifications) {
      finish(new CodexRpcClientFailure("capacity", "Codex notification queue is full."));
      return;
    }
    dispatchQueue.push(message);
    if (!dispatchScheduled) {
      dispatchScheduled = true;
      queueMicrotask(dispatch);
    }
  };

  const settleResponse = (
    id: CodexRpcId,
    response: { readonly result?: unknown; readonly error?: { readonly code: number } },
  ) => {
    const request = pending.get(id);
    if (request === undefined) {
      failProtocol("Codex sent an unknown or duplicate response ID.");
      return;
    }
    pending.delete(id);
    clearTimeout(request.timeout);

    if (response.error !== undefined) {
      request.reject(
        response.error.code === -32001
          ? new CodexRpcClientFailure("saturated", "Codex request was saturated.")
          : new CodexRpcClientFailure("remote", "Codex request failed."),
      );
      return;
    }

    try {
      request.resolve(request.decode(response.result));
    } catch {
      request.reject(
        new CodexRpcClientFailure("protocol", "Codex response did not match its expected shape."),
      );
    }
  };

  const processLine = (line: Buffer) => {
    const normalized = line.at(-1) === 13 ? line.subarray(0, -1) : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized.toString("utf8"));
    } catch {
      failProtocol("Codex sent malformed JSON-RPC.");
      return;
    }

    try {
      const message = decodeCodexServerMessage(parsed);
      switch (message.kind) {
        case "response":
          settleResponse(message.id, message);
          break;
        case "notification":
        case "request":
          enqueue(message);
          break;
        case "unsupported-request":
          void queueWrite({
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
          break;
        case "unknown-notification":
          break;
      }
    } catch {
      failProtocol("Codex sent invalid JSON-RPC.");
    }
  };

  function onStdoutData(chunk: Buffer | string): void {
    if (terminal) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    input = Buffer.concat([input, bytes]);

    while (!terminal) {
      const newline = input.indexOf(10);
      if (newline < 0) {
        const trailingCarriageReturn = input.at(-1) === 13 ? 1 : 0;
        if (input.length - trailingCarriageReturn > limits.lineBytes) {
          failProtocol("Codex message exceeded the line limit.");
        }
        return;
      }
      const framingCarriageReturn = newline > 0 && input.at(newline - 1) === 13 ? 1 : 0;
      if (newline - framingCarriageReturn > limits.lineBytes) {
        failProtocol("Codex message exceeded the line limit.");
        return;
      }
      const line = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      processLine(line);
    }
  }

  const writeNow = (payload: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      if (terminal || options.stdin.writableEnded || options.stdin.destroyed) {
        reject(closedFailure());
        return;
      }
      let serialized: string;
      try {
        serialized = `${JSON.stringify(payload)}\n`;
      } catch {
        reject(new CodexRpcClientFailure("protocol", "Codex request could not be encoded."));
        return;
      }
      options.stdin.write(serialized, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(new CodexRpcClientFailure("closed", "Codex transport write failed."));
      });
    });

  function queueWrite(payload: unknown): Promise<void> {
    if (terminal) return Promise.reject(closedFailure());
    const write = writeQueue.then(() => writeNow(payload));
    writeQueue = write.catch(() => undefined);
    void write.catch((error: unknown) => {
      if (error instanceof CodexRpcClientFailure && error.kind === "closed") finish(error);
    });
    return write;
  }

  const request = <T>(
    method: string,
    params: unknown,
    decode: (value: unknown) => T,
  ): Promise<T> => {
    if (terminal) return Promise.reject(closedFailure());
    if (pending.size >= limits.pendingRequests) {
      return Promise.reject(
        new CodexRpcClientFailure("capacity", "Codex pending request limit was reached."),
      );
    }

    const id = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new CodexRpcClientFailure("timeout", "Codex request timed out."));
      }, limits.requestTimeoutMs);
      pending.set(id, {
        decode,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      void queueWrite({ id, method, params }).catch((error: unknown) => {
        const current = pending.get(id);
        if (current === undefined) return;
        pending.delete(id);
        clearTimeout(current.timeout);
        reject(
          error instanceof CodexRpcClientFailure
            ? error
            : new CodexRpcClientFailure("closed", "Codex transport write failed."),
        );
      });
    });
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      finish();
      await writeQueue;
      if (!options.stdin.writableEnded && !options.stdin.destroyed) {
        await new Promise<void>((resolve) => {
          const settle = () => {
            options.stdin.off("error", settle);
            resolve();
          };
          options.stdin.once("error", settle);
          options.stdin.end(settle);
        });
      }
    })();
    return closePromise;
  };

  options.stdout.on("data", onStdoutData);
  options.stdout.once("end", onStdoutEnd);
  options.stdout.once("error", onStdoutError);
  options.stdin.once("error", onStdinError);
  options.stderr?.on("data", onStderrData);
  options.stderr?.once("end", onStderrEnd);
  options.stderr?.once("error", onStderrError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  return {
    request,
    notify: (method, params) => queueWrite(params === undefined ? { method } : { method, params }),
    respond: (id, result) => queueWrite({ id, result }),
    reject: (id, code, message) => queueWrite({ id, error: { code, message } }),
    onNotification: (listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onRequest: (listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    exited,
    close,
  };
}
