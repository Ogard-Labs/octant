import { describe, expect, it } from "vitest";
import {
  decodeHostOAuthJournalRecord,
  decodeHostOAuthSignInOffer,
  decodeHostOAuthSignInState,
} from "./hostOAuth";

describe("host OAuth contracts", () => {
  it("rejects a journal record that carries a token", () => {
    expect(() =>
      decodeHostOAuthJournalRecord({
        name: "host-oauth.sign-in-completed",
        descriptorId: "sample-http",
        attemptId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
        accessToken: "must-not-decode",
      }),
    ).toThrow();
  });

  it("rejects a sign-in state that carries a refresh token", () => {
    expect(() =>
      decodeHostOAuthSignInState({
        kind: "signed-in",
        attemptId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        descriptorId: "sample-http",
        credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
        refreshToken: "must-not-decode",
      }),
    ).toThrow();
  });

  it("requires the API-key path on every sign-in offer", () => {
    const offer = decodeHostOAuthSignInOffer({
      oauth: { available: true, termsRequired: true },
      apiKey: { available: true },
    });
    expect(offer.apiKey.available).toBe(true);
    expect(() =>
      decodeHostOAuthSignInOffer({
        oauth: { available: true, termsRequired: false },
        apiKey: { available: false },
      }),
    ).toThrow();
  });
});
