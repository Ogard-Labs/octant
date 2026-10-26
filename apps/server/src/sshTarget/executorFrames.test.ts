import { describe, expect, it } from "vitest";
import {
  SSH_EXECUTOR_MAX_FRAME_BYTES,
  SSH_EXECUTOR_PREAMBLE_SEARCH_BYTES,
} from "@octant/contracts/ssh-executor-protocol";
import { encodeExecutorFrame, ExecutorFrameReader, executorPreamble } from "./executorFrames";

function frame(value: unknown): Uint8Array {
  const encoded = encodeExecutorFrame(value);
  if (encoded.status !== "encoded") throw new Error("frame did not encode");
  return encoded.bytes;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function joined(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

describe("SSH executor frames", () => {
  it("reads frames however the session splits them, after discarding the login shell's own output", () => {
    const stream = joined(
      bytes("Welcome to devbox\nlast login: yesterday\n"),
      executorPreamble(),
      frame({ type: "hello" }),
      frame({ type: "reply", id: 1 }),
    );
    const reader = new ExecutorFrameReader({ expectPreamble: true });
    const frames: unknown[] = [];
    for (let offset = 0; offset < stream.byteLength; offset += 3) {
      const reading = reader.push(stream.subarray(offset, offset + 3));
      expect(reading.status).toBe("frames");
      if (reading.status === "frames") frames.push(...reading.frames);
    }
    expect(frames).toEqual([{ type: "hello" }, { type: "reply", id: 1 }]);
  });

  it("ends the session for good on a frame longer than the protocol allows", () => {
    const reader = new ExecutorFrameReader({ expectPreamble: false });
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, SSH_EXECUTOR_MAX_FRAME_BYTES + 1, false);
    expect(reader.push(length)).toEqual({ status: "violated", violation: "frame-too-large" });
    expect(reader.push(frame({ type: "hello" }))).toEqual({
      status: "violated",
      violation: "frame-too-large",
    });
    expect(encodeExecutorFrame("x".repeat(SSH_EXECUTOR_MAX_FRAME_BYTES)).status).toBe("too-large");
  });

  it("refuses a frame that is not JSON and a stream that never introduces an executor", () => {
    const body = bytes("not json");
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, body.byteLength, false);
    expect(new ExecutorFrameReader({ expectPreamble: false }).push(joined(length, body))).toEqual({
      status: "violated",
      violation: "frame-not-json",
    });

    const reader = new ExecutorFrameReader({ expectPreamble: true });
    const noise = bytes("x".repeat(SSH_EXECUTOR_PREAMBLE_SEARCH_BYTES + 64));
    expect(reader.push(noise)).toEqual({ status: "violated", violation: "preamble-missing" });
    expect(reader.push(joined(executorPreamble(), frame({ type: "hello" }))).status).toBe(
      "violated",
    );
  });
});
