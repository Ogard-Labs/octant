/**
 * The standard-stream channel to a host-local desktop.
 *
 * The desktop's only channel to the host is its launch's standard streams, so
 * everything it says arrives here as untrusted bytes. Each reply is one short
 * ASCII line (`ready W H`, `ok`, `error WORD`), except a frame, whose line
 * `frame N` is followed by exactly N bytes of PNG. Replies answer requests in
 * the order they were written. Anything else, an oversized line or frame, or
 * a reply nobody asked for, breaks the channel for good: a desynchronized
 * stream could make a frame answer a click.
 */

/** No reply line is longer than this, including its newline. */
const MAX_LINE_BYTES = 64;
/** The desktop's unsolicited `ready` line is the only reply that may wait unclaimed. */
const MAX_UNCLAIMED_REPLIES = 1;

export type DesktopReply =
  | { readonly kind: "line"; readonly words: ReadonlyArray<string> }
  | { readonly kind: "frame"; readonly bytes: Uint8Array }
  | { readonly kind: "broken" };

type Waiter = (reply: DesktopReply) => void;

const BROKEN: DesktopReply = { kind: "broken" };
const NEWLINE = 0x0a;

export class DesktopStreamChannel {
  readonly #write: (bytes: Uint8Array) => Promise<{ readonly status: "written" | "closed" }>;
  readonly #maxFrameBytes: number;
  readonly #waiters: Array<Waiter> = [];
  readonly #unclaimed: Array<DesktopReply> = [];
  #line: Uint8Array = new Uint8Array(0);
  #frame: { readonly bytes: Uint8Array; filled: number } | undefined;
  #broken = false;

  constructor(options: {
    readonly write: (bytes: Uint8Array) => Promise<{ readonly status: "written" | "closed" }>;
    readonly maxFrameBytes: number;
  }) {
    this.#write = options.write;
    this.#maxFrameBytes = options.maxFrameBytes;
  }

  get broken(): boolean {
    return this.#broken;
  }

  /** Bytes the desktop wrote to its standard output. */
  receive(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length && !this.#broken) {
      const frame = this.#frame;
      if (frame !== undefined) {
        const take = Math.min(chunk.length - offset, frame.bytes.length - frame.filled);
        frame.bytes.set(chunk.subarray(offset, offset + take), frame.filled);
        frame.filled += take;
        offset += take;
        if (frame.filled === frame.bytes.length) {
          this.#frame = undefined;
          this.#deliver({ kind: "frame", bytes: frame.bytes });
        }
        continue;
      }
      const end = chunk.indexOf(NEWLINE, offset);
      this.#line = concat(this.#line, chunk.subarray(offset, end < 0 ? chunk.length : end));
      if (this.#line.length >= MAX_LINE_BYTES) {
        this.close();
        return;
      }
      if (end < 0) return;
      offset = end + 1;
      const line = this.#line;
      this.#line = new Uint8Array(0);
      this.#answer(line);
    }
  }

  /** The next reply, without sending anything first: the desktop's `ready` line. */
  next(timeoutMs: number): Promise<DesktopReply> {
    return this.#await(timeoutMs, () => undefined);
  }

  /** Writes one request line and waits for its reply. */
  request(line: string, timeoutMs: number): Promise<DesktopReply> {
    return this.#await(timeoutMs, () => {
      void this.#write(new TextEncoder().encode(`${line}\n`)).then((written) => {
        if (written.status === "closed") this.close();
      });
    });
  }

  /** The desktop exited or misbehaved; every waiting and later request answers `broken`. */
  close(): void {
    if (this.#broken) return;
    this.#broken = true;
    this.#line = new Uint8Array(0);
    this.#frame = undefined;
    this.#unclaimed.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter(BROKEN);
  }

  #answer(line: Uint8Array): void {
    if (!line.every((byte) => byte >= 0x20 && byte < 0x7f)) {
      this.close();
      return;
    }
    const words = String.fromCharCode(...line)
      .split(" ")
      .filter((word) => word.length > 0);
    if (words[0] !== "frame") {
      this.#deliver({ kind: "line", words });
      return;
    }
    const size = words.length === 2 && /^[0-9]{1,9}$/.test(words[1] ?? "") ? Number(words[1]) : 0;
    if (size < 1 || size > this.#maxFrameBytes) {
      this.close();
      return;
    }
    this.#frame = { bytes: new Uint8Array(size), filled: 0 };
  }

  #await(timeoutMs: number, send: () => void): Promise<DesktopReply> {
    if (this.#broken) return Promise.resolve(BROKEN);
    const unclaimed = this.#unclaimed.shift();
    if (unclaimed !== undefined) {
      send();
      return Promise.resolve(unclaimed);
    }
    return new Promise<DesktopReply>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = (reply) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(reply);
      };
      timer = setTimeout(() => {
        // A late reply would answer the next request instead, so a timeout
        // ends the channel rather than skipping one reply.
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve(BROKEN);
        this.close();
      }, timeoutMs);
      this.#waiters.push(waiter);
      send();
    });
  }

  #deliver(reply: DesktopReply): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter(reply);
      return;
    }
    if (this.#unclaimed.length >= MAX_UNCLAIMED_REPLIES) {
      this.close();
      return;
    }
    this.#unclaimed.push(reply);
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}
