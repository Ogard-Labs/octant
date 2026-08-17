import { Schema } from "effect";
import type { Readable, Writable } from "node:stream";

const decode = <A, I>(schema: Schema.Schema<A, I>) => Schema.decodeUnknownSync(schema);
const RpcId = Schema.Union(Schema.String, Schema.Int);
type RpcId = typeof RpcId.Type;

const InitializeResult = Schema.Struct({
  protocolVersion: Schema.Int,
  agentCapabilities: Schema.Struct({
    loadSession: Schema.optional(Schema.Boolean),
    promptCapabilities: Schema.optional(
      Schema.Struct({
        image: Schema.optional(Schema.Boolean),
        audio: Schema.optional(Schema.Boolean),
        embeddedContext: Schema.optional(Schema.Boolean),
      }),
    ),
    sessionCapabilities: Schema.optional(
      Schema.Struct({
        list: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
        resume: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
      }),
    ),
  }),
  authMethods: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyTrimmedString,
        type: Schema.optional(Schema.NonEmptyTrimmedString),
        args: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  agentInfo: Schema.optional(
    Schema.Struct({
      name: Schema.NonEmptyTrimmedString,
      version: Schema.NonEmptyTrimmedString,
    }),
  ),
  _meta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type AcpInitializeResult = typeof InitializeResult.Type;

const SessionConfigSelectOption = Schema.Struct({
  value: Schema.NonEmptyTrimmedString,
  name: Schema.NonEmptyTrimmedString,
  description: Schema.optional(Schema.String),
});
const SessionConfigOption = Schema.Struct({
  type: Schema.Literal("select"),
  id: Schema.NonEmptyTrimmedString,
  name: Schema.NonEmptyTrimmedString,
  category: Schema.optional(Schema.String),
  currentValue: Schema.String,
  options: Schema.Array(SessionConfigSelectOption),
});
export type AcpSessionConfigOption = typeof SessionConfigOption.Type;

// An agent may report its models as the session's own model state instead of a
// `model` config option; both are ACP, and an agent that only sends this one
// would otherwise be read as having no model to select at all.
const SessionModelState = Schema.Struct({
  currentModelId: Schema.optional(Schema.NonEmptyTrimmedString),
  availableModels: Schema.Array(
    Schema.Struct({
      modelId: Schema.NonEmptyTrimmedString,
      name: Schema.NonEmptyTrimmedString,
      description: Schema.optional(Schema.String),
    }),
  ),
});
export type AcpSessionModelState = typeof SessionModelState.Type;

const NewSessionResult = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  configOptions: Schema.optional(Schema.Array(SessionConfigOption)),
  models: Schema.optional(SessionModelState),
});
export type AcpNewSessionResult = typeof NewSessionResult.Type;

const PromptResult = Schema.Struct({ stopReason: Schema.NonEmptyTrimmedString });
export type AcpPromptResult = typeof PromptResult.Type;

const ConfigOptionsResult = Schema.Struct({
  configOptions: Schema.Array(SessionConfigOption),
});
export type AcpConfigOptionsResult = typeof ConfigOptionsResult.Type;

const EmptyResult = Schema.Record({ key: Schema.String, value: Schema.Unknown });

const SessionUpdateParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  update: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const PermissionRequestParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  toolCall: Schema.Struct({
    toolCallId: Schema.NonEmptyTrimmedString,
    title: Schema.NonEmptyTrimmedString,
    kind: Schema.optional(Schema.NonEmptyTrimmedString),
  }),
  options: Schema.Array(
    Schema.Struct({
      optionId: Schema.NonEmptyTrimmedString,
      name: Schema.NonEmptyTrimmedString,
      kind: Schema.NonEmptyTrimmedString,
    }),
  ),
});

const DelegatedBrowserStart = Schema.Struct({
  _meta: Schema.Struct({
    "browser-auth-delegated": Schema.Struct({
      attemptId: Schema.NonEmptyTrimmedString,
      expiresAt: Schema.NonEmptyTrimmedString,
      signInUrl: Schema.NonEmptyTrimmedString,
    }),
  }),
});
const DelegatedBrowserComplete = Schema.Struct({
  _meta: Schema.Struct({
    "browser-auth-delegated": Schema.Struct({
      attemptId: Schema.NonEmptyTrimmedString,
      persistResult: Schema.optional(Schema.NonEmptyTrimmedString),
      status: Schema.Literal("completed"),
    }),
  }),
});
export type AcpBrowserAuthenticationAttempt =
  (typeof DelegatedBrowserStart.Type)["_meta"]["browser-auth-delegated"];

