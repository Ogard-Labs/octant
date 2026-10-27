import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Schema } from "effect";
import {
  SSH_EXECUTOR_MAX_TERMINAL_CHUNK_BYTES,
  SSH_EXECUTOR_TERMINAL_WINDOW_BYTES,
  SshExecutorFrame,
  type SshExecutorOpenTerminalRequest,
  type SshEgressAddress,
  type SshEgressHostName,
  type SshExecutorHello,
  type SshExecutorHostFrame,
  type SshExecutorReply,
  type SshExecutorRequest,
} from "@octant/contracts/ssh-executor-protocol";
import { encodeExecutorFrame, ExecutorFrameReader } from "./executorFrames";
import { ExecutorStreams, type ExecutorStream } from "./executorStreams";

/**
 * This host's end of one executor session: the frames that come back on the
 * SSH client's standard output, and the requests written to its input.
 * Canonical: docs/design/remote-ssh-environments.md § Transport.
 *
 * Requests run one at a time, in the order asked; the next is written only
 * after the last was answered. A frame that does not decode, a second
 * introduction, or a reply that answers no request in flight is a violation:
 * the session ends, because a stream that lost its framing or its turn order
 * cannot be trusted with the next answer. A request the executor does not
 * answer in time ends the session too, so a late answer can never be read as
 * the reply to the request after it.
 *
 * A proxied command's request carries its egress while it runs: each stream
 * the executor opens for it goes to that egress, and only then may this host
 * ask the target to resolve a name or open a connection. A stream opened
 * while no proxied command runs is a violation.
 *
 * An open terminal lives beside the requests. Its output goes to the listener
 * that opened it, within the window this host grants back as the listener
 * takes it; output past the window, or for a terminal never opened, is a
 * violation. Every terminal ends with the session.
 */

const MAX_STDERR_BYTES = 16_384;
const MAX_WAITING_REQUESTS = 16;
/** Streams either direction holds at once, beyond the proxy's own limits. */
const MAX_STREAMS = 160;
const RESOLVE_TIMEOUT_MS = 15_000;

const decodeExecutorFrame = Schema.decodeUnknownEither(SshExecutorFrame);

export type ExecutorIntroduction =
  | { readonly status: "introduced"; readonly hello: SshExecutorHello }
  /** The first frame was not an introduction, or did not decode. */
  | { readonly status: "violated" }
  /** The session ended first; `stderr` is the client's own account of why. */
  | { readonly status: "ended"; readonly code: number | null; readonly stderr: string }
  | { readonly status: "timed-out" };

export type ExecutorRequestOutcome =
  | { readonly status: "replied"; readonly reply: SshExecutorReply }
  | { readonly status: "lost"; readonly cause: "violated" | "ended" | "timed-out" | "queue-full" };

/** Where a running proxied command's forwarded connections go on this host. */
export interface ExecutorLaunchEgress {
  readonly onStream: (stream: ExecutorStream) => void;
}

export interface ExecutorRequestOptions {
  /** Aborting it asks the executor to stop the request; its reply still settles it. */
  readonly signal?: AbortSignal | undefined;
  readonly egress?: ExecutorLaunchEgress | undefined;
}

/** What becomes of one open terminal's output and its end. */
export interface ExecutorTerminalListener {
  readonly output: (bytes: Buffer) => void;
  /** The shell exited (`exited`), or the session ended under it (`lost`). Called once. */
  readonly end: (
    ending:
      | { readonly kind: "exited"; readonly exitCode: number | undefined }
      | { readonly kind: "lost" },
  ) => void;
}

/** One terminal of this session, as this host drives it. */
export interface ExecutorTerminal {
  readonly id: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  close(): void;
}

export type ExecutorTerminalOpening =
  | { readonly status: "opened"; readonly terminal: ExecutorTerminal }
  | { readonly status: "replied"; readonly reply: SshExecutorReply }
  | { readonly status: "lost" };

interface InFlight {
  readonly id: number;
  readonly egress: ExecutorLaunchEgress | undefined;
  readonly settle: (outcome: ExecutorRequestOutcome) => void;
}

