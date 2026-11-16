import type {
  AnthropicCompatibleProviderConfiguration,
  OpenAiCompatibleProviderConfiguration,
  ProviderInstance,
} from "@octant/contracts/providers";
import type { ChatResearchRouting } from "@octant/contracts/chat";
import { resolveResearchBackend } from "./researchPolicy";

/**
 * A provider's own built-in web search, which runs inside the provider's loop:
 * Octant cannot choose its vendor, fall back, or see the query before it is
 * sent. The native harness offers it on two origins only, where Octant knows
 * whose search runs the query. The web search data policy does not govern it:
 * it behaves as it does on its own (maintainer decision, 2026-11-15).
 */
export type ProviderOwnSearchOrigin = "anthropic-api" | "openai-responses";

function hostOf(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which provider's own search an endpoint reaches, or undefined where Octant
 * cannot tell who runs it: a gateway, Azure AI Foundry, Ollama, a sign-in
 * endpoint, and the Chat Completions protocol all answer undefined.
 */
export function providerOwnSearchOrigin(
  instance: ProviderInstance,
): ProviderOwnSearchOrigin | undefined {
  if (instance.driverKind === "anthropic-compatible") {
    return anthropicOwnSearchOrigin(instance.configuration);
  }
  if (instance.driverKind === "openai-compatible") {
    return openAiOwnSearchOrigin(instance.configuration);
  }
  return undefined;
}

/** Anthropic's own API, signed in with a key: the one Anthropic-compatible origin with a search Octant can name. */
export function anthropicOwnSearchOrigin(
  configuration: AnthropicCompatibleProviderConfiguration,
): "anthropic-api" | undefined {
  if (configuration.authentication === "directory-oauth") return undefined;
  if (configuration.oauthDescriptorId !== undefined) return undefined;
  if (configuration.authentication === "none") return undefined;
  return hostOf(configuration.baseUrl) === "api.anthropic.com" ? "anthropic-api" : undefined;
}

/** OpenAI's own API on the Responses protocol, signed in with a key. */
export function openAiOwnSearchOrigin(
  configuration: OpenAiCompatibleProviderConfiguration,
): "openai-responses" | undefined {
  if (configuration.authentication !== "bearer") return undefined;
  if (configuration.oauthDescriptorId !== undefined) return undefined;
  if (configuration.protocol !== "responses") return undefined;
  return hostOf(configuration.baseUrl) === "api.openai.com" ? "openai-responses" : undefined;
}

/**
 * Whether a native harness turn offers the provider's own search, and how.
 * The research route picks between the provider's search and Octant's own in
 * the order Architecture gives (`resolveResearchBackend`), under every web
 * search data policy, since the policy governs only Octant's own backends.
 * Below Full access a thread that has read outside content is not offered it,
 * since Octant sees a built-in query only after the provider sent it and so
 * could not refuse one that carries data. Such a thread searches through
 * `web-search` when a backend is eligible. Below Full access the offer also
 * ends within the turn at its first search or tool answer.
 */
export function decideHarnessProviderSearch(input: {
  readonly research: boolean;
  readonly routing: ChatResearchRouting;
  readonly origin: ProviderOwnSearchOrigin | undefined;
  readonly webSearchReady: boolean;
  readonly tainted: boolean;
  readonly fullAccess: boolean;
}): { readonly withdrawAfterFirstStep: boolean } | undefined {
  const route = resolveResearchBackend({
    researchEnabled: input.research,
    routing: input.routing,
    webSearchReady: input.webSearchReady,
    appManagedTools: "supported",
    nativeResearch: input.origin === undefined ? "unsupported" : "supported",
  });
  if (route.kind !== "selected" || route.backend !== "provider-native") return undefined;
  if (input.tainted && !input.fullAccess) return undefined;
  return { withdrawAfterFirstStep: !input.fullAccess };
}
