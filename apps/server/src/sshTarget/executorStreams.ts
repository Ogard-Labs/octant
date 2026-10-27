import { Duplex } from "node:stream";
import {
  SSH_EXECUTOR_MAX_STREAM_CHUNK_BYTES,
  SSH_EXECUTOR_STREAM_WINDOW_BYTES,
  type SshExecutorStreamFrame,
} from "@octant/contracts/ssh-executor-protocol";

/**
 * The byte streams one executor session carries for a proxied command: each
 * connection the confined command makes to its forwarder (opened by the
 * executor), and each connection this host's egress proxy asks the target to
 * make (opened by the host). Canonical: docs/design/remote-ssh-environments.md
 * § Native harness on a target.
 *
 * Both ends run this same code. Every stream has its own window: a side sends
 * at most {@link SSH_EXECUTOR_STREAM_WINDOW_BYTES} the other has not taken off
 * the stream yet, so a connection whose reader stalls holds a bounded amount
 * and never starves the others, or the requests, that share the session. A
 * peer that sends past the window, or names a stream that never existed,
 * broke the protocol, and the session ends.
 */

/** Credit is granted back in batches this large, or whenever the reader drains. */
const CREDIT_BATCH_BYTES = 65_536;

export type ExecutorStreamReceipt = "accepted" | "violated";

interface StreamLink {
  readonly send: (frame: SshExecutorStreamFrame) => void;
  readonly forget: (id: number) => void;
}

/**
 * One stream as a Node duplex: what is written to it goes to the other side,
 * and what the other side sends is read from it. Ending it half-closes the
 * stream; destroying it closes both directions on both sides.
 */
export class ExecutorStream extends Duplex {
  readonly id: number;
  readonly #link: StreamLink;
  #sendWindow = SSH_EXECUTOR_STREAM_WINDOW_BYTES;
  #unacknowledged = 0;
  #backpressured = false;
  #pending: { chunk: Buffer; readonly callback: (error?: Error | null) => void } | undefined;
  #peerEnded = false;
  #peerClosed = false;
  #silent = false;

