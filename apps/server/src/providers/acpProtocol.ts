import { Schema } from "effect";
import type { Readable, Writable } from "node:stream";
const decode = <A, I>(schema: Schema.Schema<A, I>) => Schema.decodeUnknownSync(schema);
const RpcId = Schema.Union(Schema.String, Schema.Int);
type RpcId = typeof RpcId.Type;

const InitializeResult = Schema.Struct({
  protocolVersion: Schema.Int,
  agentCapabilities: Schema.Struct({
    loadSession: Schema.optional(Schema.Boolean),
    mcpCapabilities: Schema.optional(
      Schema.Struct({
        http: Schema.optional(Schema.Boolean),
        sse: Schema.optional(Schema.Boolean),
        acp: Schema.optional(Schema.Boolean),
      }),
    ),
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

/** The only MCP transport Octant currently offers to an ACP agent. */
export interface AcpMcpHttpServer {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

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
      // Facts about a model that ACP names no standard field for — the model's
      // own reasoning levels, for one — travel in the extension slot.
      _meta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    }),
  ),
});
export type AcpSessionModelState = typeof SessionModelState.Type;
export type AcpSessionModel = AcpSessionModelState["availableModels"][number];

const NewSessionResult = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  configOptions: Schema.optional(Schema.Array(SessionConfigOption)),
  models: Schema.optional(SessionModelState),
});
export type AcpNewSessionResult = typeof NewSessionResult.Type;

// Load/resume acknowledge the requested identity; unlike session/new, ACP
// does not require them to return a sessionId (Vibe omits it).
const ExistingSessionResult = Schema.Struct({
  configOptions: Schema.optional(Schema.Array(SessionConfigOption)),
  models: Schema.optional(SessionModelState),
});

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
    title: Schema.optional(Schema.NullOr(Schema.String)),
    kind: Schema.optional(Schema.NullOr(Schema.NonEmptyTrimmedString)),
  }),
  options: Schema.Array(
    Schema.Struct({
      optionId: Schema.NonEmptyTrimmedString,
      name: Schema.NonEmptyTrimmedString,
      kind: Schema.NonEmptyTrimmedString,
    }),
  ),
});

const AcpClientRequestMeta = Schema.optional(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);
const AcpClientReadTextFileParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  path: Schema.String,
  line: Schema.optional(Schema.Int),
  limit: Schema.optional(Schema.Int),
  _meta: AcpClientRequestMeta,
});
const AcpClientWriteTextFileParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  path: Schema.String,
  content: Schema.String,
  _meta: AcpClientRequestMeta,
});
const AcpClientTerminalCreateParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        value: Schema.String,
      }),
    ),
  ),
  cwd: Schema.optional(Schema.String),
  outputByteLimit: Schema.optional(Schema.Int),
  _meta: AcpClientRequestMeta,
});
const AcpClientTerminalOutputParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  terminalId: Schema.String,
  _meta: AcpClientRequestMeta,
});
const AcpClientTerminalWaitForExitParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  terminalId: Schema.String,
  _meta: AcpClientRequestMeta,
});
const AcpClientTerminalKillParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  terminalId: Schema.String,
  _meta: AcpClientRequestMeta,
});
const AcpClientTerminalReleaseParams = Schema.Struct({
  sessionId: Schema.NonEmptyTrimmedString,
  terminalId: Schema.String,
  _meta: AcpClientRequestMeta,
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

export type AcpClientCapabilityRequest =
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: "fs/read_text_file";
      readonly capability: "readTextFile";
      readonly params: typeof AcpClientReadTextFileParams.Type;
    }
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: "fs/write_text_file";
      readonly capability: "writeTextFile";
      readonly params: typeof AcpClientWriteTextFileParams.Type;
    }
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: "terminal/create";
      readonly capability: "terminalCreate";
      readonly params: typeof AcpClientTerminalCreateParams.Type;
    }
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: "terminal/output";
      readonly capability: "terminalOutput";
      readonly params: typeof AcpClientTerminalOutputParams.Type;
    }
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: "terminal/wait_for_exit";
      readonly capability: "terminalWaitForExit";
      readonly params: typeof AcpClientTerminalWaitForExitParams.Type;
    }
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: "terminal/kill";
      readonly capability: "terminalKill";
      readonly params: typeof AcpClientTerminalKillParams.Type;
    }
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: "terminal/release";
      readonly capability: "terminalRelease";
      readonly params: typeof AcpClientTerminalReleaseParams.Type;
    };

export type AcpServerRequestMessage = AcpServerRequest | AcpClientCapabilityRequest;

