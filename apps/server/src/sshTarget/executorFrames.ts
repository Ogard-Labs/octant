import {
  SSH_EXECUTOR_MAX_FRAME_BYTES,
  SSH_EXECUTOR_PREAMBLE,
  SSH_EXECUTOR_PREAMBLE_SEARCH_BYTES,
} from "@octant/contracts/ssh-executor-protocol";

/**
 * Length-prefixed JSON frames for the SSH executor session: a four-byte
 * big-endian length, then that many bytes of UTF-8 JSON. Canonical:
 * docs/design/remote-ssh-environments.md § Transport.
 *
 * This layer only cuts bytes into JSON values. Each side decodes every value
 * against its schema before acting on it, so nothing here trusts a frame.
 */

const LENGTH_BYTES = 4;
const PREAMBLE = new TextEncoder().encode(SSH_EXECUTOR_PREAMBLE);

export type ExecutorFrameEncoding =
  | { readonly status: "encoded"; readonly bytes: Uint8Array }
  | { readonly status: "too-large" };

export function encodeExecutorFrame(value: unknown): ExecutorFrameEncoding {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > SSH_EXECUTOR_MAX_FRAME_BYTES) return { status: "too-large" };
  const bytes = new Uint8Array(LENGTH_BYTES + body.byteLength);
  new DataView(bytes.buffer).setUint32(0, body.byteLength, false);
  bytes.set(body, LENGTH_BYTES);
  return { status: "encoded", bytes };
}

/** The bytes an executor writes before its first frame. */
export function executorPreamble(): Uint8Array {
  return PREAMBLE.slice();
}

export type ExecutorFrameViolation = "preamble-missing" | "frame-too-large" | "frame-not-json";

export type ExecutorFrameReading =
  | { readonly status: "frames"; readonly frames: ReadonlyArray<unknown> }
  | { readonly status: "violated"; readonly violation: ExecutorFrameViolation };

/**
 * Cuts a byte stream into frames. Once it reports a violation it stays
 * violated, because a stream that lost its framing cannot be resynchronized
 * safely: every later length would be read from the middle of a value.
 *
 * A reader that expects the preamble discards what precedes it unread, up to
 * the search bound. That text is the target login shell's own output from
 * before the executor started, never the executor's.
 */
export class ExecutorFrameReader {
  #buffer: Uint8Array = new Uint8Array(0);
  #awaitingPreamble: boolean;
  #discarded = 0;
  #violation: ExecutorFrameViolation | undefined;

  constructor(options: { readonly expectPreamble: boolean }) {
    this.#awaitingPreamble = options.expectPreamble;
  }

  push(chunk: Uint8Array): ExecutorFrameReading {
    if (this.#violation !== undefined) return { status: "violated", violation: this.#violation };
    this.#buffer = concat(this.#buffer, chunk);
    if (this.#awaitingPreamble && !this.#consumePreamble()) {
      return this.#violation === undefined
        ? { status: "frames", frames: [] }
        : { status: "violated", violation: this.#violation };
    }
    const frames: unknown[] = [];
    while (this.#buffer.byteLength >= LENGTH_BYTES) {
      const length = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        LENGTH_BYTES,
      ).getUint32(0, false);
      if (length > SSH_EXECUTOR_MAX_FRAME_BYTES) return this.#violate("frame-too-large");
      if (this.#buffer.byteLength < LENGTH_BYTES + length) break;
      const body = this.#buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
      this.#buffer = this.#buffer.slice(LENGTH_BYTES + length);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        return this.#violate("frame-not-json");
      }
      frames.push(value);
    }
    return { status: "frames", frames };
  }

  /** True once the preamble has been found and removed from the buffer. */
  #consumePreamble(): boolean {
    const index = indexOf(this.#buffer, PREAMBLE);
    if (index === -1) {
      // Keep only what could still be the start of the preamble.
      const keep = Math.min(this.#buffer.byteLength, PREAMBLE.byteLength - 1);
      this.#discarded += this.#buffer.byteLength - keep;
      this.#buffer = this.#buffer.slice(this.#buffer.byteLength - keep);
      if (this.#discarded > SSH_EXECUTOR_PREAMBLE_SEARCH_BYTES) this.#violate("preamble-missing");
      return false;
    }
    this.#discarded += index;
    if (this.#discarded > SSH_EXECUTOR_PREAMBLE_SEARCH_BYTES) {
      this.#violate("preamble-missing");
      return false;
    }
    this.#buffer = this.#buffer.slice(index + PREAMBLE.byteLength);
    this.#awaitingPreamble = false;
    return true;
  }

  #violate(violation: ExecutorFrameViolation): ExecutorFrameReading {
    this.#violation = violation;
    this.#buffer = new Uint8Array(0);
    return { status: "violated", violation };
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let start = 0; start + needle.byteLength <= haystack.byteLength; start += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}
