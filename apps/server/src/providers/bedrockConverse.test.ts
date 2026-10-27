import { createHash } from "node:crypto";
import {
  decodeProviderFailure,
  decodeProviderToolDefinition,
  type ProviderFailure,
} from "@octant/contracts";
import type { HarnessEndpointStreamEvent } from "@octant/provider-sdk/harness-endpoint";
import type { CloudIamRequest } from "@octant/provider-sdk/cloud-iam";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BEDROCK_CONVERSE_LIMITS,
  buildBedrockConverseBody,
  sendBedrockConverse,
  type BedrockConverseEndpoint,
  type BedrockConverseInput,
} from "./bedrockConverse";
import {
  converseStreamResponse,
  encodeConverseEvents,
  textReply,
  toolUseReply,
} from "./bedrockConverse.test-support";
import { endpointRetryReason } from "./endpointRetry";

const HOST = "bedrock-runtime.us-west-2.amazonaws.com";
const MODEL = "anthropic.claude-sonnet-4-20250514-v1:0";

const request: BedrockConverseInput = {
  modelId: MODEL,
  system: "Be brief.",
  history: [{ role: "user", text: "Hello" }],
  tools: [],
};

function endpointAnswering(
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const signed: CloudIamRequest[] = [];
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const endpoint: BedrockConverseEndpoint = {
    host: HOST,
    limits: DEFAULT_BEDROCK_CONVERSE_LIMITS,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return answer(url, init);
    },
    authorize: async (fields, send) => {
      signed.push(fields);
      return send({ authorization: "AWS4-HMAC-SHA256 fixture", "x-amz-date": "20261027T090000Z" });
    },
  };
  return { endpoint, signed, sent };
}

async function send(
  endpoint: BedrockConverseEndpoint,
  input: BedrockConverseInput = request,
  signal = new AbortController().signal,
) {
  const events: HarnessEndpointStreamEvent[] = [];
  const result = await sendBedrockConverse({
    endpoint,
    request: input,
    signal,
    onEvent: (event) => events.push(event),
  });
  return { result, events };
}

async function rejection(promise: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await promise;
  } catch (error) {
    return decodeProviderFailure(error);
  }
  throw new Error("expected a rejection");
}

