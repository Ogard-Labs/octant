/**
 * Incremental `Content-Length` frame reader shared by the language-server
 * and debug-adapter stdio connections. Each push scans only the bytes it
 * carries: a header is read one byte at a time into a scratch slot reused
 * across frames, and a body that spans chunks is held as buffer
 * views, joined exactly once when it completes — or, past the fragment
 * queue's bound, written straight into a single sink allocated early. No
 * inbound byte is ever copied through `Buffer.concat`, so dribbled input
 * costs linear work instead of quadratic re-buffering.
 *
 * Anything outside the shape ends the decoder once and is reported through
 * `onViolation`; the connection owns what a violation does to the session.
 */

/** Headers are a line or two; anything longer is not a frame. */
const MAX_HEADER_BYTES = 8 * 1024;
/** A partial body keeps at most this many queued views before they are flattened once. */
const MAX_BODY_FRAGMENTS = 64;
const CR = 0x0d;
const LF = 0x0a;

/** A `Content-Length` frame header, which LSP and DAP share. */
export function frameHeader(length: number): Buffer {
  return Buffer.from(`Content-Length: ${length}\r\n\r\n`, "ascii");
}

/** The one `Content-Length` a frame header declares; undefined when it is not a frame header. */
export function contentLength(header: string): number | undefined {
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

export type ContentLengthFrameViolation = "oversize-frame" | "malformed-frame";

export class ContentLengthFrames {
  readonly #maxBodyBytes: number;
  readonly #onBody: (body: Buffer) => void;
  readonly #onViolation: (violation: ContentLengthFrameViolation) => void;
  /**
   * The partial header, lazily allocated: MAX_HEADER_BYTES of content plus
   * the four delimiter bytes that may legally end it.
   */
  #header: Buffer | undefined;
  #headerUsed = 0;
  /** Bytes the pending body must still receive; -1 while a header is read. */
  #bodyLength = -1;
  #bodyReceived = 0;
  /**
   * Body slices kept as views into their input chunks until the frame
   * completes. A hostile sender could otherwise grow retained JS references
   * one byte at a time, so the queue is bounded; past it the declared body
   * buffer is allocated early and every later byte lands in it directly.
   */
  #fragments: Buffer[] = [];
  #sink: Buffer | undefined;
  #ended = false;

  constructor(
    maxBodyBytes: number,
    onBody: (body: Buffer) => void,
    onViolation: (violation: ContentLengthFrameViolation) => void,
  ) {
    this.#maxBodyBytes = maxBodyBytes;
    this.#onBody = onBody;
    this.#onViolation = onViolation;
  }

  push(chunk: Buffer): void {
    if (this.#ended) return;
    let cursor = 0;
    while (cursor < chunk.byteLength) {
      if (this.#bodyLength < 0) {
        const header = (this.#header ??= Buffer.alloc(MAX_HEADER_BYTES + 4));
        // The delimiter may straddle pushes, so the check is the last four
        // accumulated bytes after every byte, never a scan of the whole
        // scratch. Copying stops at the delimiter, so body bytes that share
        // this chunk are left for the body path.
        let ended = false;
        while (cursor < chunk.byteLength) {
          header[this.#headerUsed] = chunk.readUInt8(cursor);
          this.#headerUsed += 1;
          cursor += 1;
          if (
            this.#headerUsed >= 4 &&
            header[this.#headerUsed - 4] === CR &&
            header[this.#headerUsed - 3] === LF &&
            header[this.#headerUsed - 2] === CR &&
            header[this.#headerUsed - 1] === LF
          ) {
            ended = true;
            break;
          }
          if (this.#headerUsed === header.byteLength) {
            this.#violate("malformed-frame");
            return;
          }
        }
        if (!ended) return;
        const length = contentLength(header.toString("ascii", 0, this.#headerUsed - 4));
        this.#headerUsed = 0;
        if (length === undefined) {
          this.#violate("malformed-frame");
          return;
        }
        // Judged on the declared length, before the body arrives, so a peer
        // cannot make the host buffer past the cap by sending slowly.
        if (length > this.#maxBodyBytes) {
          this.#violate("oversize-frame");
          return;
        }
        this.#bodyLength = length;
        if (length === 0 && !this.#emit(Buffer.alloc(0))) return;
        continue;
      }
      const take = Math.min(this.#bodyLength - this.#bodyReceived, chunk.byteLength - cursor);
      const part = chunk.subarray(cursor, cursor + take);
      cursor += take;
      const before = this.#bodyReceived;
      this.#bodyReceived += take;
      if (this.#bodyReceived < this.#bodyLength) {
        if (this.#sink === undefined && this.#fragments.length >= MAX_BODY_FRAGMENTS) {
          const sink = Buffer.alloc(this.#bodyLength);
          let offset = 0;
          for (const fragment of this.#fragments) {
            fragment.copy(sink, offset);
            offset += fragment.byteLength;
          }
          this.#fragments.length = 0;
          this.#sink = sink;
        }
        if (this.#sink !== undefined) part.copy(this.#sink, before);
        else this.#fragments.push(part);
        return;
      }
      let body: Buffer;
      if (this.#sink !== undefined) {
        part.copy(this.#sink, before);
        body = this.#sink;
      } else if (this.#fragments.length === 0) {
        // The whole body sat in this chunk: hand the view over uncopied.
        body = part;
      } else {
        body = Buffer.alloc(this.#bodyLength);
        let offset = 0;
        for (const fragment of this.#fragments) {
          fragment.copy(body, offset);
          offset += fragment.byteLength;
        }
        part.copy(body, before);
      }
      if (!this.#emit(body)) return;
    }
  }

  /** Drops every queued byte; pushes after it are ignored. */
  close(): void {
    this.#ended = true;
    this.#release();
  }

  /** Releases the frame's bytes, then hands the body over; false when the callback closed the decoder. */
  #emit(body: Buffer): boolean {
    this.#bodyLength = -1;
    this.#bodyReceived = 0;
    this.#fragments = [];
    this.#sink = undefined;
    this.#onBody(body);
    return !this.#ended;
  }

  #violate(violation: ContentLengthFrameViolation): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#release();
    this.#onViolation(violation);
  }

  #release(): void {
    this.#header = undefined;
    this.#headerUsed = 0;
    this.#bodyLength = -1;
    this.#bodyReceived = 0;
    this.#fragments = [];
    this.#sink = undefined;
  }
}