export class ExecutorChannel {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader = new ExecutorFrameReader({ expectPreamble: true });
  readonly #waiting: Array<() => void> = [];
  readonly #endListeners = new Set<() => void>();
  readonly #introduction: Promise<ExecutorIntroduction>;
  /** Connections the executor forwarded from a running command (odd ids). */
  readonly #forwarded: ExecutorStreams;
  /** Connections this host asked the target to open (even ids). */
  readonly #dialed: ExecutorStreams;
  readonly #dialing = new Map<number, ExecutorStream>();
  readonly #questions = new Map<number, (addresses: ReadonlyArray<string> | undefined) => void>();
  /** Open terminals, and output each sent that this host has not granted back yet. */
  readonly #terminals = new Map<
    number,
    { readonly listener: ExecutorTerminalListener; outstanding: number }
  >();
  #nextTerminal = 1;
  #introduce: (outcome: ExecutorIntroduction) => void = () => undefined;
  #introduced = false;
  #inFlight: InFlight | undefined;
  #busy = false;
  #nextId = 1;
  #nextQuestion = 1;
  #ended: "violated" | "ended" | "timed-out" | undefined;
  #stderr = "";

  constructor(child: ChildProcessWithoutNullStreams, options: { readonly helloTimeoutMs: number }) {
    this.#child = child;
    const send = (frame: SshExecutorHostFrame) => this.#write(frame);
    this.#forwarded = new ExecutorStreams({ send, opens: "even", maxStreams: MAX_STREAMS });
    this.#dialed = new ExecutorStreams({ send, opens: "even", maxStreams: MAX_STREAMS });
    this.#introduction = new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        this.#end("timed-out");
      }, options.helloTimeoutMs);
      this.#introduce = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
    });
    child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.#stderr.length < MAX_STDERR_BYTES) this.#stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => undefined);
    // A client that could not start reports `error` and may never `close`.
    child.once("error", () => this.#onExit(null));
    child.once("close", (code) => this.#onExit(code));
  }

  /** The executor's introduction, or why none came. */
  introduction(): Promise<ExecutorIntroduction> {
    return this.#introduction;
  }

  get ended(): boolean {
    return this.#ended !== undefined;
  }

  /**
   * Called once when the session ends, for whatever reason. The returned
   * function stops listening, for a caller that no longer cares.
   */
  onEnd(listener: () => void): () => void {
    if (this.#ended !== undefined) {
      listener();
      return () => undefined;
    }
    this.#endListeners.add(listener);
    return () => {
      this.#endListeners.delete(listener);
    };
  }

  /** Writes one request after the last one was answered, and waits for its reply. */
  async request(
    request: SshExecutorRequest,
    timeoutMs: number,
    options: ExecutorRequestOptions = {},
  ): Promise<ExecutorRequestOutcome> {
    if (this.#ended !== undefined) return { status: "lost", cause: this.#ended };
    if (this.#busy) {
      if (this.#waiting.length >= MAX_WAITING_REQUESTS) {
        return { status: "lost", cause: "queue-full" };
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
      if (this.#ended !== undefined) return { status: "lost", cause: this.#ended };
    }
    this.#busy = true;
    try {
      return await this.#send(request, timeoutMs, options);
    } finally {
      this.#busy = false;
      this.#waiting.shift()?.();
    }
  }

  /**
   * The target's answers for a name, asked only while a proxied command runs;
   * undefined when it did not resolve or no such command runs.
   */
  resolve(host: SshEgressHostName): Promise<ReadonlyArray<string> | undefined> {
    if (this.#ended !== undefined || this.#inFlight?.egress === undefined) {
      return Promise.resolve(undefined);
    }
    const question = this.#nextQuestion;
    this.#nextQuestion += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer(undefined), RESOLVE_TIMEOUT_MS);
      const answer = (addresses: ReadonlyArray<string> | undefined) => {
        clearTimeout(timer);
        this.#questions.delete(question);
        resolve(addresses);
      };
      this.#questions.set(question, answer);
      this.#write({ type: "resolve", question, host });
    });
  }

  /**
   * A connection from the target to an address this host checked, as a
   * stream that emits `connect` once the target reached it and closes if it
   * could not. Undefined when no proxied command runs or past the limit.
   */
  dial(address: SshEgressAddress, port: number): ExecutorStream | undefined {
    if (this.#ended !== undefined || this.#inFlight?.egress === undefined) return undefined;
    const stream = this.#dialed.open();
    if (stream === undefined) return undefined;
    this.#dialing.set(stream.id, stream);
    stream.once("close", () => this.#dialing.delete(stream.id));
    this.#write({ type: "dial", stream: stream.id, address, port });
    return stream;
  }

  /**
   * Asks the executor to open a terminal under a new id, as the session's
   * one request. Its output goes to `listener` from the moment it is asked
   * for, and each chunk's room is granted back once the listener took it, so
   * the executor holds the shell while this host falls behind. A reply other
   * than `terminal-opened` is handed back, and the id is never used again.
   */
  async openTerminal(
    request: Omit<SshExecutorOpenTerminalRequest, "terminal">,
    listener: ExecutorTerminalListener,
    timeoutMs: number,
  ): Promise<ExecutorTerminalOpening> {
    if (this.#ended !== undefined) return { status: "lost" };
    const id = this.#nextTerminal;
    this.#nextTerminal += 1;
    const entry = { listener, outstanding: 0 };
    this.#terminals.set(id, entry);
    const outcome = await this.request({ ...request, terminal: id }, timeoutMs);
    if (outcome.status !== "replied") {
      this.#terminals.delete(id);
      return { status: "lost" };
    }
    if (outcome.reply.kind !== "terminal-opened") {
      this.#terminals.delete(id);
      return { status: "replied", reply: outcome.reply };
    }
    return {
      status: "opened",
      terminal: {
        id,
        write: (data) => {
          if (!this.#terminals.has(id)) return;
          // Whole characters per frame, so the executor can hand each one to
          // the shell as text.
          for (const chunk of utf8Chunks(data, SSH_EXECUTOR_MAX_TERMINAL_CHUNK_BYTES)) {
            this.#write({ type: "terminal-input", terminal: id, data: chunk.toString("base64") });
          }
        },
        resize: (columns, rows) => {
          if (this.#terminals.has(id)) {
            this.#write({ type: "terminal-resize", terminal: id, columns, rows });
          }
        },
        close: () => {
          if (this.#terminals.has(id)) this.#write({ type: "terminal-close", terminal: id });
        },
      },
    };
  }

  /** Ends the session; the executor exits when its input closes. */
  close(): void {
    this.#end("ended");
  }

  #send(
    request: SshExecutorRequest,
    timeoutMs: number,
    options: ExecutorRequestOptions,
  ): Promise<ExecutorRequestOutcome> {
    return new Promise((resolve) => {
      const id = this.#nextId;
      this.#nextId += 1;
      const encoded = encodeExecutorFrame({ type: "request", id, request });
      if (encoded.status !== "encoded") {
        resolve({ status: "lost", cause: "violated" });
        return;
      }
      const timer = setTimeout(() => this.#end("timed-out"), timeoutMs);
      const cancel = () => this.#write({ type: "cancel", id });
      this.#inFlight = {
        id,
        egress: options.egress,
        settle: (outcome) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
          this.#inFlight = undefined;
          // A command's egress ends with it: its streams close and no
          // question about it is answered any more.
          if (options.egress !== undefined) this.#endLaunchEgress();
          resolve(outcome);
        },
      };
      this.#child.stdin.write(encoded.bytes);
      if (options.signal?.aborted === true) cancel();
      else options.signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  #write(frame: SshExecutorHostFrame): void {
    if (this.#ended !== undefined) return;
    const encoded = encodeExecutorFrame(frame);
    if (encoded.status !== "encoded") {
      this.#end("violated");
      return;
    }
    this.#child.stdin.write(encoded.bytes);
  }

  #onData(chunk: Buffer): void {
    if (this.#ended !== undefined) return;
    const reading = this.#reader.push(chunk);
    if (reading.status === "violated") {
      this.#end("violated");
      return;
    }
    for (const value of reading.frames) {
      if (this.#ended !== undefined) return;
      const decoded = decodeExecutorFrame(value);
      if (decoded._tag === "Left") {
        this.#end("violated");
        return;
      }
      const frame = decoded.right;
      if (!this.#introduced) {
        if (frame.type !== "hello") {
          this.#end("violated");
          return;
        }
        this.#introduced = true;
        this.#introduce({ status: "introduced", hello: frame });
        continue;
      }
      if (this.#receive(frame) === "violated") {
        this.#end("violated");
        return;
      }
    }
  }

  #receive(frame: SshExecutorFrame): "accepted" | "violated" {
    const inFlight = this.#inFlight;
    switch (frame.type) {
      case "hello":
        return "violated";
      case "reply":
        if (inFlight === undefined || frame.id !== inFlight.id) return "violated";
        inFlight.settle({ status: "replied", reply: frame.reply });
        return "accepted";
      case "stream-open": {
        if (inFlight?.egress === undefined) return "violated";
        const stream = this.#forwarded.adopt(frame.stream);
        if (stream === "violated") return "violated";
        if (stream !== "refused") inFlight.egress.onStream(stream);
        return "accepted";
      }
      case "dialed": {
        const stream = this.#dialing.get(frame.stream);
        // A dial this host already gave up on can still be answered.
        if (stream === undefined)
          return this.#dialed.opened(frame.stream) ? "accepted" : "violated";
        this.#dialing.delete(frame.stream);
        if (frame.connected) stream.emit("connect");
        else stream.destroy();
        return "accepted";
      }
      case "resolved": {
        const answer = this.#questions.get(frame.question);
        if (answer !== undefined) answer(frame.addresses);
        return frame.question < this.#nextQuestion ? "accepted" : "violated";
      }
      case "terminal-output": {
        const terminal = this.#terminals.get(frame.terminal);
        // A terminal this host stopped following can still have output in
        // flight; one it never asked for cannot.
        if (terminal === undefined) {
          return frame.terminal < this.#nextTerminal ? "accepted" : "violated";
        }
        const bytes = Buffer.from(frame.data, "base64");
        terminal.outstanding += bytes.byteLength;
        if (bytes.byteLength === 0 || terminal.outstanding > SSH_EXECUTOR_TERMINAL_WINDOW_BYTES) {
          return "violated";
        }
        terminal.listener.output(bytes);
        // The listener took the bytes into its own bounded record, so their
        // room goes back to the executor at once.
        terminal.outstanding -= bytes.byteLength;
        this.#write({ type: "terminal-credit", terminal: frame.terminal, bytes: bytes.byteLength });
        return "accepted";
      }
      case "terminal-exited": {
        const terminal = this.#terminals.get(frame.terminal);
        if (terminal === undefined) {
          return frame.terminal < this.#nextTerminal ? "accepted" : "violated";
        }
        this.#terminals.delete(frame.terminal);
        terminal.listener.end({ kind: "exited", exitCode: frame.exitCode });
        return "accepted";
      }
      default:
        return (frame.stream % 2 === 1 ? this.#forwarded : this.#dialed).receive(frame);
    }
  }

  #endLaunchEgress(): void {
    this.#forwarded.closeAll();
    this.#dialed.closeAll();
    this.#dialing.clear();
    for (const answer of this.#questions.values()) answer(undefined);
  }

  #onExit(code: number | null): void {
    if (this.#ended === undefined) this.#ended = "ended";
    this.#introduce(
      this.#ended === "ended"
        ? { status: "ended", code, stderr: this.#stderr }
        : this.#ended === "violated"
          ? { status: "violated" }
          : { status: "timed-out" },
    );
    this.#finish();
  }

  #end(cause: "violated" | "ended" | "timed-out"): void {
    if (this.#ended !== undefined) return;
    this.#ended = cause;
    this.#child.stdin.end();
    // A session this host ends on purpose closes gently, so the executor can
    // remove its runtime directory; one that broke its protocol or stalled
    // is cut off.
    this.#child.kill(cause === "ended" ? "SIGTERM" : "SIGKILL");
    this.#introduce(
      cause === "violated"
        ? { status: "violated" }
        : cause === "timed-out"
          ? { status: "timed-out" }
          : { status: "ended", code: null, stderr: this.#stderr },
    );
    this.#finish();
  }

  #finish(): void {
    const cause = this.#ended ?? "ended";
    // The session is gone, so its streams go without a word to it.
    this.#forwarded.abandonAll();
    this.#dialed.abandonAll();
    this.#dialing.clear();
    for (const answer of this.#questions.values()) answer(undefined);
    // Every shell on the target died with the session.
    const terminals = [...this.#terminals.values()];
    this.#terminals.clear();
    for (const terminal of terminals) terminal.listener.end({ kind: "lost" });
    this.#inFlight?.settle({ status: "lost", cause });
    for (const release of this.#waiting.splice(0)) release();
    const listeners = [...this.#endListeners];
    this.#endListeners.clear();
    for (const listener of listeners) listener();
  }
}

/** The text's UTF-8 bytes in pieces of at most `maximum`, never splitting a character. */
function utf8Chunks(text: string, maximum: number): ReadonlyArray<Buffer> {
  const chunks: Buffer[] = [];
  let pending: Buffer[] = [];
  let size = 0;
  for (const character of text) {
    const bytes = Buffer.from(character, "utf8");
    if (size + bytes.byteLength > maximum) {
      chunks.push(Buffer.concat(pending));
      pending = [];
      size = 0;
    }
    pending.push(bytes);
    size += bytes.byteLength;
  }
  if (size > 0) chunks.push(Buffer.concat(pending));
  return chunks;
}