export interface AcpServerNotification {
  readonly kind: "notification";
  readonly method: "session/update";
  readonly params: typeof SessionUpdateParams.Type;
}

export interface AcpServerRequest {
  readonly kind: "request";
  readonly id: RpcId;
  readonly method: "session/request_permission";
  readonly params: typeof PermissionRequestParams.Type;
}

type FailureKind = "capacity" | "closed" | "protocol" | "remote" | "timeout";

export class AcpFailure extends Error {
  override readonly name = "AcpFailure";

  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}

export interface AcpLimits {
  readonly lineBytes: number;
  readonly pendingRequests: number;
  readonly queuedMessages: number;
  readonly requestTimeoutMs: number;
  readonly stderrBytes: number;
}

export interface AcpClientOptions {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<AcpLimits>;
  readonly onStderr?: (observation: {
    readonly capturedBytes: number;
    readonly truncated: boolean;
  }) => void;
}

export interface AcpClient {
  readonly exited: Promise<void>;
  initialize(
    metadata?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<AcpInitializeResult>;
  authenticate(): Promise<void>;
  authenticateWith(
    methodId: string,
    fields?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<Readonly<Record<string, unknown>>>;
  /** ACP `browser-auth-delegated` extension: the host opens the sign-in URL. */
  startBrowserAuthentication(): Promise<AcpBrowserAuthenticationAttempt>;
  completeBrowserAuthentication(attemptId: string): Promise<void>;
  newSession(cwd: string): Promise<AcpNewSessionResult>;
  loadSession(sessionId: string, cwd: string): Promise<AcpNewSessionResult>;
  resumeSession(sessionId: string, cwd: string): Promise<AcpNewSessionResult>;
  prompt(sessionId: string, prompt: string): Promise<AcpPromptResult>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<AcpConfigOptionsResult>;
  /** Generic JSON-RPC call for profile-specific ACP methods (e.g. Grok's `session/set_mode`). */
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  closeSession(sessionId: string): Promise<void>;
  onNotification(listener: (message: AcpServerNotification) => void): () => void;
  onRequest(listener: (message: AcpServerRequest) => void): () => void;
  respond(id: RpcId, result: unknown): Promise<void>;
  respondPermission(id: RpcId, optionId?: string): Promise<void>;
  reject(id: RpcId, code: number, message: string): Promise<void>;
  notify(method: "session/cancel", params: { readonly sessionId: string }): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_LIMITS: AcpLimits = {
  lineBytes: 1_048_576,
  pendingRequests: 64,
  queuedMessages: 256,
  requestTimeoutMs: 15_000,
  stderrBytes: 65_536,
};

interface PendingRequest {
  readonly decode: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (failure: AcpFailure) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type QueuedMessage = AcpServerNotification | AcpServerRequest;

export function makeAcpClient(options: AcpClientOptions): AcpClient {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const pending = new Map<RpcId, PendingRequest>();
  const notificationListeners = new Set<(message: AcpServerNotification) => void>();
  const requestListeners = new Set<(message: AcpServerRequest) => void>();
  const queue: QueuedMessage[] = [];
  let input = Buffer.alloc(0);
  let nextId = 1;
  let terminal = false;
  let dispatchScheduled = false;
  let stderrDelivered = false;
  let stderrCapturedBytes = 0;
  let stderrTruncated = false;
  let writeChain = Promise.resolve();
  let resolveExited!: () => void;
  let rejectExited!: (failure: AcpFailure) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExited = resolve;
    rejectExited = reject;
  });

  const deliverStderr = () => {
    if (stderrDelivered) return;
    stderrDelivered = true;
    try {
      options.onStderr?.({ capturedBytes: stderrCapturedBytes, truncated: stderrTruncated });
    } catch {
      // Diagnostic consumers never control transport lifecycle.
    }
  };

  const onStderrData = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, limits.stderrBytes - stderrCapturedBytes);
    stderrCapturedBytes += Math.min(bytes.length, remaining);
    if (bytes.length > remaining) stderrTruncated = true;
  };
  const onStderrEnd = () => deliverStderr();
  const onStderrError = () => deliverStderr();