export interface AcpClientCapabilities {
  readonly readTextFile: boolean;
  readonly writeTextFile: boolean;
  readonly terminal: boolean;
}

type FailureKind = "capacity" | "closed" | "protocol" | "remote" | "timeout";
export type AcpRemoteFailureReason =
  | "authentication"
  | "configuration"
  | "workspace"
  | "model"
  | "network"
  | "unknown";

export class AcpFailure extends Error {
  override readonly name = "AcpFailure";

  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly remoteReason?: AcpRemoteFailureReason,
  ) {
    super(message);
  }
}

function remoteFailureReason(error: AcpRemoteError): AcpRemoteFailureReason {
  if (refusesForAuthentication(error)) return "authentication";
  const detail = typeof error.data === "string" ? error.data : "";
  const text = `${error.message ?? ""} ${detail}`.toLowerCase();
  if (/config|setting|argument|option/.test(text)) return "configuration";
  if (/workspace|working directory|cwd|trust/.test(text)) return "workspace";
  if (/model|provider|deployment/.test(text)) return "model";
  if (/network|connection|dns|resolve|tls|certificate/.test(text)) return "network";
  return "unknown";
}

interface AcpRemoteError {
  readonly code: number;
  readonly message?: string;
  readonly data?: unknown;
}

// An agent that refuses a request for a credential reason spells it several
// ways, and only the never-signed-in case reliably arrives as -32000. Observed
// on grok 1.0.4 and vibe-acp 2.24.1: a never-signed-in home refuses
// `session/new` with -32000 ("Authentication required", "Missing API key for
// mistral provider."), while a home holding an expired or invalid credential
// opens the session and refuses `session/prompt` with -32603 ("Unauthorized
// (401) ... Invalid or expired credentials", "Invalid API key."). Classifying
// on the code alone reported the second case as a generic failure, so the user
// was never told to sign in again.
const AUTHENTICATION_REFUSAL_TERMS = [
  "unauthorized",
  "unauthenticated",
  "authentication",
  "api key",
  "credentials",
];

function refusesForAuthentication(error: AcpRemoteError): boolean {
  if (error.code === -32000) return true;
  const detail = typeof error.data === "string" ? error.data : "";
  const text = `${error.message ?? ""} ${detail}`.toLowerCase();
  return AUTHENTICATION_REFUSAL_TERMS.some((term) => text.includes(term));
}

