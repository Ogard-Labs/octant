import { describe, expect, it } from "vitest";
import { redactSecretShaped } from "./secretShapedTextPolicy";

describe("webhook signing secrets in text", () => {
  it("replaces a bare Stripe or Standard Webhooks signing secret whole", () => {
    const stripe = "whsec_5WbX1kEMOo2N8gQk9Ff3LhZtA7cYdRsV";
    const minted = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw+/Q0aB1cD2E=";
    for (const secret of [stripe, minted]) {
      expect(redactSecretShaped(`the secret is ${secret} for this endpoint`)).toBe(
        "the secret is [redacted] for this endpoint",
      );
    }
  });

  it("replaces a Standard Webhooks private signing key", () => {
    expect(redactSecretShaped("whsk_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")).toBe("[redacted]");
  });

  it("leaves the prefix named on its own", () => {
    const text = "Stripe's secrets start with whsec_ and look like whsec_...";
    expect(redactSecretShaped(text)).toBe(text);
  });
});

describe("a credential written after a scheme word", () => {
  const token = "q8Zr2mVn6TkYp1Ld4Hs9Wc3Bf7Xa5Ge0";

  it("replaces the value too, not only the scheme word", () => {
    for (const lead of [
      "access_token: Bearer ",
      "token = Basic ",
      "api_key=bearer ",
      "Authorization: Bearer\n",
    ]) {
      expect(redactSecretShaped(`${lead}${token} then`)).not.toContain(token);
    }
  });

  it("never spends the next line's credential label as a value and leaves its secret", () => {
    for (const lead of [
      "access_token: Bearer\nAuthorization: ",
      "token = Basic\r\nAuthorization: Basic ",
      "api_key=bearer\n  Proxy-Authorization: ",
      "token:\nAuthorization: ",
      "Bearer\nx_refresh_token_for_the_agent=",
      "Authorization: Bearer\ntoken: ",
      "token = Bearer Authorization: ",
    ]) {
      expect(redactSecretShaped(`${lead}${token} then`)).not.toContain(token);
    }
  });

  it("replaces a bearer token whole even when its characters read like a label", () => {
    // Shorter than a bearer token before `token=`, so a later pass cannot
    // catch the prefix the assignment left behind.
    const tricky = "q8Zr2mVn6Tk_token=Wc3Bf7Xa5Ge0Ld4Hs9";
    const redacted = redactSecretShaped(`send Bearer ${tricky} here`);
    expect(redacted).toBe("send [redacted] here");
  });

  it("replaces a value that itself reads like a credential label", () => {
    expect(redactSecretShaped(`token=mytoken:${token}`)).toBe("[redacted]");
  });

  it("replaces a bearer token holding base64 characters whole", () => {
    expect(redactSecretShaped("send Bearer q8Zr2mVn+6TkY/p1Ld4Hs9Wc3Bf7Xa5Ge0== now")).toBe(
      "send [redacted] now",
    );
  });
});