  /**
   * `autoDestroy` false keeps a stream whose both directions ended until its
   * owner closes it, for a stream whose end is said by another frame.
   */
  constructor(id: number, link: StreamLink, autoDestroy = true) {
    super({ allowHalfOpen: true, autoDestroy });
    this.id = id;
    this.#link = link;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#pending = { chunk, callback };
    this.#flush();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.#peerClosed && !this.#silent) {
      this.#link.send({ type: "stream-end", stream: this.id });
    }
    callback();
  }

  override _read(): void {
    this.#backpressured = false;
    this.#grant(true);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.#peerClosed && !this.#silent) {
      this.#link.send({ type: "stream-close", stream: this.id });
    }
    this.#link.forget(this.id);
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.callback(error ?? new Error("The stream closed before its bytes were sent."));
    callback(error);
  }

  /** Destroys the stream without telling the other side, whose session is gone. */
  abandon(): void {
    this.#silent = true;
    this.destroy();
  }

  /** Bytes the other side sent; false when they exceed the window it was granted. */
  receiveData(bytes: Buffer): boolean {
    if (this.#peerEnded) return false;
    if (this.#unacknowledged + bytes.byteLength > SSH_EXECUTOR_STREAM_WINDOW_BYTES) return false;
    if (this.destroyed) return true;
    this.#unacknowledged += bytes.byteLength;
    this.#backpressured = !this.push(bytes);
    this.#grant(false);
    return true;
  }

  receiveEnd(): void {
    if (this.#peerEnded) return;
    this.#peerEnded = true;
    this.push(null);
  }

  receiveClose(): void {
    this.#peerClosed = true;
    this.destroy();
  }

  /** More room the other side granted; false when it would exceed the window. */
  receiveCredit(bytes: number): boolean {
    if (this.#sendWindow + bytes > SSH_EXECUTOR_STREAM_WINDOW_BYTES) return false;
    this.#sendWindow += bytes;
    this.#flush();
    return true;
  }

  #flush(): void {
    const pending = this.#pending;
    if (pending === undefined || this.destroyed) return;
    while (pending.chunk.byteLength > 0 && this.#sendWindow > 0) {
      const size = Math.min(
        pending.chunk.byteLength,
        SSH_EXECUTOR_MAX_STREAM_CHUNK_BYTES,
        this.#sendWindow,
      );
      this.#link.send({
        type: "stream-data",
        stream: this.id,
        data: pending.chunk.subarray(0, size).toString("base64"),
      });
      this.#sendWindow -= size;
      pending.chunk = pending.chunk.subarray(size);
    }
    if (pending.chunk.byteLength > 0) return;
    this.#pending = undefined;
    pending.callback();
  }

  /**
   * Gives the other side back the room its bytes took, once the reader has
   * them: a batch at a time while it keeps up, everything when it drains.
   */
  #grant(drained: boolean): void {
    if (this.#backpressured || this.#unacknowledged === 0 || this.destroyed) return;
    if (!drained && this.#unacknowledged < CREDIT_BATCH_BYTES) return;
    const bytes = this.#unacknowledged;
    this.#unacknowledged = 0;
    this.#link.send({ type: "stream-credit", stream: this.id, bytes });
  }
}

export interface ExecutorStreamsOptions {
  /** Writes one frame to the other side. */
  readonly send: (frame: SshExecutorStreamFrame) => void;
  /** The ids this side opens: odd on the executor, even on this host. */
  readonly opens: "odd" | "even";
  /** The most streams open at once; past it a new one is refused. */
  readonly maxStreams: number;
}

export class ExecutorStreams {
  readonly #send: (frame: SshExecutorStreamFrame) => void;
  readonly #localParity: 0 | 1;
  readonly #maxStreams: number;
  readonly #streams = new Map<number, ExecutorStream>();
  #nextLocal: number;
  #highestRemote = 0;

  constructor(options: ExecutorStreamsOptions) {
    this.#send = options.send;
    this.#localParity = options.opens === "odd" ? 1 : 0;
    this.#nextLocal = options.opens === "odd" ? 1 : 2;
    this.#maxStreams = options.maxStreams;
  }

  /** Whether a stream with this id was ever opened here or adopted, open or closed now. */
  opened(id: number): boolean {
    return this.#known(id);
  }

  /** A new stream this side opens, or undefined past the limit. */
  open(autoDestroy = true): ExecutorStream | undefined {
    if (this.#streams.size >= this.#maxStreams) return undefined;
    const id = this.#nextLocal;
    this.#nextLocal += 2;
    return this.#track(id, autoDestroy);
  }

  /**
   * The stream the other side just opened. Its id must be of the other side's
   * parity and newer than any it opened before; a reused id is a violation.
   * Past the limit the stream is refused, and the caller closes it. A stream
   * adopted without `autoDestroy` stays until its owner closes it.
   */
  adopt(id: number, autoDestroy = true): ExecutorStream | "violated" | "refused" {
    if (id % 2 === this.#localParity || id <= this.#highestRemote) return "violated";
    this.#highestRemote = id;
    if (this.#streams.size >= this.#maxStreams) {
      this.#send({ type: "stream-close", stream: id });
      return "refused";
    }
    return this.#track(id, autoDestroy);
  }

  receive(frame: SshExecutorStreamFrame): ExecutorStreamReceipt {
    const stream = this.#streams.get(frame.stream);
    if (stream === undefined) {
      // A stream either side already closed can still have frames in flight.
      return this.#known(frame.stream) ? "accepted" : "violated";
    }
    switch (frame.type) {
      case "stream-data": {
        const bytes = Buffer.from(frame.data, "base64");
        return bytes.byteLength > 0 && stream.receiveData(bytes) ? "accepted" : "violated";
      }
      case "stream-end":
        stream.receiveEnd();
        return "accepted";
      case "stream-close":
        stream.receiveClose();
        return "accepted";
      case "stream-credit":
        return stream.receiveCredit(frame.bytes) ? "accepted" : "violated";
    }
  }

  /** Closes every stream, telling the other side; used when a command ends. */
  closeAll(): void {
    for (const stream of this.#streams.values()) stream.destroy();
  }

  /** Drops every stream without a word; used when the session itself is gone. */
  abandonAll(): void {
    for (const stream of this.#streams.values()) stream.abandon();
  }

  #track(id: number, autoDestroy = true): ExecutorStream {
    const stream = new ExecutorStream(
      id,
      {
        send: (frame) => this.#send(frame),
        forget: (closed) => {
          if (this.#streams.get(closed) === stream) this.#streams.delete(closed);
        },
      },
      autoDestroy,
    );
    // A stream's own failure closes it; it never escapes as an unhandled error.
    stream.on("error", () => stream.destroy());
    this.#streams.set(id, stream);
    return stream;
  }

  #known(id: number): boolean {
    return id % 2 === this.#localParity ? id < this.#nextLocal : id <= this.#highestRemote;
  }
}

/**
 * Joins a local socket and a stream: bytes flow both ways with backpressure,
 * an end on one side ends the other, and a failure on either closes both.
 */
export function joinToStream(socket: Duplex, stream: ExecutorStream): void {
  socket.pipe(stream);
  stream.pipe(socket);
  const close = () => {
    socket.destroy();
    stream.destroy();
  };
  socket.once("error", close);
  stream.once("error", close);
  socket.once("close", () => finishThenClose(stream));
  stream.once("close", () => finishThenClose(socket));
}

/** Lets a side deliver what it already holds before it closes, then closes it. */
function finishThenClose(side: Duplex): void {
  if (side.destroyed) return;
  if (side.writableFinished) {
    side.destroy();
    return;
  }
  side.once("finish", () => side.destroy());
  side.end();
}
