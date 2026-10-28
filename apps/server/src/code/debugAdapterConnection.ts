import type { Readable, Writable } from "node:stream";
import type { ExtensionDebugChildAnnouncement } from "@octant/contracts";
import { contentLength, frameHeader } from "./languageServerConnection";

/**
 * Octant's end of one debug adapter's Debug Adapter Protocol connection:
 * JSON messages with a `Content-Length` header on the adapter's stdio.
 * Canonical: docs/design/language-services.md § Protocol.
 *
 * Everything protocol-shaped stops here. Octant sends only the requests on
 * its closed list: `launch` only on the session's own connection, `attach`
 * only on a child's. An adapter's own request (`runInTerminal`,
 * `startDebugging`, or anything else) is answered with a failure and has no
 * effect, and only the accepted events reach the session; `telemetry` output
 * and every other event are dropped. The one exception is the child
 * announcement an adapter declared (§ Child processes): on the session's own
 * connection, that `startDebugging` request or that event is handed to the
 * session, which decides whether a child connection follows. A frame over the
 * cap, or one that is not a frame, ends the connection and its owner ends the
 * session.
 */

/** The largest frame either side may send, body bytes. */
export const DEBUG_ADAPTER_FRAME_CAP_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;

/**
 * What Octant sends: the closed list. `restart`, memory and reverse requests
 * are not on it; `attach` is sent only on a child connection, in place of
 * `launch`.
 */
export type DebugAdapterRequestCommand =
  | "initialize"
  | "launch"
  | "attach"
  | "configurationDone"
  | "setBreakpoints"
  | "setExceptionBreakpoints"
  | "threads"
  | "stackTrace"
  | "scopes"
  | "variables"
  | "source"
  | "exceptionInfo"
  | "continue"
  | "next"
  | "stepIn"
  | "stepOut"
  | "pause"
  | "evaluate"
  | "terminate"
  | "disconnect"
  | "cancel";

const REQUEST_COMMANDS: ReadonlySet<string> = new Set<DebugAdapterRequestCommand>([
  "initialize",
  "launch",
  "attach",
  "configurationDone",
  "setBreakpoints",
  "setExceptionBreakpoints",
  "threads",
  "stackTrace",
  "scopes",
  "variables",
  "source",
  "exceptionInfo",
  "continue",
  "next",
  "stepIn",
  "stepOut",
  "pause",
  "evaluate",
  "terminate",
  "disconnect",
  "cancel",
]);

export type DebugAdapterEvent =
  | "initialized"
  | "stopped"
  | "continued"
  | "exited"
  | "terminated"
  | "thread"
  | "output"
  | "breakpoint"
  | "capabilities"
  | "invalidated"
  | "process"
  | "progressStart"
  | "progressUpdate"
  | "progressEnd";

const ACCEPTED_EVENTS: ReadonlySet<string> = new Set<DebugAdapterEvent>([
  "initialized",
  "stopped",
  "continued",
  "exited",
  "terminated",
  "thread",
  "output",
  "breakpoint",
  "capabilities",
  "invalidated",
  "process",
  "progressStart",
  "progressUpdate",
  "progressEnd",
]);

export type DebugAdapterResponse =
  | { readonly status: "answered"; readonly body: unknown }
  /** The adapter answered with a failure; `message` is its own text, unread. */
  | { readonly status: "failed"; readonly message: string | undefined }
  | { readonly status: "timed-out" }
  /** The connection ended before an answer, or the request could not be sent. */
  | { readonly status: "closed" };

export type DebugAdapterViolation = "oversize-frame" | "malformed-frame";

/**
 * Which connection this is: the session's own, on the capsule's stdio, which
 * `launch`es the program; or a child's, which `attach`es once to a process
 * the adapter announced.
 */
export type DebugAdapterConnectionRole = "session" | "child";

export interface DebugAdapterConnectionOptions {
  readonly role?: DebugAdapterConnectionRole;
  /** The capsule's stdout. */
  readonly input: Readable;
  /** The capsule's stdin. */
  readonly output: Writable;
  readonly requestDeadlineMs: number;
  readonly onViolation: (violation: DebugAdapterViolation) => void;
  /** An accepted event and its body, unparsed. */
  readonly onEvent: (event: DebugAdapterEvent, body: unknown) => void;
  /** An adapter's own request, after it was refused; the session counts what it asked. */
  readonly onRefusedRequest?: (command: string) => void;
  /** How the adapter declared it announces a child; absent when it declared none. */
  readonly childAnnouncement?: ExtensionDebugChildAnnouncement;
  /**
   * A declared child announcement on the session's own connection, with the
   * configuration it carries, unparsed. The session answers whether it takes
   * the child; a `startDebugging` request is answered with that.
   */
  readonly onChildAnnounced?: (configuration: unknown) => "accepted" | "refused";
}

