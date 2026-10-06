import {
  decodeHostOAuthDescriptor,
  decodeSubscriptionOAuthOffer,
} from "@octant/contracts/host-oauth";
import { describe, expect, it } from "vitest";
import { subscriptionOAuthOffers } from "./subscriptionOAuthCatalog";

describe("subscription OAuth catalog", () => {
  it("offers OpenRouter as the first catalog entry", () => {
    const offers = subscriptionOAuthOffers();
    expect(offers.map((offer) => offer.descriptor.descriptorId)).toEqual(["openrouter"]);
    const openRouter = offers[0]!;
    expect(openRouter.descriptor.dialect).toBe("openrouter-pkce");
    expect(openRouter.descriptor.flow).toBe("authorization-code-pkce");
    expect(openRouter.descriptor.authorizationEndpoint).toBe("https://openrouter.ai/auth");
    expect(openRouter.descriptor.tokenEndpoint).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(openRouter.allowedEndpoint).toBe("https://openrouter.ai/api/v1");
    expect(openRouter.driverKinds).toEqual(["openai-compatible"]);
  });

  it("round-trips every catalog entry through the wire schemas", () => {
    for (const offer of subscriptionOAuthOffers()) {
      expect(decodeSubscriptionOAuthOffer(offer)).toEqual(offer);
      expect(decodeHostOAuthDescriptor(offer.descriptor)).toEqual(offer.descriptor);
    }
  });
});
