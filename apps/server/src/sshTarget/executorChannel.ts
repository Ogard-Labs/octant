import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Schema } from "effect";
import {
  SshExecutorFrame,
  type SshExecutorHello,
  type SshExecutorReply,
  type SshExecutorRequest,
} from "@octant/contracts/ssh-executor-protocol";
import { encodeExecutorFrame, ExecutorFrameReader } from "./executorFrames";

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
 */

const MAX_STDERR_BYTES = 16_384;
const MAX_WAITING_REQUESTS = 16;

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

interface InFlight {
  readonly id: number;
  readonly settle: (outcome: ExecutorRequestOutcome) => void;
}

export class ExecutorChannel {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader = new ExecutorFrameReader({ expectPreamble: true });
  readonly #waiting: Array<() => void> = [];
  readonly #endListeners: Array<() => void> = [];
  readonly #introduction: Promise<ExecutorIntroduction>;
  #introduce: (outcome: ExecutorIntroduction) => void = () => undefined;
  #introduced = false;
  #inFlight: InFlight | undefined;
  #busy = false;
  #nextId = 1;
  #ended: "violated" | "ended" | "timed-out" | undefined;
  #stderr = "";

  constructor(child: ChildProcessWithoutNullStreams, options: { readonly helloTimeoutMs: number }) {
    this.#child = child;
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

  /** Called once when the session ends, for whatever reason. */
  onEnd(listener: () => void): void {
    if (this.#ended !== undefined) listener();
    else this.#endListeners.push(listener);
  }

  /** Writes one request after the last one was answered, and waits for its reply. */
  async request(request: SshExecutorRequest, timeoutMs: number): Promise<ExecutorRequestOutcome> {
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
      return await this.#send(request, timeoutMs);
    } finally {
      this.#busy = false;
      this.#waiting.shift()?.();
    }
  }

  /** Ends the session; the executor exits when its input closes. */
  close(): void {
    this.#end("ended");
  }

  #send(request: SshExecutorRequest, timeoutMs: number): Promise<ExecutorRequestOutcome> {
    return new Promise((resolve) => {
      const id = this.#nextId;
      this.#nextId += 1;
      const encoded = encodeExecutorFrame({ type: "request", id, request });
      if (encoded.status !== "encoded") {
        resolve({ status: "lost", cause: "violated" });
        return;
      }
      const timer = setTimeout(() => this.#end("timed-out"), timeoutMs);
      this.#inFlight = {
        id,
        settle: (outcome) => {
          clearTimeout(timer);
          this.#inFlight = undefined;
          resolve(outcome);
        },
      };
      this.#child.stdin.write(encoded.bytes);
    });
  }

  #onData(chunk: Buffer): void {
    if (this.#ended !== undefined) return;
    const reading = this.#reader.push(chunk);
    if (reading.status === "violated") {
      this.#end("violated");
      return;
    }
    for (const value of reading.frames) {
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
      const inFlight = this.#inFlight;
      if (frame.type !== "reply" || inFlight === undefined || frame.id !== inFlight.id) {
        this.#end("violated");
        return;
      }
      inFlight.settle({ status: "replied", reply: frame.reply });
    }
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
    this.#inFlight?.settle({ status: "lost", cause });
    for (const release of this.#waiting.splice(0)) release();
    for (const listener of this.#endListeners.splice(0)) listener();
  }
}