export interface AcpLimits {
  readonly lineBytes: number;
  readonly pendingRequests: number;
  readonly queuedMessages: number;
  /** Bounds the handshake and every request that is not a turn. */
  readonly requestTimeoutMs: number;
  /** Bounds one turn: the agent keeps working while this request is open. */
  readonly turnTimeoutMs: number;
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
    capabilities: AcpClientCapabilities,
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
  newSession(
    cwd: string,
    mcpServers?: ReadonlyArray<AcpMcpHttpServer>,
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<AcpNewSessionResult>;
  loadSession(
    sessionId: string,
    cwd: string,
    mcpServers?: ReadonlyArray<AcpMcpHttpServer>,
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<AcpNewSessionResult>;
  resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers?: ReadonlyArray<AcpMcpHttpServer>,
    meta?: Readonly<Record<string, unknown>>,
  ): Promise<AcpNewSessionResult>;
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
  onRequest(listener: (message: AcpServerRequestMessage) => void): () => void;
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
  // A turn is not a request: `session/prompt` stays open until the agent
  // finishes, so it needs its own budget. Without one, a caller that wires the
  // request budget from a startup deadline cancels every longer reply.
  turnTimeoutMs: 600_000,
  stderrBytes: 65_536,
};

interface PendingRequest {
  readonly decode: (value: unknown) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (failure: AcpFailure) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type QueuedMessage = AcpServerNotification | AcpServerRequestMessage;

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
    response: { readonly result?: unknown; readonly error?: AcpRemoteError },
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
          refusesForAuthentication(response.error)
            ? "ACP authentication is required."
            : "ACP request failed.",
          remoteFailureReason(response.error),
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
        error: Schema.optional(
          Schema.Struct({
            code: Schema.Int,
            message: Schema.String,
            data: Schema.optional(Schema.Unknown),
          }),
        ),
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
      try {
        enqueue({
          kind: "request",
          id: envelope.id,
          method: "session/request_permission",
          params: decode(PermissionRequestParams)(envelope.params),
        });
      } catch {
        void write({
          jsonrpc: "2.0",
          id: envelope.id,
          error: { code: -32602, message: "Invalid params" },
        });
      }
      return;
    }
    const capabilityRequest: AcpClientCapabilityRequest | "invalid-params" | undefined = (() => {
      try {
        return envelope.method === "fs/read_text_file"
          ? {
              kind: "request" as const,
              id: envelope.id,
              method: "fs/read_text_file",
              capability: "readTextFile" as const,
              params: decode(AcpClientReadTextFileParams)(envelope.params),
            }
          : envelope.method === "fs/write_text_file"
            ? {
                kind: "request" as const,
                id: envelope.id,
                method: "fs/write_text_file",
                capability: "writeTextFile" as const,
                params: decode(AcpClientWriteTextFileParams)(envelope.params),
              }
            : envelope.method === "terminal/create"
              ? {
                  kind: "request" as const,
                  id: envelope.id,
                  method: "terminal/create",
                  capability: "terminalCreate" as const,
                  params: decode(AcpClientTerminalCreateParams)(envelope.params),
                }
              : envelope.method === "terminal/output"
                ? {
                    kind: "request" as const,
                    id: envelope.id,
                    method: "terminal/output",
                    capability: "terminalOutput" as const,
                    params: decode(AcpClientTerminalOutputParams)(envelope.params),
                  }
                : envelope.method === "terminal/wait_for_exit"
                  ? {
                      kind: "request" as const,
                      id: envelope.id,
                      method: "terminal/wait_for_exit",
                      capability: "terminalWaitForExit" as const,
                      params: decode(AcpClientTerminalWaitForExitParams)(envelope.params),
                    }
                  : envelope.method === "terminal/kill"
                    ? {
                        kind: "request" as const,
                        id: envelope.id,
                        method: "terminal/kill",
                        capability: "terminalKill" as const,
                        params: decode(AcpClientTerminalKillParams)(envelope.params),
                      }
                    : envelope.method === "terminal/release"
                      ? {
                          kind: "request" as const,
                          id: envelope.id,
                          method: "terminal/release",
                          capability: "terminalRelease" as const,
                          params: decode(AcpClientTerminalReleaseParams)(envelope.params),
                        }
                      : undefined;
      } catch {
        return "invalid-params" as const;
      }
    })();
    if (capabilityRequest === "invalid-params") {
      void write({
        jsonrpc: "2.0",
        id: envelope.id,
        error: { code: -32602, message: "Invalid params" },
      });
      return;
    }
    if (capabilityRequest !== undefined) {
      enqueue(capabilityRequest);
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
    timeoutMs: number = limits.requestTimeoutMs,
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
      }, timeoutMs);
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
    initialize: (
      capabilitiesOrMetadata:
        | AcpClientCapabilities
        | Readonly<Record<string, string | number | boolean>>
        | undefined = undefined,
      metadata = undefined,
    ) => {
      const capabilities =
        capabilitiesOrMetadata !== undefined &&
        "readTextFile" in capabilitiesOrMetadata &&
        typeof capabilitiesOrMetadata.readTextFile === "boolean"
          ? capabilitiesOrMetadata
          : { readTextFile: false, writeTextFile: false, terminal: false };
      const resolvedMetadata =
        metadata ?? (capabilities === capabilitiesOrMetadata ? undefined : capabilitiesOrMetadata);
      return request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: {
              readTextFile: capabilities.readTextFile,
              writeTextFile: capabilities.writeTextFile,
            },
            terminal: capabilities.terminal,
            ...(resolvedMetadata === undefined ? {} : { _meta: resolvedMetadata }),
          },
          clientInfo: { name: "Octant", version: "1" },
        },
        decode(InitializeResult),
      );
    },
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
    newSession: (cwd, mcpServers = [], meta) =>
      request(
        "session/new",
        { cwd, mcpServers, ...(meta === undefined ? {} : { _meta: meta }) },
        decode(NewSessionResult),
      ),
    loadSession: (sessionId, cwd, mcpServers = [], meta) =>
      request(
        "session/load",
        { sessionId, cwd, mcpServers, ...(meta === undefined ? {} : { _meta: meta }) },
        decode(ExistingSessionResult),
      ).then((result) => ({ ...result, sessionId })),
    resumeSession: (sessionId, cwd, mcpServers = [], meta) =>
      request(
        "session/resume",
        { sessionId, cwd, mcpServers, ...(meta === undefined ? {} : { _meta: meta }) },
        decode(ExistingSessionResult),
      ).then((result) => ({ ...result, sessionId })),
    prompt: (sessionId, prompt) =>
      request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: prompt }] },
        decode(PromptResult),
        limits.turnTimeoutMs,
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
