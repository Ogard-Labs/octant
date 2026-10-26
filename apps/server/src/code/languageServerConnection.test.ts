import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  LANGUAGE_SERVER_FRAME_CAP_BYTES,
  LanguageServerConnection,
  type LanguageServerViolation,
} from "./languageServerConnection";

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]);
}

/** A server end: what it writes reaches the connection, and what the connection writes is parsed. */
function harness(requestDeadlineMs = 1_000) {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];
  let buffered = Buffer.alloc(0);
  toServer.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(
        /Content-Length: (\d+)/.exec(buffered.subarray(0, end).toString())?.[1],
      );
      if (buffered.byteLength < end + 4 + length) return;
      sent.push(JSON.parse(buffered.subarray(end + 4, end + 4 + length).toString()));
      buffered = buffered.subarray(end + 4 + length);
    }
  });
  const violations: LanguageServerViolation[] = [];
  const connection = new LanguageServerConnection({
    input: fromServer,
    output: toServer,
    requestDeadlineMs,
    onViolation: (violation) => violations.push(violation),
  });
  return { connection, fromServer, sent, violations };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("language server connection", () => {
  it("answers a server's request to edit files, run a command, or open a document with method-not-found", async () => {
    const { fromServer, sent } = harness();
    for (const [id, method] of [
      [1, "workspace/applyEdit"],
      [2, "workspace/executeCommand"],
      [3, "window/showDocument"],
      [4, "client/unregisterCapability"],
    ] as const) {
      fromServer.write(frame({ jsonrpc: "2.0", id, method, params: {} }));
    }
    await settle();
    expect(sent.map((message) => [message.id, (message.error as { code: number }).code])).toEqual([
      [1, -32601],
      [2, -32601],
      [3, -32601],
      [4, -32601],
    ]);
    expect(sent.every((message) => message.result === undefined)).toBe(true);
  });

  it("accepts a registration only when every method in it is one Octant sends", async () => {
    const { connection, fromServer, sent } = harness();
    fromServer.write(
      frame({
        jsonrpc: "2.0",
        id: "watch",
        method: "client/registerCapability",
        params: { registrations: [{ id: "w", method: "workspace/didChangeWatchedFiles" }] },
      }),
    );
    fromServer.write(
      frame({
        jsonrpc: "2.0",
        id: "config",
        method: "client/registerCapability",
        params: {
          registrations: [
            { id: "c", method: "workspace/didChangeConfiguration" },
            { id: "o", method: "textDocument/didOpen" },
          ],
        },
      }),
    );
    await settle();
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: "watch", result: null });
    expect(sent[1]?.error).toBeDefined();
    expect(connection.registered("workspace/didChangeWatchedFiles")).toBe(true);
    expect(connection.registered("textDocument/didOpen")).toBe(false);
  });

  it("answers configuration with the server's own defaults and accepts progress tokens", async () => {
    const { fromServer, sent } = harness();
    fromServer.write(
      frame({
        jsonrpc: "2.0",
        id: 7,
        method: "workspace/configuration",
        params: { items: [{ section: "typescript" }, { section: "editor" }] },
      }),
    );
    fromServer.write(
      frame({ jsonrpc: "2.0", id: 8, method: "window/workDoneProgress/create", params: {} }),
    );
    await settle();
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 7, result: [null, null] },
      { jsonrpc: "2.0", id: 8, result: null },
    ]);
  });

  it("ends the connection on a frame declared past the cap, before its body arrives", async () => {
    const { connection, fromServer, violations } = harness();
    const pending = connection.request("textDocument/diagnostic", { textDocument: { uri: "x" } });
    fromServer.write(`Content-Length: ${LANGUAGE_SERVER_FRAME_CAP_BYTES + 1}\r\n\r\n{`);
    expect(await pending).toEqual({ status: "closed" });
    expect(violations).toEqual(["oversize-frame"]);
    expect(connection.closed).toBe(true);
  });

  it("ends the connection on a frame that is not JSON-RPC", async () => {
    const { connection, fromServer, violations } = harness();
    fromServer.write("Content-Length: 3\r\n\r\nabc");
    await settle();
    expect(violations).toEqual(["malformed-frame"]);
    expect(connection.closed).toBe(true);
  });

  it("times a request out at its deadline and asks the server to cancel it", async () => {
    const { connection, sent } = harness(20);
    const response = await connection.request("textDocument/definition", {
      textDocument: { uri: "file:///c/a.ts" },
      position: { line: 0, character: 0 },
    });
    expect(response).toEqual({ status: "timed-out" });
    await settle();
    const request = sent.find((message) => message.method === "textDocument/definition");
    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: request?.id },
    });
  });

  it("matches answers to requests and reports an error answer as failed", async () => {
    const { connection, fromServer, sent } = harness();
    const first = connection.request("textDocument/definition", {});
    const second = connection.request("textDocument/diagnostic", {});
    await settle();
    fromServer.write(frame({ jsonrpc: "2.0", id: sent[1]?.id, error: { code: -32802 } }));
    fromServer.write(frame({ jsonrpc: "2.0", id: sent[0]?.id, result: [] }));
    expect(await first).toEqual({ status: "answered", result: [] });
    expect(await second).toEqual({ status: "failed" });
  });

  it("does not send a frame past the cap", () => {
    const { connection, sent } = harness();
    expect(
      connection.notify("textDocument/didOpen", {
        textDocument: { text: "x".repeat(LANGUAGE_SERVER_FRAME_CAP_BYTES) },
      }),
    ).toBe("too-large");
    expect(sent).toEqual([]);
  });
});