interface PendingRequest {
  readonly resolve: (response: DebugAdapterResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class DebugAdapterConnection {
  readonly #output: Writable;
  readonly #requestDeadlineMs: number;
  readonly #onViolation: DebugAdapterConnectionOptions["onViolation"];
  readonly #onEvent: DebugAdapterConnectionOptions["onEvent"];
  readonly #onRefusedRequest: DebugAdapterConnectionOptions["onRefusedRequest"];
  readonly #role: DebugAdapterConnectionRole;
  readonly #childAnnouncement: ExtensionDebugChildAnnouncement | undefined;
  readonly #onChildAnnounced: DebugAdapterConnectionOptions["onChildAnnounced"];
  readonly #pending = new Map<number, PendingRequest>();
  #buffered: Buffer = Buffer.alloc(0);
  #nextSeq = 1;
  #closed = false;

  constructor(options: DebugAdapterConnectionOptions) {
    this.#output = options.output;
    this.#requestDeadlineMs = options.requestDeadlineMs;
    this.#onViolation = options.onViolation;
    this.#onEvent = options.onEvent;
    this.#onRefusedRequest = options.onRefusedRequest;
    this.#role = options.role ?? "session";
    this.#childAnnouncement = this.#role === "session" ? options.childAnnouncement : undefined;
    this.#onChildAnnounced = options.onChildAnnounced;
    options.input.on("data", (chunk: Buffer) => this.#receive(chunk));
    options.input.on("end", () => this.close());
    options.input.on("error", () => this.close());
    // An adapter that exits mid-write must not take the host down with EPIPE.
    options.output.on("error", () => this.close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Sends one request on the closed list. A command not on it is never
   * written, whatever the caller passes, and neither is `attach` on the
   * session's own connection or `launch` on a child's.
   */
  request(
    command: DebugAdapterRequestCommand,
    args?: unknown,
    deadlineMs = this.#requestDeadlineMs,
  ): Promise<DebugAdapterResponse> {
    if (
      this.#closed ||
      !REQUEST_COMMANDS.has(command) ||
      (command === "attach" && this.#role !== "child") ||
      (command === "launch" && this.#role !== "session")
    ) {
      return Promise.resolve({ status: "closed" });
    }
    const seq = this.#nextSeq++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(seq)) return;
        if (command !== "cancel") {
          void this.request("cancel", { requestId: seq }, deadlineMs);
        }
        resolve({ status: "timed-out" });
      }, deadlineMs);
      timer.unref?.();
      this.#pending.set(seq, { resolve, timer });
      const sent = this.#write({
        seq,
        type: "request",
        command,
        ...(args === undefined ? {} : { arguments: args }),
      });
      if (!sent) this.#settle(seq, { status: "closed" });
    });
  }

  /** Ends the connection; every request still waiting reads as `closed`. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffered = Buffer.alloc(0);
    for (const seq of this.#pending.keys()) this.#settle(seq, { status: "closed" });
  }

  #settle(seq: number, response: DebugAdapterResponse): void {
    const pending = this.#pending.get(seq);
    if (pending === undefined) return;
    this.#pending.delete(seq);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  #write(message: Readonly<Record<string, unknown>>): boolean {
    if (this.#closed) return false;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.byteLength > DEBUG_ADAPTER_FRAME_CAP_BYTES) return false;
    try {
      this.#output.write(Buffer.concat([frameHeader(body.byteLength), body]));
    } catch {
      this.close();
      return false;
    }
    return true;
  }

  #violate(violation: DebugAdapterViolation): void {
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
      // Judged on the declared length, before the body arrives, so an adapter
      // cannot make the host buffer past the cap by sending slowly.
      if (length > DEBUG_ADAPTER_FRAME_CAP_BYTES) {
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

  /**
   * A `startDebugging` the adapter declared, asking to attach to a child:
   * handed to the session, whose answer is the response. A request to
   * `launch` something is never a child of the program and is refused.
   */
  #takesChild(args: unknown): boolean {
    if (!isRecord(args) || args.request !== "attach" || !isRecord(args.configuration)) {
      return false;
    }
    return this.#onChildAnnounced?.(args.configuration) === "accepted";
  }

  #dispatch(message: Readonly<Record<string, unknown>>): void {
    switch (message.type) {
      case "response": {
        if (typeof message.request_seq !== "number") return;
        this.#settle(
          message.request_seq,
          message.success === true
            ? { status: "answered", body: message.body }
            : {
                status: "failed",
                message: typeof message.message === "string" ? message.message : undefined,
              },
        );
        return;
      }
      case "event": {
        const event = message.event;
        const announcement = this.#childAnnouncement;
        if (
          announcement?.kind === "event" &&
          event === announcement.event &&
          !isAcceptedEvent(event)
        ) {
          this.#onChildAnnounced?.(message.body);
          return;
        }
        if (!isAcceptedEvent(event)) return;
        // Telemetry rides on `output`; it is never shown or kept.
        if (event === "output" && isRecord(message.body) && message.body.category === "telemetry") {
          return;
        }
        this.#onEvent(event, message.body);
        return;
      }
      case "request": {
        // `runInTerminal` would have the host start a process the adapter
        // chose; `startDebugging` would start a second session nobody
        // confirmed. Neither, nor any other adapter request, is honoured.
        const command = typeof message.command === "string" ? message.command : "";
        if (
          command === "startDebugging" &&
          this.#childAnnouncement?.kind === "start-debugging" &&
          this.#takesChild(message.arguments)
        ) {
          if (typeof message.seq === "number") {
            this.#write({
              seq: this.#nextSeq++,
              type: "response",
              request_seq: message.seq,
              success: true,
              command,
            });
          }
          return;
        }
        if (typeof message.seq === "number") {
          this.#write({
            seq: this.#nextSeq++,
            type: "response",
            request_seq: message.seq,
            success: false,
            command,
            message: "Octant does not run this request.",
          });
        }
        this.#onRefusedRequest?.(command.slice(0, 64));
        return;
      }
      default:
        return;
    }
  }
}

function isAcceptedEvent(value: unknown): value is DebugAdapterEvent {
  return typeof value === "string" && ACCEPTED_EVENTS.has(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
