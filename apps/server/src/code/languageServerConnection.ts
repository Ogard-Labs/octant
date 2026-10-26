import type { Readable, Writable } from "node:stream";

/**
 * Octant's end of one language server's Language Server Protocol connection:
 * JSON-RPC frames on the child's stdio. Canonical:
 * docs/design/language-services.md § Process model.
 *
 * Everything protocol-shaped stops here. The connection sends only the
 * methods on Octant's allow-list, answers the few server requests Octant
 * accepts, and gives every other server request a method-not-found error, so
 * a server asking to edit files, run a command, or open a document gets
 * nothing done. A frame over the cap, or one that cannot be read, ends the
 * connection; its owner stops the child.
 */

/** The largest frame either side may send, body bytes. */
export const LANGUAGE_SERVER_FRAME_CAP_BYTES = 4 * 1024 * 1024;
/** Headers are a line or two; anything longer is not a frame. */
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_CONFIGURATION_ITEMS = 256;

const METHOD_NOT_FOUND = -32601;
const REQUEST_FAILED = -32803;

export type LanguageServerClientRequest =
  | "initialize"
  | "shutdown"
  | "textDocument/diagnostic"
  | "textDocument/definition";

export type LanguageServerClientNotification =
  | "initialized"
  | "exit"
  | "textDocument/didOpen"
  | "textDocument/didChange"
  | "textDocument/didClose"
  | "workspace/didChangeWatchedFiles"
  | "$/cancelRequest";

const CLIENT_REQUESTS: ReadonlySet<string> = new Set<LanguageServerClientRequest>([
  "initialize",
  "shutdown",
  "textDocument/diagnostic",
  "textDocument/definition",
]);
const CLIENT_NOTIFICATIONS: ReadonlySet<string> = new Set<LanguageServerClientNotification>([
  "initialized",
  "exit",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "workspace/didChangeWatchedFiles",
  "$/cancelRequest",
]);
/**
 * What a server may register dynamically: only methods Octant already sends.
 * A registration for anything else (TypeScript asks for configuration-change
 * notices) is refused as a whole, and the server carries on without it.
 */
const REGISTRABLE_METHODS: ReadonlySet<string> = new Set([
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "textDocument/diagnostic",
  "textDocument/definition",
  "workspace/didChangeWatchedFiles",
]);

export type LanguageServerResponse =
  | { readonly status: "answered"; readonly result: unknown }
  /** The server answered with an error. */
  | { readonly status: "failed" }
  | { readonly status: "timed-out" }
  /** The connection ended before an answer, or the request could not be sent. */
  | { readonly status: "closed" };

export type LanguageServerSend = "sent" | "too-large" | "closed";

export type LanguageServerViolation = "oversize-frame" | "malformed-frame";

export interface LanguageServerConnectionOptions {
  /** The child's stdout. */
  readonly input: Readable;
  /** The child's stdin. */
  readonly output: Writable;
  readonly requestDeadlineMs: number;
  readonly onViolation: (violation: LanguageServerViolation) => void;
  /** A pushed `textDocument/publishDiagnostics`, unparsed. */
  readonly onPublishedDiagnostics?: (uri: string, diagnostics: ReadonlyArray<unknown>) => void;
}

