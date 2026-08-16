import { describe, expect, it } from "vitest";
import { decodeSse } from "./openAiCompatibleSse";

const encoder = new TextEncoder();

function stream(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(
  input: ReadableStream<Uint8Array>,
  options: { maxFrameBytes?: number; maxBufferedBytes?: number; signal?: AbortSignal } = {},
) {
  const frames = [];
  for await (const frame of decodeSse(input, {
    maxFrameBytes: options.maxFrameBytes ?? 1024,
    maxBufferedBytes: options.maxBufferedBytes ?? 2048,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    frames.push(frame);
  }
  return frames;
}

describe("decodeSse", () => {
  it("decodes fragmented CRLF and LF frames with comments and multiline data", async () => {
    await expect(
      collect(
        stream(
          ": keepalive\r",
          '\nevent: response.output_text.delta\r\ndata: {"delta":"hel',
          'lo"}\r\ndata: second\r\n\r',
          "\nevent: done\ndata: [DONE]\n\n",
        ),
      ),
    ).resolves.toEqual([
      { event: "response.output_text.delta", data: '{"delta":"hello"}\nsecond' },
      { event: "done", data: "[DONE]" },
    ]);
  });

  it("dispatches a complete final event at EOF", async () => {
    await expect(collect(stream("event: done\ndata: final"))).resolves.toEqual([
      { event: "done", data: "final" },
    ]);
  });

  it("rejects invalid UTF-8", async () => {
    await expect(
      collect(stream(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff]))),
    ).rejects.toEqual({
      category: "protocol",
      message: "The provider stream contained invalid UTF-8.",
    });
  });

  it("rejects a frame that exceeds its byte limit", async () => {
    await expect(collect(stream("data: 123456789\n\n"), { maxFrameBytes: 8 })).rejects.toEqual({
      category: "protocol",
      message: "The provider stream event exceeded the configured size limit.",
    });
  });

  it("rejects unterminated oversized input before EOF", async () => {
    await expect(collect(stream("data: 123456789"), { maxFrameBytes: 8 })).rejects.toEqual({
      category: "protocol",
      message: "The provider stream event exceeded the configured size limit.",
    });
  });

  it("bounds buffered input independently of frame size", async () => {
    await expect(
      collect(stream("data: 123456789"), { maxFrameBytes: 64, maxBufferedBytes: 8 }),
    ).rejects.toEqual({
      category: "protocol",
      message: "The provider stream buffer exceeded the configured size limit.",
    });
  });

  it("cancels the reader and reports interruption", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode("data: partial"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = collect(input, { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toEqual({
      category: "interrupted",
      message: "The provider stream was cancelled.",
    });
    expect(cancelled).toBe(true);
  });

  it("cancels the source when the consumer stops early", async () => {
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\ndata: pending"));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const _frame of decodeSse(input, {
      maxFrameBytes: 1024,
      maxBufferedBytes: 2048,
    })) {
      break;
    }

    expect(cancelled).toBe(true);
  });
});
