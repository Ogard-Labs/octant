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
