import { describe, expect, it } from "vitest";
import {
  decodeOutsideDriverFailureData,
  decodeOutsideDriverProbeResult,
  decodeOutsideDriverSessionSendResult,
  decodeOutsideDriverToHostMessage,
  HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS,
} from "./outsideDriverProtocol";

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
      expect(decodeOutsideDriverToHostMessage(message)._tag).toBe("Right");
    }
  });

  it.each([
    ["a method the protocol does not have", { jsonrpc: "2.0", method: "host/exec", params: {} }],
    ["another JSON-RPC version", { jsonrpc: "1.0", id: 1, result: {} }],
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
      "a brokered request with a method other than GET or POST",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "http/request",
        params: { url: "https://x.test/", method: "DELETE" },
      },
    ],
  ])("refuses %s", (_name, message) => {
    expect(decodeOutsideDriverToHostMessage(message)._tag).toBe("Left");
  });

  it("refuses a probe or answer carrying facts only the host may state", () => {
    expect(decodeOutsideDriverProbeResult({ models: [], verifiedToolModelIds: ["m"] })._tag).toBe(
      "Left",
    );
    expect(
      decodeOutsideDriverProbeResult({ models: [], claims: { sessionCompaction: {} } })._tag,
    ).toBe("Left");
    expect(
      decodeOutsideDriverSessionSendResult({ text: "", toolCalls: [], servedModelId: "m" })._tag,
    ).toBe("Left");
  });

  it("reads a failure only as structure, never as free text", () => {
    expect(
      decodeOutsideDriverFailureData({ category: "rate-limited", retryAfterMs: 10 })._tag,
    ).toBe("Right");
    expect(decodeOutsideDriverFailureData({ category: "rate-limited", message: "x" })._tag).toBe(
      "Left",
    );
  });
});
