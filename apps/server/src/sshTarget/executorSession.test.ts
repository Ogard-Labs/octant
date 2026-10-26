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
    handlers: () => ({
      answer: async () => {
        attested += 1;
        return reply;
      },
      receive: () => "violated",
      end: () => undefined,
    }),
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

  it("stops the request in flight on the host's cancel, and stops everything when the host is gone", async () => {
    const command = {
      kind: "run-command",
      root: "/home/build/app",
      command: "sleep 60",
      posture: "approval-gated",
      network: "none",
      timeoutMs: 60_000,
    };
    let cancelled = false;
    let ended = false;
    const sent: unknown[] = [];
    const reader = new ExecutorFrameReader({ expectPreamble: true });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* input(): AsyncIterable<Uint8Array> {
      yield frame({ type: "request", id: 5, request: command });
      yield frame({ type: "cancel", id: 4 });
      yield frame({ type: "cancel", id: 5 });
      yield frame({ type: "stream-credit", stream: 2, bytes: 10 });
      await held;
    }
    const served = serveSshExecutor({
      input: input(),
      write: (bytes) => {
        const reading = reader.push(bytes);
        if (reading.status === "frames") sent.push(...reading.frames);
      },
      identity,
      handlers: () => ({
        answer: (_request, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              cancelled = true;
              resolve({ kind: "command-ran", termination: "cancelled", stdout: "", stderr: "" });
            });
          }),
        receive: (received) => (received.type === "stream-credit" ? "accepted" : "violated"),
        end: () => {
          ended = true;
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
    expect(sent).toContainEqual({
      type: "reply",
      id: 5,
      reply: { kind: "command-ran", termination: "cancelled", stdout: "", stderr: "" },
    });
    release();
    expect(await served).toBe("input-closed");
    expect(ended).toBe(true);
  });

  it("ends the session on an egress frame its handler refuses", async () => {
    let ended = false;
    const result = await serveSshExecutor({
      input: chunks(frame({ type: "dial", stream: 2, address: "10.0.0.1", port: 22 })),
      write: () => undefined,
      identity,
      handlers: () => ({
        answer: async () => reply,
        receive: () => "violated",
        end: () => {
          ended = true;
        },
      }),
    });
    expect(result).toBe("protocol-violated");
    expect(ended).toBe(true);
  });
});
