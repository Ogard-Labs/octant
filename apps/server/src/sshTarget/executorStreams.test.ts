import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  SSH_EXECUTOR_STREAM_WINDOW_BYTES,
  type SshExecutorStreamFrame,
} from "@octant/contracts/ssh-executor-protocol";
import { ExecutorStreams, joinToStream } from "./executorStreams";

/**
 * Two ends of a session's streams, wired frame to frame as the SSH session
 * would carry them, with every frame the executor end sent kept for checks.
 */
function pair(options: { readonly deliver?: boolean } = {}) {
  const sent: SshExecutorStreamFrame[] = [];
  const violations: string[] = [];
  let host: ExecutorStreams | undefined;
  const executor = new ExecutorStreams({
    send: (frame) => {
      sent.push(frame);
      if (options.deliver === false) return;
      // Frames cross the session asynchronously, as they do over SSH.
      queueMicrotask(() => {
        if (host?.receive(frame) === "violated") violations.push(`host:${frame.type}`);
      });
    },
    opens: "odd",
    maxStreams: 4,
  });
  host = new ExecutorStreams({
    send: (frame) =>
      queueMicrotask(() => {
        if (executor.receive(frame) === "violated") violations.push(`executor:${frame.type}`);
      }),
    opens: "even",
    maxStreams: 4,
  });
  return { executor, host, sent, violations };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("executor session streams", () => {
  it("carries bytes both ways and ends each direction on its own", async () => {
    const { executor, host, violations } = pair();
    const local = executor.open();
    if (local === undefined) throw new Error("no stream");
    const remote = host.adopt(local.id);
    if (typeof remote === "string") throw new Error(`adopt ${remote}`);
    const received: Buffer[] = [];
    remote.on("data", (chunk: Buffer) => received.push(chunk));
    local.write("GET / HTTP/1.1\r\n\r\n");
    local.end();
    await settle();
    expect(Buffer.concat(received).toString()).toBe("GET / HTTP/1.1\r\n\r\n");
    // The executor finished sending, and still reads the answer.
    const answered: Buffer[] = [];
    local.on("data", (chunk: Buffer) => answered.push(chunk));
    remote.end("HTTP/1.1 200 OK\r\n\r\n");
    await settle();
    expect(Buffer.concat(answered).toString()).toBe("HTTP/1.1 200 OK\r\n\r\n");
    expect(violations).toEqual([]);
  });

  it("never sends more than the window a stalled reader granted", async () => {
    const { executor, host, sent } = pair();
    const local = executor.open();
    if (local === undefined) throw new Error("no stream");
    const remote = host.adopt(local.id);
    if (typeof remote === "string") throw new Error(`adopt ${remote}`);
    // Nothing reads `remote`, so after its buffer fills it grants no more.
    remote.pause();
    const large = Buffer.alloc(4 * SSH_EXECUTOR_STREAM_WINDOW_BYTES, 1);
    local.write(large);
    await settle();
    const dataBytes = () =>
      sent
        .filter((frame) => frame.type === "stream-data")
        .reduce((total, frame) => total + Buffer.from(frame.data, "base64").byteLength, 0);
    const stalled = dataBytes();
    expect(stalled).toBeLessThan(large.byteLength);
    expect(stalled).toBeLessThanOrEqual(
      SSH_EXECUTOR_STREAM_WINDOW_BYTES + remote.readableHighWaterMark + 65_536,
    );
    // Reading drains it, the reader grants room again, and the rest arrives.
    let read = 0;
    remote.on("data", (chunk: Buffer) => {
      read += chunk.byteLength;
    });
    remote.resume();
    for (let attempt = 0; attempt < 100 && read < large.byteLength; attempt += 1) await settle();
    expect(read).toBe(large.byteLength);
  });

  it("ends the session on a peer that sends past its window or names a stream that never was", () => {
    const streams = new ExecutorStreams({ send: () => undefined, opens: "even", maxStreams: 4 });
    const adopted = streams.adopt(1);
    if (typeof adopted === "string") throw new Error(`adopt ${adopted}`);
    adopted.pause();
    const chunk = Buffer.alloc(65_536, 2).toString("base64");
    for (let index = 0; index < SSH_EXECUTOR_STREAM_WINDOW_BYTES / 65_536; index += 1) {
      expect(streams.receive({ type: "stream-data", stream: 1, data: chunk })).toBe("accepted");
    }
    expect(streams.receive({ type: "stream-data", stream: 1, data: chunk })).toBe("violated");
    expect(streams.receive({ type: "stream-data", stream: 7, data: chunk })).toBe("violated");
    // A reused id, or one of this side's own parity, is not a new stream.
    expect(streams.adopt(1)).toBe("violated");
    expect(streams.adopt(2)).toBe("violated");
    expect(
      streams.receive({
        type: "stream-credit",
        stream: 1,
        bytes: SSH_EXECUTOR_STREAM_WINDOW_BYTES,
      }),
    ).toBe("violated");
  });

  it("accepts late frames for a stream either side already closed", async () => {
    const { executor, host, violations } = pair();
    const local = executor.open();
    if (local === undefined) throw new Error("no stream");
    const remote = host.adopt(local.id);
    if (typeof remote === "string") throw new Error(`adopt ${remote}`);
    remote.destroy();
    local.write("late");
    await settle();
    expect(host.receive({ type: "stream-end", stream: local.id })).toBe("accepted");
    expect(violations).toEqual([]);
    expect(local.destroyed).toBe(true);
  });

  it("refuses a stream past the limit and closes it on the other side", async () => {
    const sent: SshExecutorStreamFrame[] = [];
    const streams = new ExecutorStreams({
      send: (frame) => sent.push(frame),
      opens: "even",
      maxStreams: 1,
    });
    expect(typeof streams.adopt(1)).toBe("object");
    expect(streams.adopt(3)).toBe("refused");
    expect(sent).toEqual([{ type: "stream-close", stream: 3 }]);
  });

  it("joins a local socket so a close on either side finishes the other", async () => {
    const { executor, host } = pair();
    const local = executor.open();
    if (local === undefined) throw new Error("no stream");
    const remote = host.adopt(local.id);
    if (typeof remote === "string") throw new Error(`adopt ${remote}`);
    const socket = new PassThrough();
    joinToStream(socket, local);
    const received: Buffer[] = [];
    remote.on("data", (chunk: Buffer) => received.push(chunk));
    socket.end("bye");
    await settle();
    expect(Buffer.concat(received).toString()).toBe("bye");
    remote.destroy();
    await settle();
    expect(local.destroyed).toBe(true);
  });

  it("drops every stream without a word once the session is gone", () => {
    const sent: SshExecutorStreamFrame[] = [];
    const streams = new ExecutorStreams({
      send: (frame) => sent.push(frame),
      opens: "odd",
      maxStreams: 4,
    });
    const stream = streams.open();
    streams.abandonAll();
    expect(stream?.destroyed).toBe(true);
    expect(sent).toEqual([]);
  });
});
