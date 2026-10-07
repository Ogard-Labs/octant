import type { HostOAuthDescriptor, SubscriptionOAuthOffer } from "@octant/contracts/host-oauth";

/**
 * Descriptors that offer host-driven sign-in beside an API key.
 * The wire schema stays in contracts. This catalog is the product list.
 */
export function subscriptionOAuthOffers(): readonly SubscriptionOAuthOffer[] {
  return [openRouterOffer, chatGptPlanOffer];
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

/**
 * Sign in with ChatGPT for open-source and local apps. The first sign-in
 * registers Octant as a user-defined agent: the authorize request carries the
 * `dynamic_agent_client` placeholder plus the agent name hint and a stable
 * host id, and the callback returns the issued client id the host keeps for
 * every later exchange and refresh. The sign-in may only attach to the
 * OpenAI API endpoint itself, and the request profile the driver applies on
 * this route enforces the plan preview's limitations.
 */
const chatGptPlanOffer: SubscriptionOAuthOffer = {
  descriptor: {
    descriptorId: "chatgpt-plan" as HostOAuthDescriptor["descriptorId"],
    dialect: "chatgpt-plan-siwc",
    flow: "authorization-code-pkce",
    authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
    tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ],
    termsId: "chatgpt-plan-terms-1" as HostOAuthDescriptor["termsId"],
    agentNameHint: "Octant",
  },
  accountLabel: "ChatGPT plan",
  termsSummary:
    "Octant signs you in with your ChatGPT account and stores the tokens in the local credential broker. Requests run against your ChatGPT plan; the Sign in with ChatGPT terms apply.",
  driverKinds: ["openai-compatible"],
  allowedEndpoint: "https://api.openai.com/v1",
};