describe("Bedrock Converse transport", () => {
  it("signs exactly the body it sends, to the model's percent-encoded path on the region's host", async () => {
    const scene = endpointAnswering(() => converseStreamResponse(textReply("Hello there.")));
    const { result, events } = await send(scene.endpoint);

    expect(result.text).toBe("Hello there.");
    expect(events.filter((event) => event.kind === "text-delta")).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
    const [signed] = scene.signed;
    const [sent] = scene.sent;
    expect(signed).toMatchObject({
      method: "POST",
      host: HOST,
      path: "/model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse-stream",
      query: [],
      headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" },
    });
    expect(sent?.url).toBe(`https://${HOST}${signed?.path ?? ""}`);
    expect(signed?.payloadHash).toBe(
      createHash("sha256").update(String(sent?.init.body)).digest("hex"),
    );
    expect(JSON.parse(String(sent?.init.body))).toEqual({
      messages: [{ role: "user", content: [{ text: "Hello" }] }],
      system: [{ text: "Be brief." }],
    });
  });

  it("assembles a streamed tool call and adds cached input to the input figure", async () => {
    const scene = endpointAnswering(() =>
      converseStreamResponse([
        ...toolUseReply("tooluse_1", "octant_read_file", { path: "README.md" }).slice(0, -1),
        {
          type: "event",
          name: "metadata",
          payload: {
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              cacheReadInputTokens: 100,
              cacheWriteInputTokens: 7,
            },
          },
        },
      ]),
    );
    const { result } = await send(scene.endpoint);
    expect(result.toolCalls).toEqual([
      {
        toolCallId: "tooluse_1",
        toolName: "octant_read_file",
        argumentsJson: JSON.stringify({ path: "README.md" }),
      },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 117,
      outputTokens: 4,
      cacheReadInputTokens: 100,
      cacheWriteInputTokens: 7,
    });
  });

  it("sends tool calls and results as Converse blocks, and as text when the request offers no tools", () => {
    const history: BedrockConverseInput["history"] = [
      { role: "user", text: "Read it" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ toolCallId: "t1", toolName: "read", argumentsJson: '{"path":"a"}' }],
      },
      {
        role: "user",
        text: "",
        toolResults: [
          {
            toolCallId: "t1",
            resultJson: '{"text":"hi"}',
            isError: false,
            images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
          },
        ],
      },
      { role: "user", text: "Thanks" },
    ];
    const tools = [
      decodeProviderToolDefinition({
        name: "read",
        inputSchema: { type: "object", properties: {} },
      }),
    ];
    const withTools = buildBedrockConverseBody({ ...request, history, tools });
    expect(withTools.messages).toEqual([
      { role: "user", content: [{ text: "Read it" }] },
      {
        role: "assistant",
        content: [{ toolUse: { toolUseId: "t1", name: "read", input: { path: "a" } } }],
      },
      {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: "t1",
              content: [
                { text: '{"text":"hi"}' },
                { image: { format: "png", source: { bytes: "iVBORw0KGgo=" } } },
              ],
              status: "success",
            },
          },
          { text: "Thanks" },
        ],
      },
    ]);
    expect(withTools.toolConfig).toEqual({
      tools: [
        { toolSpec: { name: "read", inputSchema: { json: { type: "object", properties: {} } } } },
      ],
    });

    const withoutTools = buildBedrockConverseBody({ ...request, history, tools: [] });
    expect(withoutTools.toolConfig).toBeUndefined();
    expect(JSON.stringify(withoutTools.messages)).not.toContain("toolUse");
    expect(JSON.stringify(withoutTools.messages)).toContain("[Called tool read (t1)");
  });

  it("reads Bedrock's refusals by error type, never its message", async () => {
    const answers: ReadonlyArray<readonly [number, string, string, string]> = [
      [429, "ThrottlingException", "Too many requests, Rate exceeded secret-ish", "rate-limited"],
      [503, "ServiceUnavailableException", "busy", "unavailable"],
      [404, "ResourceNotFoundException", "Model not found", "invalid-configuration"],
      [400, "ValidationException", "Malformed input request, please reformat", "provider-failed"],
    ];
    for (const [status, type, message, category] of answers) {
      const scene = endpointAnswering(() =>
        Response.json(
          { message },
          { status, headers: { "x-amzn-errortype": `${type}:http://internal` } },
        ),
      );
      const failure = await rejection(send(scene.endpoint));
      expect(failure.category).toBe(category);
      expect(failure.message).not.toContain(message);
    }
  });

  it("reads a filled context window as an overflow the harness can shrink", async () => {
    const scene = endpointAnswering(() =>
      Response.json(
        {
          message:
            "Input is too long for requested model. prompt is too long: 210000 tokens > 200000 maximum",
        },
        { status: 400, headers: { "x-amzn-errortype": "ValidationException" } },
      ),
    );
    const failure = await rejection(send(scene.endpoint));
    expect(failure.message).toMatch(/context|prompt is too long/i);
  });

  it("reads a stream exception by its type", async () => {
    const scene = endpointAnswering(() =>
      converseStreamResponse([
        { type: "event", name: "messageStart", payload: { role: "assistant" } },
        { type: "exception", name: "throttlingException", payload: { message: "slow down" } },
      ]),
    );
    expect((await rejection(send(scene.endpoint))).category).toBe("rate-limited");
  });

  it("reads a stream cut short as one the host sends again", async () => {
    const scene = endpointAnswering(() => converseStreamResponse(textReply("Cut").slice(0, 3)));
    const failure = await rejection(send(scene.endpoint));
    expect(endpointRetryReason(failure)).toBe("stream-interrupted");
  });

  it("refuses a message whose checksum does not hold", async () => {
    const bytes = encodeConverseEvents(textReply("Damaged"));
    bytes[bytes.byteLength - 10] = (bytes[bytes.byteLength - 10] ?? 0) ^ 0xff;
    const scene = endpointAnswering(() => new Response(bytes, { status: 200 }));
    const failure = await rejection(send(scene.endpoint));
    expect(failure).toMatchObject({ category: "protocol" });
    expect(failure.message).toContain("damaged");
  });

  it("is interrupted when cancelled, before or during the request", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const before = endpointAnswering(() => converseStreamResponse(textReply("never")));
    expect((await rejection(send(before.endpoint, request, cancelled.signal))).category).toBe(
      "interrupted",
    );
    expect(before.sent).toHaveLength(0);

    const during = new AbortController();
    const hanging = endpointAnswering(
      (_, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          during.abort();
        }),
    );
    expect((await rejection(send(hanging.endpoint, request, during.signal))).category).toBe(
      "interrupted",
    );
  });
});
