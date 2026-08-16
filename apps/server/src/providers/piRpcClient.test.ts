import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PiRpcFailure, makePiRpcClient } from "./piRpcClient";

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function transport(limits: { lineBytes?: number; requestTimeoutMs?: number } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = makePiRpcClient({ stdin, stdout, limits });
  void client.exited.catch(() => undefined);
  return { client, stdin, stdout };
}

function written(stream: PassThrough) {
  const values: unknown[] = [];
  let buffered = "";
  stream.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    values.push(...lines.map((line) => JSON.parse(line)));
  });
  return values;
}

describe("PiRpcClient", () => {
  it("uses strict LF framing and preserves Unicode separators inside JSON strings", async () => {
    const { client, stdout } = transport();
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    stdout.write('{"type":"message_update","message":{"text":"a\u2028b"},');
    stdout.write('"assistantMessageEvent":{"type":"text_delta","delta":"x"}}\r\n');
    await tick();
    expect(events).toEqual([
      expect.objectContaining({ type: "message_update", message: { text: "a b" } }),
    ]);
    await client.close();
  });

  it("correlates responses and extension UI replies", async () => {
    const { client, stdin, stdout } = transport();
    const output = written(stdin);
    const pending = client.request("get_state");
    await tick();
    expect(output).toEqual([{ id: "octant-1", type: "get_state" }]);
    stdout.write(
      `${JSON.stringify({ id: "octant-1", type: "response", command: "get_state", success: true, data: { sessionId: "pi-1" } })}\n`,
    );
    await expect(pending).resolves.toMatchObject({ data: { sessionId: "pi-1" } });
    await client.respondToUi("approval-1", { confirmed: true });
    expect(output[1]).toEqual({
      type: "extension_ui_response",
      id: "approval-1",
      confirmed: true,
    });
    await client.close();
  });

  it("fails closed on malformed, oversized, unknown, timeout, and incomplete records", async () => {
    const malformed = transport();
    malformed.stdout.write("{private}\n");
    await expect(malformed.client.exited).rejects.toMatchObject({ kind: "protocol" });

    const oversized = transport({ lineBytes: 16 });
    oversized.stdout.write("x".repeat(17));
    await expect(oversized.client.exited).rejects.toMatchObject({ kind: "protocol" });

    const unknown = transport();
    unknown.stdout.write(
      `${JSON.stringify({ id: "missing", type: "response", command: "get_state", success: true })}\n`,
    );
    await expect(unknown.client.exited).rejects.toMatchObject({ kind: "protocol" });

    const timeout = transport({ requestTimeoutMs: 5 });
    await expect(timeout.client.request("get_state")).rejects.toMatchObject({ kind: "timeout" });

    const incomplete = transport();
    incomplete.stdout.end('{"type":"agent_start"}');
    await expect(incomplete.client.exited).rejects.toMatchObject({ kind: "protocol" });
  });

  it("rejects dialog requests with missing correlation or unsupported methods", async () => {
    const { client, stdout } = transport();
    stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", method: "confirm", title: "Allow?" })}\n`,
    );
    await expect(client.exited).rejects.toBeInstanceOf(PiRpcFailure);

    const unsupported = transport();
    unsupported.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "x", method: "custom" })}\n`,
    );
    await expect(unsupported.client.exited).rejects.toMatchObject({ kind: "protocol" });
  });
});
