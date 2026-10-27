import { crc32 } from "./bedrockConverse";

/**
 * Bedrock's binary event stream, written the way the service writes it, so a
 * test can answer a Converse request without a real endpoint.
 */

export type ConverseStreamEvent =
  | { readonly type: "event"; readonly name: string; readonly payload: unknown }
  | { readonly type: "exception"; readonly name: string; readonly payload: unknown };

export function encodeEventStreamMessage(
  headers: Readonly<Record<string, string>>,
  payload: Uint8Array,
): Uint8Array {
  const encodedHeaders: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = new TextEncoder().encode(name);
    const valueBytes = new TextEncoder().encode(value);
    encodedHeaders.push(nameBytes.byteLength, ...nameBytes, 7);
    encodedHeaders.push((valueBytes.byteLength >> 8) & 0xff, valueBytes.byteLength & 0xff);
    encodedHeaders.push(...valueBytes);
  }
  const total = 12 + encodedHeaders.length + payload.byteLength + 4;
  const message = new Uint8Array(total);
  const view = new DataView(message.buffer);
  view.setUint32(0, total);
  view.setUint32(4, encodedHeaders.length);
  view.setUint32(8, crc32(message.subarray(0, 8)));
  message.set(encodedHeaders, 12);
  message.set(payload, 12 + encodedHeaders.length);
  view.setUint32(total - 4, crc32(message.subarray(0, total - 4)));
  return message;
}

export function encodeConverseEvents(
  events: ReadonlyArray<ConverseStreamEvent>,
): Uint8Array<ArrayBuffer> {
  const parts = events.map((event) =>
    encodeEventStreamMessage(
      event.type === "event"
        ? {
            ":event-type": event.name,
            ":message-type": "event",
            ":content-type": "application/json",
          }
        : { ":exception-type": event.name, ":message-type": "exception" },
      new TextEncoder().encode(JSON.stringify(event.payload)),
    ),
  );
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/** A response that streams the events, split into small chunks as a network would. */
export function converseStreamResponse(
  events: ReadonlyArray<ConverseStreamEvent>,
  chunkBytes = 37,
): Response {
  const bytes = encodeConverseEvents(events);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          controller.enqueue(bytes.slice(offset, offset + chunkBytes));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
  );
}

const event = (name: string, payload: unknown): ConverseStreamEvent => ({
  type: "event",
  name,
  payload,
});

/** A reply of plain text in a few deltas, with usage. */
export function textReply(text: string): ReadonlyArray<ConverseStreamEvent> {
  const middle = Math.max(1, Math.floor(text.length / 2));
  return [
    event("messageStart", { role: "assistant" }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: text.slice(0, middle) } }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: text.slice(middle) } }),
    event("contentBlockStop", { contentBlockIndex: 0 }),
    event("messageStop", { stopReason: "end_turn" }),
    event("metadata", {
      usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
      metrics: { latencyMs: 120 },
    }),
  ];
}

/** A reply that calls one tool, its arguments streamed in parts. */
export function toolUseReply(
  toolUseId: string,
  name: string,
  input: Readonly<Record<string, unknown>>,
): ReadonlyArray<ConverseStreamEvent> {
  const json = JSON.stringify(input);
  const middle = Math.floor(json.length / 2);
  return [
    event("messageStart", { role: "assistant" }),
    event("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId, name } } }),
    event("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { toolUse: { input: json.slice(0, middle) } },
    }),
    event("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { toolUse: { input: json.slice(middle) } },
    }),
    event("contentBlockStop", { contentBlockIndex: 0 }),
    event("messageStop", { stopReason: "tool_use" }),
    event("metadata", { usage: { inputTokens: 20, outputTokens: 9, totalTokens: 29 } }),
  ];
}