  const removeListeners = () => {
    options.stdout.off("data", onStdoutData);
    options.stdout.off("end", onStdoutEnd);
    options.stdout.off("error", onStdoutError);
    options.stdin.off("error", onStdinError);
    options.stderr?.off("data", onStderrData);
    options.stderr?.off("end", onStderrEnd);
    options.stderr?.off("error", onStderrError);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const finish = (failure?: AcpFailure) => {
    if (terminal) return;
    terminal = true;
    deliverStderr();
    removeListeners();
    input = Buffer.alloc(0);
    queue.length = 0;
    dispatchScheduled = false;
    notificationListeners.clear();
    requestListeners.clear();
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(failure ?? new AcpFailure("closed", "ACP transport closed."));
    }
    pending.clear();
    if (failure === undefined) resolveExited();
    else rejectExited(failure);
  };

  const failProtocol = (message: string) => finish(new AcpFailure("protocol", message));

  function onStdoutEnd() {
    if (input.length > 0) {
      failProtocol("ACP sent an incomplete JSON-RPC line.");
      return;
    }
    finish();
  }
  function onStdoutError() {
    finish(new AcpFailure("closed", "ACP transport failed."));
  }
  function onStdinError() {
    finish(new AcpFailure("closed", "ACP transport failed."));
  }
  function onAbort() {
    void close();
  }

  const dispatch = () => {
    dispatchScheduled = false;
    while (!terminal) {
      const message = queue.shift();
      if (message === undefined) return;
      const listeners = message.kind === "notification" ? notificationListeners : requestListeners;
      for (const listener of listeners as Set<(message: QueuedMessage) => void>) {
        try {
          listener(message);
        } catch {
          // Consumers cannot corrupt framing or correlation.
        }
      }
    }
  };

  const enqueue = (message: QueuedMessage) => {
    if (queue.length >= limits.queuedMessages) {
      finish(new AcpFailure("capacity", "ACP message queue is full."));
      return;
    }
    queue.push(message);
    if (!dispatchScheduled) {
      dispatchScheduled = true;
      queueMicrotask(dispatch);
    }
  };

