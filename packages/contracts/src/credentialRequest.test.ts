import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CredentialRequestAnswer, CredentialRequestView } from "./credentialRequest";

describe("private credential wire boundaries", () => {
  it("refuses a secret value smuggled into a public card", () => {
    expect(() =>
      Schema.decodeUnknownSync(CredentialRequestView)({
        requests: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            threadId: "thread",
            label: "Token",
            reason: "Check access",
            consumer: "Service",
            destination: "https://api.example.com",
            actionLabel: "Check access",
            state: "pending",
            secret: "private-token",
          },
        ],
      }),
    ).toThrow();
  });
  it("refuses an endpoint or a value on a decline", () => {
    const decode = Schema.decodeUnknownSync(CredentialRequestAnswer);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(() => decode({ id, action: "decline", secret: "private-token" })).toThrow();
    expect(() =>
      decode({ id, action: "allow", secret: "private-token", url: "https://evil.test" }),
    ).toThrow();
  });
});
