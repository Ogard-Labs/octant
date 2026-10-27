import { describe, expect, it } from "vitest";
import { sha256Hex, sigV4Date, sigV4SigningKey, signSigV4, type SigV4Request } from "./sigV4";

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

  // More of the published test suite (aws4_testsuite, as botocore ships it):
  // query order and encoding, a UTF-8 path, header whitespace, the unreserved
  // set, a signed session token, and a form body.
  const SUITE_DEFAULTS: SigV4Request = {
    method: "GET",
    host: "example.amazonaws.com",
    path: "/",
    query: [],
    headers: {},
    payloadHash: EMPTY_PAYLOAD,
  };
  it.each([
    {
      name: "get-vanilla-query-order-key-case",
      request: {
        query: [
          ["Param2", "value2"],
          ["Param1", "value1"],
        ] as const,
      },
      signature: "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    },
    {
      name: "get-vanilla-utf8-query",
      request: { query: [["\u1234", "bar"]] as const },
      signature: "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04",
    },
    {
      name: "get-utf8",
      request: { path: "/\u1234" },
      signature: "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85",
    },
    {
      name: "get-header-value-trim",
      request: { headers: { "my-header1": " value1", "my-header2": ' "a   b   c"' } },
      signature: "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
    },
    {
      name: "get-unreserved",
      request: { path: "/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" },
      signature: "07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f",
    },
    {
      name: "get-vanilla-with-session-token",
      request: {},
      sessionToken: "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267",
      signature: "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8",
    },
    {
      name: "post-x-www-form-urlencoded",
      request: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payloadHash: sha256Hex("Param1=value1"),
      },
      signature: "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    },
  ])(
    "signs the test suite's $name exactly as published",
    ({ request, sessionToken, signature }) => {
      const signed = signSigV4({
        request: { ...SUITE_DEFAULTS, ...request },
        credentials:
          sessionToken === undefined
            ? EXAMPLE_CREDENTIALS
            : { ...EXAMPLE_CREDENTIALS, sessionToken },
        region: "us-east-1",
        service: "service",
        amzDate: "20150830T123600Z",
      });
      expect(signed.signature).toBe(signature);
    },
  );

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