  const writeNow = (payload: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      if (terminal || options.stdin.destroyed || options.stdin.writableEnded) {
        reject(new AcpFailure("closed", "ACP transport closed."));
        return;
      }
      let line: string;
      try {
        line = `${JSON.stringify(payload)}\n`;
      } catch {
        reject(new AcpFailure("protocol", "ACP message could not be encoded."));
        return;
      }
      options.stdin.write(line, (error) => {
        if (error) reject(new AcpFailure("closed", "ACP transport failed."));
        else resolve();
      });
    });

  const write = (payload: unknown): Promise<void> => {
    const operation = writeChain.then(() => writeNow(payload));
    writeChain = operation.catch(() => undefined);
    return operation;
  };

  const settleResponse = (
    id: RpcId,
    response: { readonly result?: unknown; readonly error?: { readonly code: number } },
  ) => {
    const request = pending.get(id);
    if (request === undefined) {
      failProtocol("ACP sent an unknown or duplicate response ID.");
      return;
    }
    pending.delete(id);
    clearTimeout(request.timeout);
    if (response.error !== undefined) {
      request.reject(
        new AcpFailure(
          "remote",
          response.error.code === -32000
            ? "ACP authentication is required."
            : "ACP request failed.",
        ),
      );
      return;
    }
    try {
      request.resolve(request.decode(response.result));
    } catch {
      request.reject(new AcpFailure("protocol", "ACP response was invalid."));
    }
  };

  const decodeEnvelope = (value: unknown) => {
    const envelope = decode(
      Schema.Struct({
        jsonrpc: Schema.Literal("2.0"),
        id: Schema.optional(RpcId),
        method: Schema.optional(Schema.String),
        params: Schema.optional(Schema.Unknown),
        result: Schema.optional(Schema.Unknown),
        error: Schema.optional(Schema.Struct({ code: Schema.Int, message: Schema.String })),
      }),
    )(value);
    if (envelope.method === undefined) {
      if (
        envelope.id === undefined ||
        (envelope.result === undefined && envelope.error === undefined)
      ) {
        throw new Error("invalid response");
      }
      settleResponse(
        envelope.id,
        envelope.error === undefined ? { result: envelope.result } : { error: envelope.error },
      );
      return;
    }
    if (envelope.id === undefined) {
      if (envelope.method === "session/update") {
        enqueue({
          kind: "notification",
          method: "session/update",
          params: decode(SessionUpdateParams)(envelope.params),
        });
      }
      return;
    }
    if (envelope.method === "session/request_permission") {
      enqueue({
        kind: "request",
        id: envelope.id,
        method: "session/request_permission",
        params: decode(PermissionRequestParams)(envelope.params),
      });
      return;
    }
    void write({
      jsonrpc: "2.0",
      id: envelope.id,
      error: { code: -32601, message: "Method not found" },
    });
  };

  const processLine = (line: Buffer) => {
    const normalized = line.at(-1) === 13 ? line.subarray(0, -1) : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized.toString("utf8"));
    } catch {
      failProtocol("ACP sent malformed JSON-RPC.");
      return;
    }
    try {
      decodeEnvelope(parsed);
    } catch {
      failProtocol("ACP sent invalid JSON-RPC.");
    }
  };

  function onStdoutData(chunk: Buffer | string) {
    if (terminal) return;
    input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (!terminal) {
      const newline = input.indexOf(10);
      if (newline < 0) {
        if (input.length - (input.at(-1) === 13 ? 1 : 0) > limits.lineBytes) {
          failProtocol("ACP message exceeded the line limit.");
        }
        return;
      }
      if (newline - (newline > 0 && input.at(newline - 1) === 13 ? 1 : 0) > limits.lineBytes) {
        failProtocol("ACP message exceeded the line limit.");
        return;
      }
      const line = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      processLine(line);
    }
  }

  const request = <A>(
    method: string,
    params: unknown,
    decoder: (value: unknown) => A,
  ): Promise<A> => {
    if (terminal) return Promise.reject(new AcpFailure("closed", "ACP transport closed."));
    if (pending.size >= limits.pendingRequests) {
      return Promise.reject(new AcpFailure("capacity", "ACP request capacity reached."));
    }
    const id = nextId++;
    return new Promise<A>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new AcpFailure("timeout", "ACP request timed out."));
      }, limits.requestTimeoutMs);
      pending.set(id, {
        decode: decoder,
        resolve: (value) => resolve(value as A),
        reject,
        timeout,
      });
      void write({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        const current = pending.get(id);
        if (current === undefined) return;
        pending.delete(id);
        clearTimeout(current.timeout);
        reject(
          error instanceof AcpFailure ? error : new AcpFailure("closed", "ACP transport failed."),
        );
      });
    });
  };

  const close = async () => {
    if (terminal) return;
    options.stdin.end();
    finish();
    await writeChain;
  };

  options.stdout.on("data", onStdoutData);
  options.stdout.on("end", onStdoutEnd);
  options.stdout.on("error", onStdoutError);
  options.stdin.on("error", onStdinError);
  options.stderr?.on("data", onStderrData);
  options.stderr?.on("end", onStderrEnd);
  options.stderr?.on("error", onStderrError);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    exited,
    initialize: (metadata) =>
      request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            ...(metadata === undefined ? {} : { _meta: metadata }),
          },
          clientInfo: { name: "Octant", version: "1" },
        },
        decode(InitializeResult),
      ),
    authenticate: () =>
      request("authenticate", { methodId: "login" }, decode(EmptyResult)).then(() => undefined),
    authenticateWith: (methodId, fields = {}) =>
      request("authenticate", { methodId, ...fields }, decode(EmptyResult)),
    startBrowserAuthentication: () =>
      request(
        "authenticate",
        { methodId: "browser-auth-delegated", action: "start" },
        decode(DelegatedBrowserStart),
      ).then((response) => response._meta["browser-auth-delegated"]),
    completeBrowserAuthentication: (attemptId) =>
      request(
        "authenticate",
        { methodId: "browser-auth-delegated", action: "complete", attemptId },
        decode(DelegatedBrowserComplete),
      ).then(() => undefined),
    newSession: (cwd) => request("session/new", { cwd, mcpServers: [] }, decode(NewSessionResult)),
    loadSession: (sessionId, cwd) =>
      request("session/load", { sessionId, cwd, mcpServers: [] }, decode(NewSessionResult)),
    resumeSession: (sessionId, cwd) =>
      request("session/resume", { sessionId, cwd, mcpServers: [] }, decode(NewSessionResult)),
    prompt: (sessionId, prompt) =>
      request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: prompt }] },
        decode(PromptResult),
      ),
    setConfigOption: (sessionId, configId, value) =>
      request(
        "session/set_config_option",
        { sessionId, configId, value },
        decode(ConfigOptionsResult),
      ),
    call: <T>(method: string, params: Record<string, unknown>) =>
      request<T>(method, params, decode(Schema.Unknown) as (value: unknown) => T),
    closeSession: (sessionId) =>
      request("session/close", { sessionId }, decode(EmptyResult)).then(() => undefined),
    onNotification: (listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onRequest: (listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    respond: (id, result) => write({ jsonrpc: "2.0", id, result }),
    respondPermission: (id, optionId) =>
      write({
        jsonrpc: "2.0",
        id,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      }),
    reject: (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } }),
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    close,
  };
}
