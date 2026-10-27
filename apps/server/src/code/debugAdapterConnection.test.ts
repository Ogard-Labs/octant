import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  DEBUG_ADAPTER_FRAME_CAP_BYTES,
  DebugAdapterConnection,
  type DebugAdapterRequestCommand,
  type DebugAdapterViolation,
} from "./debugAdapterConnection";

function frame(message: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]);
}

function connection() {
  const fromAdapter = new PassThrough();
  const toAdapter = new PassThrough();
  const written: Array<Record<string, unknown>> = [];
  let pending = Buffer.alloc(0);
  toAdapter.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/.exec(pending.subarray(0, end).toString())?.[1]);
      if (pending.byteLength < end + 4 + length) return;
      written.push(JSON.parse(pending.subarray(end + 4, end + 4 + length).toString("utf8")));
      pending = pending.subarray(end + 4 + length);
    }
  });
  const events: Array<{ readonly event: string; readonly body: unknown }> = [];
  const refused: string[] = [];
  const violations: DebugAdapterViolation[] = [];
  const subject = new DebugAdapterConnection({
    input: fromAdapter,
    output: toAdapter,
    requestDeadlineMs: 50,
    onViolation: (violation) => violations.push(violation),
    onEvent: (event, body) => events.push({ event, body }),
    onRefusedRequest: (command) => refused.push(command),
  });
  return { subject, fromAdapter, written, events, refused, violations };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("the debug adapter connection", () => {
  it("sends only requests on Octant's closed list", async () => {
    const test = connection();
    // `attach`, `restart`, and memory reads are not on the list, whatever a caller passes.
    for (const command of ["attach", "restart", "readMemory", "runInTerminal"]) {
      expect(
        await test.subject.request(command as DebugAdapterRequestCommand, { processId: 1 }),
      ).toEqual({ status: "closed" });
    }
    await settle();
    expect(test.written).toEqual([]);

    const answered = test.subject.request("threads");
    await settle();
    expect(test.written).toEqual([{ seq: 1, type: "request", command: "threads" }]);
    test.fromAdapter.write(
      frame({ seq: 9, type: "response", request_seq: 1, success: true, body: { threads: [] } }),
    );
    expect(await answered).toEqual({ status: "answered", body: { threads: [] } });
  });

  it("refuses every request the adapter makes of the host, and drops telemetry and unknown events", async () => {
    const test = connection();
    test.fromAdapter.write(
      Buffer.concat([
        frame({ seq: 1, type: "request", command: "runInTerminal", arguments: { args: ["sh"] } }),
        frame({ seq: 2, type: "request", command: "startDebugging", arguments: {} }),
        frame({
          seq: 3,
          type: "event",
          event: "output",
          body: { category: "telemetry", output: "x" },
        }),
        frame({ seq: 4, type: "event", event: "memory", body: {} }),
        frame({ seq: 5, type: "event", event: "stopped", body: { reason: "breakpoint" } }),
      ]),
    );
    await settle();
    expect(test.refused).toEqual(["runInTerminal", "startDebugging"]);
    expect(test.written).toEqual([
      expect.objectContaining({ type: "response", request_seq: 1, success: false }),
      expect.objectContaining({ type: "response", request_seq: 2, success: false }),
    ]);
    expect(test.events).toEqual([{ event: "stopped", body: { reason: "breakpoint" } }]);
  });

  it("ends on a frame declared past the cap before its body arrives, and on one that is not a frame", async () => {
    const oversize = connection();
    const waiting = oversize.subject.request("threads");
    oversize.fromAdapter.write(`Content-Length: ${DEBUG_ADAPTER_FRAME_CAP_BYTES + 1}\r\n\r\n`);
    expect(await waiting).toEqual({ status: "closed" });
    expect(oversize.violations).toEqual(["oversize-frame"]);
    expect(oversize.subject.closed).toBe(true);

    const malformed = connection();
    malformed.fromAdapter.write("Content-Length: 3\r\n\r\n{x}");
    await settle();
    expect(malformed.violations).toEqual(["malformed-frame"]);
  });

  it("reports a request the adapter does not answer in time as timed out, and cancels it", async () => {
    const test = connection();
    expect(await test.subject.request("evaluate", { expression: "x" })).toEqual({
      status: "timed-out",
    });
    await settle();
    expect(test.written.map((message) => message.command)).toEqual(["evaluate", "cancel"]);
    expect(test.written[1]).toMatchObject({ arguments: { requestId: 1 } });
  });
});
