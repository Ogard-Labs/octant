import { describe, expect, it } from "vitest";
import type { SshExecutorAttestedReply } from "@octant/contracts/ssh-executor-protocol";
import { encodeExecutorFrame, ExecutorFrameReader } from "./executorFrames";
import { serveSshExecutor } from "./executorSession";

const identity = { buildVersion: "0.9.0", protocolVersion: 1, installVerified: true };
const reply: SshExecutorAttestedReply = {
  kind: "attested",
  facts: {
    identity,
    platform: { operatingSystem: "linux", architecture: "x64", uid: 1000 },
    backend: { kind: "none" },
    canaries: [],
  },
};

function frame(value: unknown): Uint8Array {
  const encoded = encodeExecutorFrame(value);
  if (encoded.status !== "encoded") throw new Error("frame did not encode");
  return encoded.bytes;
}

async function* chunks(...values: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

async function session(...input: ReadonlyArray<Uint8Array>) {
  const reader = new ExecutorFrameReader({ expectPreamble: true });
  const frames: unknown[] = [];
  let attested = 0;
  const end = await serveSshExecutor({
    input: chunks(...input),
    write: (bytes) => {
      const reading = reader.push(bytes);
      if (reading.status === "frames") frames.push(...reading.frames);
    },
    identity,
    answer: async () => {
      attested += 1;
      return reply;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { end, frames, attested };
}

describe("SSH executor session", () => {
  it("introduces itself, then answers an attestation request by its id", async () => {
    const result = await session(
      frame({ type: "request", id: 3, request: { kind: "attest", postures: [] } }),
    );
    expect(result.end).toBe("input-closed");
    expect(result.frames).toEqual([
      { type: "hello", identity },
      { type: "reply", id: 3, reply },
    ]);
  });

  it("acts on nothing that is not a host request and ends the session on it", async () => {
    for (const unreadable of [
      frame({ type: "hello", identity }),
      frame({ type: "request", id: 1, request: { kind: "run", argv: ["/bin/sh"] } }),
      Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
    ]) {
      const result = await session(
        unreadable,
        frame({ type: "request", id: 2, request: { kind: "attest", postures: [] } }),
      );
      expect(result.end).toBe("protocol-violated");
      expect(result.attested).toBe(0);
      expect(result.frames).toEqual([{ type: "hello", identity }]);
    }
  });
});
