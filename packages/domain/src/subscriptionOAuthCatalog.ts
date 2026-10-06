import type { HostOAuthDescriptor, SubscriptionOAuthOffer } from "@octant/contracts/host-oauth";

/**
 * Descriptors that offer host-driven sign-in beside an API key.
 * The wire schema stays in contracts. This catalog is the product list.
 */
export function subscriptionOAuthOffers(): readonly SubscriptionOAuthOffer[] {
  return [openRouterOffer];
}

/**
 * OpenRouter signs in through its PKCE key-issuing path: the user authorizes
 * at openrouter.ai/auth with a loopback callback, and the code is exchanged
 * at api/v1/auth/keys for a user-controlled API key the host keeps in the
 * broker. There is no client registration and no refresh token, so the entry
 * declares the `openrouter-pkce` dialect and an empty scope list. The sign-in
 * may only attach to the OpenRouter API endpoint itself.
 */
const openRouterOffer: SubscriptionOAuthOffer = {
  descriptor: {
    descriptorId: "openrouter" as HostOAuthDescriptor["descriptorId"],
    dialect: "openrouter-pkce",
    flow: "authorization-code-pkce",
    authorizationEndpoint: "https://openrouter.ai/auth",
    tokenEndpoint: "https://openrouter.ai/api/v1/auth/keys",
    scopes: [],
    termsId: "openrouter-terms-1" as HostOAuthDescriptor["termsId"],
  },
  accountLabel: "OpenRouter account",
  termsSummary:
    "Octant signs you in to OpenRouter with OpenRouter's own PKCE flow and stores the issued API key in the local credential broker. The key stays on this host; OpenRouter's terms apply.",
  driverKinds: ["openai-compatible"],
  allowedEndpoint: "https://openrouter.ai/api/v1",
};
