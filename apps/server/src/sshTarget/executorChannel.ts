import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Schema } from "effect";
import {
  SSH_EXECUTOR_MAX_PLACED_PROCESSES,
  SSH_EXECUTOR_MAX_TERMINAL_CHUNK_BYTES,
  SSH_EXECUTOR_TERMINAL_WINDOW_BYTES,
  SshExecutorFrame,
  type SshExecutorOpenTerminalRequest,
  type SshExecutorProcessEndedFrame,
  type SshExecutorStartProcessRequest,
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
 * A proxied launch carries its egress while it runs, a command until its
 * reply and a placed process until its end: each stream the executor opens
 * names its launch and goes to that launch's egress, and only while some
 * launch runs may this host ask the target to resolve a name or open a
 * connection. A stream that names no running launch is a violation.
 *
 * A placed process lives beside the requests on a stream this host opened.
 * Its output goes to that stream, and its end is the `process-ended` frame;
 * a frame on its stream after that, or an end for a process never started,
 * is a violation. Every placed process ends with the session.
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

/** How a request that places a process keeps its launch's egress past the reply. */
interface ExecutorRequestPlacement {
  /** Whether the launch's egress outlives this reply, as a started process's does. */
  readonly keepEgress?: (reply: SshExecutorReply) => boolean;
  /** Told the request's id as it is written: the id the launch's connections name. */
  readonly sent?: (id: number) => void;
}

/** How a placed process ended: on the target, or with the session that carried it. */
export type ExecutorProcessEnd =
  | {
      readonly kind: "exited";
      readonly exitCode: number | undefined;
      readonly signal: string | undefined;
      /** The last of its standard error. */
      readonly stderr: Buffer;
    }
  | { readonly kind: "lost" };

/** One placed process of this session, as this host drives it. */
export interface ExecutorPlacedProcess {
  /** Its standard input and output. Output ends when the process does. */
  readonly stream: ExecutorStream;
  /** Resolves once, when the process ended or the session was lost. */
  readonly ended: Promise<ExecutorProcessEnd>;
  /** Asks the executor to stop it: a terminate, then a kill five seconds later. */
  readonly stop: () => void;
}

export type ExecutorProcessStart =
  | { readonly status: "started"; readonly process: ExecutorPlacedProcess }
  | { readonly status: "replied"; readonly reply: SshExecutorReply }
  | { readonly status: "lost" };

interface RunningProcess {
  readonly launch: number;
  readonly stream: ExecutorStream;
  readonly settle: (end: ExecutorProcessEnd) => void;
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
  readonly settle: (outcome: ExecutorRequestOutcome) => void;
}

interface LaunchEgress {
  readonly egress: ExecutorLaunchEgress;
  readonly forwarded: Set<ExecutorStream>;
}

export class ExecutorChannel {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader = new ExecutorFrameReader({ expectPreamble: true });
  readonly #waiting: Array<() => void> = [];
  readonly #endListeners = new Set<() => void>();
  readonly #introduction: Promise<ExecutorIntroduction>;
  /** Connections the executor forwarded from a running launch (odd ids). */
  readonly #forwarded: ExecutorStreams;
  /** Streams this host opened (even ids): connections it asked the target for, and placed processes. */
  readonly #hostOpened: ExecutorStreams;
  readonly #dialing = new Map<number, ExecutorStream>();
  readonly #dialed = new Set<ExecutorStream>();
  /** The egress of every proxied launch running now, by its request id. */
  readonly #launches = new Map<number, LaunchEgress>();
  readonly #processes = new Map<number, RunningProcess>();
  readonly #endedProcesses = new Set<number>();
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
    this.#hostOpened = new ExecutorStreams({
      send,
      opens: "even",
      maxStreams: MAX_STREAMS + SSH_EXECUTOR_MAX_PLACED_PROCESSES,
    });
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
  request(
    request: SshExecutorRequest,
    timeoutMs: number,
    options: ExecutorRequestOptions = {},
  ): Promise<ExecutorRequestOutcome> {
    return this.#queued(() => request, timeoutMs, options);
  }

  /**
   * Waits for the request slot, then builds the request and writes it with
   * nothing in between, so a stream id it takes is the newest the executor
   * has seen when the frame arrives. A build that yields nothing is answered
   * `busy` without a frame.
   */
  async #queued(
    build: () => SshExecutorRequest | undefined,
    timeoutMs: number,
    options: ExecutorRequestOptions & ExecutorRequestPlacement,
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
      const request = build();
      if (request === undefined) return { status: "replied", reply: { kind: "busy" } };
      return await this.#send(request, timeoutMs, options);
    } finally {
      this.#busy = false;
      this.#waiting.shift()?.();
    }
  }

  /**
   * The target's answers for a name, asked only while a proxied launch runs;
   * undefined when it did not resolve or no such launch runs.
   */
  resolve(host: SshEgressHostName): Promise<ReadonlyArray<string> | undefined> {
    if (this.#ended !== undefined || this.#launches.size === 0) {
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
   * could not. Undefined when no proxied launch runs or past the limit.
   */
  dial(address: SshEgressAddress, port: number): ExecutorStream | undefined {
    if (this.#ended !== undefined || this.#launches.size === 0) return undefined;
    if (this.#dialed.size >= MAX_STREAMS) return undefined;
    const stream = this.#hostOpened.open();
    if (stream === undefined) return undefined;
    this.#dialing.set(stream.id, stream);
    this.#dialed.add(stream);
    stream.once("close", () => {
      this.#dialing.delete(stream.id);
      this.#dialed.delete(stream);
    });
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

  /**
   * Places a process on the target as the session's one request, on a stream
   * this host opens for it. Its output may follow the reply at once, so the
   * stream exists before the request is written. A reply other than
   * `process-started` is handed back and the stream is dropped unused. A
   * proxied process's egress stays its own until the process ends.
   */
  async startProcess(
    request: Omit<SshExecutorStartProcessRequest, "stream">,
    egress: ExecutorLaunchEgress | undefined,
    timeoutMs: number,
  ): Promise<ExecutorProcessStart> {
    if (this.#ended !== undefined) return { status: "lost" };
    let settle: (end: ExecutorProcessEnd) => void = () => undefined;
    const ended = new Promise<ExecutorProcessEnd>((resolve) => {
      settle = resolve;
    });
    let opened: ExecutorStream | undefined;
    const outcome = await this.#queued(
      () => {
        // Taken as the request is written, after any connection a proxy
        // asked for while it waited, so its id is the newest the executor
        // has seen. Closed by its `process-ended`, never on its own, so a
        // close cannot reach the executor while the process is still exiting.
        opened = this.#hostOpened.open(false);
        return opened === undefined ? undefined : { ...request, stream: opened.id };
      },
      timeoutMs,
      {
        egress,
        keepEgress: (reply) => reply.kind === "process-started",
        sent: (id) => {
          if (opened !== undefined) {
            this.#processes.set(opened.id, { launch: id, stream: opened, settle });
          }
        },
      },
    );
    const stream = opened;
    if (stream === undefined) {
      return outcome.status === "replied"
        ? { status: "replied", reply: outcome.reply }
        : { status: "lost" };
    }
    if (
      outcome.status !== "replied" ||
      outcome.reply.kind !== "process-started" ||
      !this.#processes.has(stream.id)
    ) {
      this.#processes.delete(stream.id);
      stream.abandon();
      return outcome.status === "replied"
        ? { status: "replied", reply: outcome.reply }
        : { status: "lost" };
    }
    return {
      status: "started",
      process: {
        stream,
        ended,
        stop: () => {
          if (this.#processes.has(stream.id)) {
            this.#write({ type: "stop-process", stream: stream.id });
          }
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
    options: ExecutorRequestOptions & ExecutorRequestPlacement,
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
      if (options.egress !== undefined) {
        this.#launches.set(id, { egress: options.egress, forwarded: new Set() });
      }
      options.sent?.(id);
      this.#inFlight = {
        id,
        settle: (outcome) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
          this.#inFlight = undefined;
          // A command's egress ends with it: its streams close and no
          // question about it is answered any more. A placed process keeps
          // its egress until it ends.
          const keep = outcome.status === "replied" && options.keepEgress?.(outcome.reply) === true;
          if (options.egress !== undefined && !keep) this.#endLaunchEgress(id);
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
        const launch = this.#launches.get(frame.launch);
        if (launch === undefined) return "violated";
        const stream = this.#forwarded.adopt(frame.stream);
        if (stream === "violated") return "violated";
        if (stream !== "refused") {
          launch.forwarded.add(stream);
          stream.once("close", () => launch.forwarded.delete(stream));
          launch.egress.onStream(stream);
        }
        return "accepted";
      }
      case "process-ended":
        return this.#processEnded(frame);
      case "dialed": {
        const stream = this.#dialing.get(frame.stream);
        // A dial this host already gave up on can still be answered.
        if (stream === undefined)
          return this.#hostOpened.opened(frame.stream) ? "accepted" : "violated";
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
        // A placed process's stream is over once its end arrived.
        if (this.#endedProcesses.has(frame.stream)) return "violated";
        return (frame.stream % 2 === 1 ? this.#forwarded : this.#hostOpened).receive(frame);
    }
  }

  #processEnded(frame: SshExecutorProcessEndedFrame): "accepted" | "violated" {
    const running = this.#processes.get(frame.stream);
    if (running === undefined) return "violated";
    this.#processes.delete(frame.stream);
    this.#endedProcesses.add(frame.stream);
    this.#endLaunchEgress(running.launch);
    // Its output is complete: what the stream holds is still read, and it
    // closes once read, without a word to the executor, which forgot it.
    const { stream } = running;
    stream.receiveEnd();
    if (stream.readableEnded) stream.abandon();
    else stream.once("end", () => stream.abandon());
    running.settle({
      kind: "exited",
      exitCode: frame.exitCode,
      signal: frame.signal,
      stderr: Buffer.from(frame.stderr, "base64"),
    });
    return "accepted";
  }

  /**
   * Ends one launch's egress: the connections it forwarded close. Once no
   * proxied launch runs, the connections this host asked for close and no
   * question is answered any more.
   */
  #endLaunchEgress(launch: number): void {
    const entry = this.#launches.get(launch);
    this.#launches.delete(launch);
    if (entry !== undefined) {
      for (const stream of entry.forwarded) stream.destroy();
    }
    if (this.#launches.size > 0) return;
    for (const stream of this.#dialed) stream.destroy();
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
    this.#hostOpened.abandonAll();
    this.#dialing.clear();
    this.#launches.clear();
    // Every placed process died with the session.
    const processes = [...this.#processes.values()];
    this.#processes.clear();
    for (const running of processes) running.settle({ kind: "lost" });
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
