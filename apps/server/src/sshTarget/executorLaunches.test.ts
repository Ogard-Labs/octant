import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SshExecutorFrame } from "@octant/contracts/ssh-executor-protocol";
import { ExecutorEgress } from "./executorLaunches";
import { ExecutorStreams } from "./executorStreams";

/**
 * A macOS target's forwarder: a loopback port any local user can reach, so
 * it is the token, not the port, that decides who gets through to this
 * host's proxy. The listener is plain TCP, so these run on every platform;
 * the macOS smoke shows Seatbelt keeps a launch to its own port.
 */

const TOKEN = "a".repeat(64);
const WRONG_TOKEN = "b".repeat(64);

let session: string;
let frames: SshExecutorFrame[];
let egress: ExecutorEgress;

beforeEach(() => {
  session = mkdtempSync(join(tmpdir(), "octant-executor-egress-"));
  frames = [];
  const send = (frame: SshExecutorFrame) => frames.push(frame);
  egress = new ExecutorEgress(
    send,
    new ExecutorStreams({ send, opens: "odd", maxStreams: 8 }),
    "darwin",
  );
});

afterEach(() => {
  egress.abandon();
  rmSync(session, { recursive: true, force: true });
});

function connectHead(token: string | undefined): string {
  return [
    "CONNECT api.example.com:443 HTTP/1.1",
    "Host: api.example.com:443",
    ...(token === undefined
      ? []
      : [`Proxy-Authorization: Basic ${Buffer.from(`octant:${token}`).toString("base64")}`]),
    "",
    "",
  ].join("\r\n");
}

/** Sends `request` to the port and collects what comes back until the forwarder closes or goes quiet. */
function exchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, 1_000);
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.once("connect", () => socket.write(request));
  });
}

async function openLoopback(): Promise<number> {
  const endpoint = await egress.open(session, 1, TOKEN);
  if (endpoint?.kind !== "loopback") throw new Error("expected a loopback forwarder");
  return endpoint.port;
}

describe("a macOS target's loopback forwarder", () => {
  it("refuses a connection that presents no token, or another launch's, before anything reaches this host", async () => {
    const port = await openLoopback();
    for (const token of [undefined, WRONG_TOKEN]) {
      const reply = await exchange(port, connectHead(token));
      expect(reply.split("\r\n")[0]).toBe("HTTP/1.1 407 Proxy Authentication Required");
    }
    const malformed = await exchange(port, "GET / HTTP/1.1\r\nHost x\r\n\r\n");
    expect(malformed.split("\r\n")[0]).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(frames).toEqual([]);
  });

  it("forwards a connection that presents the launch's token, its first request included, as a stream naming the launch", async () => {
    const port = await openLoopback();
    const head = connectHead(TOKEN);
    await exchange(port, head);
    const opened = frames.find((frame) => frame.type === "stream-open");
    expect(opened).toMatchObject({ type: "stream-open", launch: 1 });
    const forwarded = frames
      .flatMap((frame) =>
        frame.type === "stream-data" ? [Buffer.from(frame.data, "base64").toString("latin1")] : [],
      )
      .join("");
    expect(forwarded).toBe(head);
  });

  it("stops listening when its launch ends", async () => {
    const port = await openLoopback();
    egress.close(1);
    await expect(exchange(port, connectHead(TOKEN))).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    expect(frames).toEqual([]);
  });
});
