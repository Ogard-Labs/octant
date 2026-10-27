import { describe, expect, it } from "vitest";
import { sha256Hex, sigV4Date, sigV4SigningKey, signSigV4 } from "./sigV4";

// The cloud's own published examples: the signature test suite's credentials
// and the documented signing-key derivation.
const EXAMPLE_CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const EMPTY_PAYLOAD = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("Signature Version 4", () => {
  it("derives the documented signing key", () => {
    expect(
      sigV4SigningKey(EXAMPLE_CREDENTIALS.secretAccessKey, "20120215", "us-east-1", "iam").toString(
        "hex",
      ),
    ).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });

  it("signs the test suite's plain GET exactly as published", () => {
    const signed = signSigV4({
      request: {
        method: "GET",
        host: "example.amazonaws.com",
        path: "/",
        query: [],
        headers: {},
        payloadHash: EMPTY_PAYLOAD,
      },
      credentials: EXAMPLE_CREDENTIALS,
      region: "us-east-1",
      service: "service",
      amzDate: "20150830T123600Z",
    });
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("signs the documented query request with a signed content type", () => {
    const signed = signSigV4({
      request: {
        method: "GET",
        host: "iam.amazonaws.com",
        path: "/",
        query: [
          ["Version", "2010-05-08"],
          ["Action", "ListUsers"],
        ],
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        payloadHash: EMPTY_PAYLOAD,
      },
      credentials: EXAMPLE_CREDENTIALS,
      region: "us-east-1",
      service: "iam",
      amzDate: "20150830T123600Z",
    });
    expect(signed.signedHeaders).toBe("content-type;host;x-amz-date");
    expect(signed.signature).toBe(
      "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("signs a session token as a header of its own and encodes a path segment twice", () => {
    const base = {
      method: "POST",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
      query: [],
      headers: { "content-type": "application/json" },
      payloadHash: sha256Hex("{}"),
    } as const;
    const signed = signSigV4({
      request: { ...base, path: "/model/anthropic.claude-v2%3A1/converse" },
      credentials: { ...EXAMPLE_CREDENTIALS, sessionToken: "session-token-example" },
      region: "us-east-1",
      service: "bedrock",
      amzDate: sigV4Date(Date.parse("2026-10-27T09:00:00.000Z")),
    });
    expect(signed.headers["x-amz-security-token"]).toBe("session-token-example");
    expect(signed.headers["x-amz-date"]).toBe("20261027T090000Z");
    expect(signed.signedHeaders).toBe("content-type;host;x-amz-date;x-amz-security-token");
    // The encoded colon is part of what is signed: the same request with a
    // raw colon is a different request.
    const raw = signSigV4({
      request: { ...base, path: "/model/anthropic.claude-v2:1/converse" },
      credentials: { ...EXAMPLE_CREDENTIALS, sessionToken: "session-token-example" },
      region: "us-east-1",
      service: "bedrock",
      amzDate: "20261027T090000Z",
    });
    expect(raw.signature).not.toBe(signed.signature);
  });
});
