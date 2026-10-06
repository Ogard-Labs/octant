import {
  decodeHostOAuthDescriptor,
  decodeSubscriptionOAuthOffer,
} from "@octant/contracts/host-oauth";
import { describe, expect, it } from "vitest";
import { chatGptPlanOfferWithHostId, subscriptionOAuthOffers } from "./subscriptionOAuthCatalog";

describe("subscription OAuth catalog", () => {
  it("offers OpenRouter as the first catalog entry", () => {
    const offers = subscriptionOAuthOffers();
    expect(offers.map((offer) => offer.descriptor.descriptorId)).toEqual([
      "openrouter",
      "chatgpt-plan",
    ]);
    const openRouter = offers[0];
    if (openRouter === undefined) throw new Error("missing OpenRouter offer");
    expect(openRouter.descriptor.dialect).toBe("openrouter-pkce");
    expect(openRouter.descriptor.flow).toBe("authorization-code-pkce");
    expect(openRouter.descriptor.authorizationEndpoint).toBe("https://openrouter.ai/auth");
    expect(openRouter.descriptor.tokenEndpoint).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(openRouter.allowedEndpoint).toBe("https://openrouter.ai/api/v1");
    expect(openRouter.driverKinds).toEqual(["openai-compatible"]);
  });

  it("offers the ChatGPT plan sign-in with the SIWC dialect and endpoints", () => {
    const offers = subscriptionOAuthOffers();
    const chatGpt = offers.find((offer) => offer.descriptor.descriptorId === "chatgpt-plan");
    if (chatGpt === undefined) throw new Error("missing ChatGPT plan offer");
    expect(chatGpt.descriptor.dialect).toBe("chatgpt-plan-siwc");
    expect(chatGpt.descriptor.flow).toBe("authorization-code-pkce");
    expect(chatGpt.descriptor.authorizationEndpoint).toBe(
      "https://auth.openai.com/api/accounts/authorize",
    );
    expect(chatGpt.descriptor.tokenEndpoint).toBe(
      "https://auth.openai.com/api/accounts/oauth/token",
    );
    expect(chatGpt.descriptor.scopes).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ]);
    expect(chatGpt.descriptor.agentNameHint).toBe("Octant");
    expect(chatGpt.allowedEndpoint).toBe("https://api.openai.com/v1");
    expect(chatGpt.driverKinds).toEqual(["openai-compatible"]);
    expect(chatGpt.accountLabel).toBe("ChatGPT plan");
  });

  it("binds a provisioned host id into the ChatGPT plan offer", () => {
    const bound = chatGptPlanOfferWithHostId("urn:uuid:11111111-2222-4333-8444-555555555555");
    expect(bound.descriptor.extAgentHostId).toBe("urn:uuid:11111111-2222-4333-8444-555555555555");
    expect(bound.descriptor.descriptorId).toBe("chatgpt-plan");
    // The catalog entry itself never carries a host id.
    const catalog = subscriptionOAuthOffers().find(
      (offer) => offer.descriptor.descriptorId === "chatgpt-plan",
    );
    if (catalog === undefined) throw new Error("missing ChatGPT plan offer");
    expect(catalog.descriptor.extAgentHostId).toBeUndefined();
  });

  it("round-trips every catalog entry through the wire schemas", () => {
    for (const offer of subscriptionOAuthOffers()) {
      expect(decodeSubscriptionOAuthOffer(offer)).toEqual(offer);
      expect(decodeHostOAuthDescriptor(offer.descriptor)).toEqual(offer.descriptor);
    }
  });
});
