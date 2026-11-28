import { describe, expect, it } from "vitest";
import {
  decodeOutsideDriverFailureData,
  decodeOutsideDriverImageGenerateResult,
  decodeOutsideDriverProbeResult,
  decodeOutsideDriverSessionSendResult,
  decodeOutsideDriverToHostMessage,
  decodeOutsideDriverVideoForgetResult,
  decodeOutsideDriverVideoPollResult,
  decodeOutsideDriverVideoStartResult,
  HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS,
  HOST_IMAGE_GENERATION_PROTOCOL_VERSIONS,
  HOST_VIDEO_GENERATION_PROTOCOL_VERSIONS,
  OUTSIDE_DRIVER_IMAGE_BASE64_CHARACTERS,
  OUTSIDE_DRIVER_REFERENCE_IMAGE_BASE64_CHARACTERS,
  OutsideDriverImageGenerateParams,
  OutsideProviderDriverProtocolVersion,
  outsideDriverProtocolFamily,
} from "./outsideDriverProtocol";
import { Schema } from "effect";

describe("outside image generation protocol", () => {
  it("speaks image-generation/1 beside harness-endpoint/1, and tells the two families apart", () => {
    expect(HOST_IMAGE_GENERATION_PROTOCOL_VERSIONS).toEqual(["image-generation/1"]);
    const decode = Schema.decodeUnknownSync(OutsideProviderDriverProtocolVersion, {
      onExcessProperty: "error",
    });
    expect(outsideDriverProtocolFamily(decode("image-generation/1"))).toBe("image-generation");
    expect(outsideDriverProtocolFamily(decode("harness-endpoint/1"))).toBe("harness-endpoint");
    expect(() => decode("audio-generation/1")).toThrow();
  });

  it("reads a completed job's images as bytes or an address, and a refusal with no text", () => {
    const data = "iVBORw0KGgo=";
    for (const result of [
      { status: "completed", images: [{ mediaType: "image/png", data }] },
      { status: "completed", images: [{ url: "https://cdn.example.test/1.png" }] },
      { status: "refused" },
    ]) {
      expect(decodeOutsideDriverImageGenerateResult(result)._tag).toBe("Success");
    }
  });

  it("reads an image chunk notification and an answer naming a chunked image", () => {
    expect(
      decodeOutsideDriverToHostMessage({
        jsonrpc: "2.0",
        method: "image/chunk",
        params: { requestId: 4, image: 0, data: "iVBORw0K" },
      })._tag,
    ).toBe("Success");
    for (const params of [
      { requestId: 4, image: 16, data: "iVBORw0K" },
      { requestId: 4, image: 0, data: "iVBORw0" },
      { requestId: 4, image: 0, data: "iVBORw0K", note: "x" },
    ]) {
      expect(
        decodeOutsideDriverToHostMessage({ jsonrpc: "2.0", method: "image/chunk", params })._tag,
      ).toBe("Failure");
    }
    expect(
      decodeOutsideDriverImageGenerateResult({
        status: "completed",
        images: [{ mediaType: "image/png", chunked: true }],
      })._tag,
    ).toBe("Success");
  });

  it("refuses a job result carrying anything the protocol does not name", () => {
    for (const result of [
      { status: "refused", message: "attacker text" },
      { status: "completed", images: [] },
      { status: "completed", images: [{ mediaType: "image/svg+xml", data: "PHN2Zz4=" }] },
      { status: "completed", images: [{ mediaType: "image/png", data: "not base64!" }] },
      { status: "completed", images: [{ url: "x" }], usdMicros: 1 },
    ]) {
      expect(decodeOutsideDriverImageGenerateResult(result)._tag).toBe("Failure");
    }
  });

  it("caps reference image base64 at the 2.5 MiB broker-safe ceiling", () => {
    const decodeParams = Schema.decodeUnknownResult(OutsideDriverImageGenerateParams, {
      onExcessProperty: "error",
    });
    const atCeiling = "A".repeat(OUTSIDE_DRIVER_REFERENCE_IMAGE_BASE64_CHARACTERS);
    expect(
      decodeParams({
        modelId: "outside-model-1",
        prompt: "edit this",
        variantCount: 1,
        references: [{ mediaType: "image/png", data: atCeiling }],
      })._tag,
    ).toBe("Success");
    const overCeiling = "A".repeat(OUTSIDE_DRIVER_REFERENCE_IMAGE_BASE64_CHARACTERS + 4);
    expect(
      decodeParams({
        modelId: "outside-model-1",
        prompt: "edit this",
        variantCount: 1,
        references: [{ mediaType: "image/png", data: overCeiling }],
      })._tag,
    ).toBe("Failure");
  });
});