interface PendingRequest {
  readonly resolve: (response: LanguageServerResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class LanguageServerConnection {
  readonly #output: Writable;
  readonly #requestDeadlineMs: number;
  readonly #onViolation: (violation: LanguageServerViolation) => void;
  readonly #onPublishedDiagnostics:
    | ((uri: string, diagnostics: ReadonlyArray<unknown>) => void)
    | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #registrations = new Map<string, string>();
  #buffered: Buffer = Buffer.alloc(0);
  #nextId = 1;
  #closed = false;

  constructor(options: LanguageServerConnectionOptions) {
    this.#output = options.output;
    this.#requestDeadlineMs = options.requestDeadlineMs;
    this.#onViolation = options.onViolation;
    this.#onPublishedDiagnostics = options.onPublishedDiagnostics;
    options.input.on("data", (chunk: Buffer) => this.#receive(chunk));
    options.input.on("end", () => this.close());
    options.input.on("error", () => this.close());
    // A child that exits mid-write must not take the host down with EPIPE.
    options.output.on("error", () => this.close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Whether the server registered `method` dynamically and has not lost it. */
  registered(method: LanguageServerClientNotification | LanguageServerClientRequest): boolean {
    return [...this.#registrations.values()].includes(method);
  }

  request(
    method: LanguageServerClientRequest,
    params?: unknown,
    deadlineMs = this.#requestDeadlineMs,
  ): Promise<LanguageServerResponse> {
    if (this.#closed || !CLIENT_REQUESTS.has(method)) {
      return Promise.resolve({ status: "closed" });
    }
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        // The answer is no longer wanted; a server that honours cancellation
        // can stop the work instead of finishing it for nobody.
        this.notify("$/cancelRequest", { id });
        resolve({ status: "timed-out" });
      }, deadlineMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, timer });
      const sent = this.#write({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
      if (sent !== "sent") this.#settle(id, { status: "closed" });
    });
  }

  notify(method: LanguageServerClientNotification, params?: unknown): LanguageServerSend {
    if (this.#closed || !CLIENT_NOTIFICATIONS.has(method)) return "closed";
    return this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Ends the connection; every request still waiting reads as `closed`. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffered = Buffer.alloc(0);
    for (const id of this.#pending.keys()) this.#settle(id, { status: "closed" });
  }

  #settle(id: number, response: LanguageServerResponse): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  #write(message: Readonly<Record<string, unknown>>): LanguageServerSend {
    if (this.#closed) return "closed";
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.byteLength > LANGUAGE_SERVER_FRAME_CAP_BYTES) return "too-large";
    try {
      this.#output.write(Buffer.concat([frameHeader(body.byteLength), body]));
    } catch {
      this.close();
      return "closed";
    }
    return "sent";
  }

  #violate(violation: LanguageServerViolation): void {
    if (this.#closed) return;
    this.close();
    this.#onViolation(violation);
  }

  #receive(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffered =
      this.#buffered.byteLength === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);
    while (!this.#closed) {
      const headerEnd = this.#buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.#buffered.byteLength > MAX_HEADER_BYTES) this.#violate("malformed-frame");
        return;
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        this.#violate("malformed-frame");
        return;
      }
      const length = contentLength(this.#buffered.subarray(0, headerEnd).toString("ascii"));
      if (length === undefined) {
        this.#violate("malformed-frame");
        return;
      }
      // Judged on the declared length, before the body arrives, so a server
      // cannot make the host buffer past the cap by sending slowly.
      if (length > LANGUAGE_SERVER_FRAME_CAP_BYTES) {
        this.#violate("oversize-frame");
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.#buffered.byteLength < bodyStart + length) return;
      const body = this.#buffered.subarray(bodyStart, bodyStart + length);
      this.#buffered = this.#buffered.subarray(bodyStart + length);
      let message: unknown;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        this.#violate("malformed-frame");
        return;
      }
      if (!isRecord(message)) {
        this.#violate("malformed-frame");
        return;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message: Readonly<Record<string, unknown>>): void {
    const method = typeof message.method === "string" ? message.method : undefined;
    const id = message.id;
    if (method !== undefined && (typeof id === "number" || typeof id === "string")) {
      this.#answerServerRequest(id, method, message.params);
      return;
    }
    if (method !== undefined) {
      if (method === "textDocument/publishDiagnostics" && isRecord(message.params)) {
        const { uri, diagnostics } = message.params;
        if (typeof uri === "string" && Array.isArray(diagnostics)) {
          this.#onPublishedDiagnostics?.(uri, diagnostics);
        }
      }
      // `window/logMessage`, `telemetry/event`, progress, and anything else
      // the server announces carry nothing Octant acts on.
      return;
    }
    if (typeof message.id !== "number") return;
    this.#settle(
      message.id,
      message.error !== undefined && message.error !== null
        ? { status: "failed" }
        : { status: "answered", result: message.result },
    );
  }

  #answerServerRequest(id: number | string, method: string, params: unknown): void {
    switch (method) {
      case "client/registerCapability": {
        const registrations =
          isRecord(params) && Array.isArray(params.registrations) ? params.registrations : [];
        const accepted = registrations.every(
          (registration) =>
            isRecord(registration) &&
            typeof registration.id === "string" &&
            typeof registration.method === "string" &&
            REGISTRABLE_METHODS.has(registration.method),
        );
        if (!accepted || registrations.length === 0) {
          this.#write({
            jsonrpc: "2.0",
            id,
            error: { code: REQUEST_FAILED, message: "Octant does not accept this registration." },
          });
          return;
        }
        for (const registration of registrations) {
          if (isRecord(registration)) {
            this.#registrations.set(String(registration.id), String(registration.method));
          }
        }
        this.#write({ jsonrpc: "2.0", id, result: null });
        return;
      }
      case "workspace/configuration": {
        // Octant's fixed values: the server's own defaults for every section.
        // Nothing the person or the repository configured is passed through.
        const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
        this.#write({
          jsonrpc: "2.0",
          id,
          result: items.slice(0, MAX_CONFIGURATION_ITEMS).map(() => null),
        });
        return;
      }
      case "window/workDoneProgress/create":
        this.#write({ jsonrpc: "2.0", id, result: null });
        return;
      default:
        // `workspace/applyEdit`, `window/showDocument`,
        // `workspace/executeCommand`, and every request not named above.
        this.#write({
          jsonrpc: "2.0",
          id,
          error: { code: METHOD_NOT_FOUND, message: "Method not found." },
        });
    }
  }
}

function frameHeader(length: number): Buffer {
  return Buffer.from(`Content-Length: ${length}\r\n\r\n`, "ascii");
}

function contentLength(header: string): number | undefined {
  let length: number | undefined;
  for (const line of header.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) return undefined;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name !== "content-length") continue;
    if (!/^\d{1,10}$/.test(value) || length !== undefined) return undefined;
    length = Number(value);
  }
  return length;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
