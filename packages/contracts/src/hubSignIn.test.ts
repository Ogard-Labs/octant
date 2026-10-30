import { describe, expect, it } from "vitest";
import {
  decodeHubSignInAsk,
  decodeHubSignInDelivery,
  decodeHubSignInOutcomeReport,
} from "./hubSignIn";

const member = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

describe("a hub-started sign-in request", () => {
  it("names a member and a provider account kind and nothing else", () => {
    expect(decodeHubSignInAsk({ memberId: member, kind: "claude-subscription" }).kind).toBe(
      "claude-subscription",
    );
    expect(() =>
      decodeHubSignInAsk({ memberId: member, kind: "claude-subscription", token: "x" }),
    ).toThrow();
    expect(() => decodeHubSignInAsk({ memberId: member, kind: "openai-compatible" })).toThrow();
  });

  it("reads a delivered kind as text so a spoke can refuse it by name", () => {
    expect(decodeHubSignInDelivery({ requestId, kind: "some-future-kind" }).kind).toBe(
      "some-future-kind",
    );
    expect(() => decodeHubSignInDelivery({ requestId, kind: "x", code: "ABCD-1234" })).toThrow();
  });

  it("lets an outcome report carry only one of four words", () => {
    for (const outcome of ["signed-in", "declined", "expired", "failed"]) {
      expect(decodeHubSignInOutcomeReport({ requestId, outcome }).outcome).toBe(outcome);
    }
    expect(() => decodeHubSignInOutcomeReport({ requestId, outcome: "ok" })).toThrow();
    expect(() =>
      decodeHubSignInOutcomeReport({ requestId, outcome: "signed-in", email: "a@b.test" }),
    ).toThrow();
  });
});