describe("outside video generation protocol", () => {
  it("speaks video-generation/1 as a family of its own", () => {
    expect(HOST_VIDEO_GENERATION_PROTOCOL_VERSIONS).toEqual(["video-generation/1"]);
    const decode = Schema.decodeUnknownSync(OutsideProviderDriverProtocolVersion, {
      onExcessProperty: "error",
    });
    expect(outsideDriverProtocolFamily(decode("video-generation/1"))).toBe("video-generation");
  });

  it("reads a started job, a running, finished, refused, failed and cancelled one, and a removal", () => {
    for (const result of [{ status: "started", remoteId: "job-1" }, { status: "refused" }]) {
      expect(decodeOutsideDriverVideoStartResult(result)._tag).toBe("Success");
    }
    for (const result of [
      { status: "running" },
      { status: "completed", url: "https://cdn.example.test/clip.mp4" },
      {
        status: "completed",
        url: "https://cdn.example.test/clip.mp4",
        usage: { billedSeconds: 5, inputTokens: 10, outputTokens: 20 },
      },
      { status: "refused", billed: true },
      { status: "failed", category: "provider-failed", billed: true, usage: { billedSeconds: 2 } },
      { status: "cancelled" },
    ]) {
      expect(decodeOutsideDriverVideoPollResult(result)._tag).toBe("Success");
    }
    expect(decodeOutsideDriverVideoForgetResult({ status: "removed" })._tag).toBe("Success");
  });

  it("takes no price, free text, inline clip or empty usage from a running driver", () => {
    for (const result of [
      { status: "started", remoteId: "" },
      { status: "started", remoteId: "x".repeat(513) },
      { status: "refused", message: "attacker text" },
    ]) {
      expect(decodeOutsideDriverVideoStartResult(result)._tag).toBe("Failure");
    }
    for (const result of [
      { status: "completed", url: "https://cdn.example.test/c.mp4", usage: { costUsdMicros: 1 } },
      { status: "completed", url: "https://cdn.example.test/c.mp4", usage: { billedSeconds: 0 } },
      { status: "completed", url: "https://cdn.example.test/c.mp4", price: 1 },
      { status: "completed", data: "AAAA" },
      { status: "refused", text: "attacker text" },
      { status: "failed", category: "provider-failed", message: "attacker text" },
      { status: "failed", category: "made-up" },
    ]) {
      expect(decodeOutsideDriverVideoPollResult(result)._tag).toBe("Failure");
    }
  });
});

describe("outside driver wire protocol", () => {
  it("speaks harness-endpoint/1 and no other version", () => {
    expect(HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS).toEqual(["harness-endpoint/1"]);
  });

  it("reads the messages a driver may write", () => {
    for (const message of [
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "harness-endpoint/1" } },
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: "x", data: { category: "unavailable" } },
      },
      {
        jsonrpc: "2.0",
        method: "session/event",
        params: { requestId: 3, event: { kind: "text-delta", text: "Hi" } },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "http/request",
        params: {
          url: "https://models.example.test/v1/chat",
          method: "POST",
          headers: [["content-type", "application/json"]],
          body: "{}",
          auth: { header: "authorization", scheme: "Bearer" },
        },
      },
    ]) {
      expect(decodeOutsideDriverToHostMessage(message)._tag).toBe("Success");
    }
  });

  it.each([
    ["a method the protocol does not have", { jsonrpc: "2.0", method: "host/exec", params: {} }],
    ["another JSON-RPC version", { jsonrpc: "1.0", id: 1, result: {} }],
    ["an answer with neither a result nor an error", { jsonrpc: "2.0", id: 1 }],
    [
      "a retry announcement",
      {
        jsonrpc: "2.0",
        method: "session/event",
        params: {
          requestId: 1,
          event: {
            kind: "retrying",
            attempt: 1,
            maxAttempts: 2,
            delayMs: 1,
            reason: "rate-limited",
          },
        },
      },
    ],
    [
      "a brokered request naming another instance",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "http/request",
        params: { url: "https://x.test/", method: "GET", instanceId: "other" },
      },
    ],
    [
      "a brokered request with a header that splits lines",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "http/request",
        params: { url: "https://x.test/", method: "GET", headers: [["x-a", "1\r\nhost: evil"]] },
      },
    ],
    [
      "a brokered request with a method the protocol does not name",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "http/request",
        params: { url: "https://x.test/", method: "PATCH" },
      },
    ],
  ])("refuses %s", (_name, message) => {
    expect(decodeOutsideDriverToHostMessage(message)._tag).toBe("Failure");
  });

  it("refuses a probe or answer carrying facts only the host may state", () => {
    expect(decodeOutsideDriverProbeResult({ models: [], verifiedToolModelIds: ["m"] })._tag).toBe(
      "Failure",
    );
    expect(
      decodeOutsideDriverProbeResult({ models: [], claims: { sessionCompaction: {} } })._tag,
    ).toBe("Failure");
    expect(
      decodeOutsideDriverSessionSendResult({ text: "", toolCalls: [], servedModelId: "m" })._tag,
    ).toBe("Failure");
  });

  it("reads a failure only as structure, never as free text", () => {
    expect(
      decodeOutsideDriverFailureData({ category: "rate-limited", retryAfterMs: 10 })._tag,
    ).toBe("Success");
    expect(decodeOutsideDriverFailureData({ category: "rate-limited", message: "x" })._tag).toBe(
      "Failure",
    );
  });
});
