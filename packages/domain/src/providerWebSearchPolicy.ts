import type {
  AnthropicCompatibleProviderConfiguration,
  OpenAiCompatibleProviderConfiguration,
  ProviderInstance,
} from "@octant/contracts/providers";
import type { ChatResearchRouting } from "@octant/contracts/chat";
import type { WebSearchDataPolicy } from "@octant/contracts/web-search";
import { resolveResearchBackend } from "./researchPolicy";

/**
 * A provider's own built-in web search, which runs inside the provider's loop:
 * Octant cannot choose its vendor, fall back, or see the query before it is
 * sent. The native harness offers it on two origins only, where Octant knows
 * whose search runs the query and under which terms.
 */
export type ProviderOwnSearchOrigin = "anthropic-api" | "openai-responses";

export interface ProviderOwnSearchOffer {
  readonly origin: ProviderOwnSearchOrigin;
  readonly label: string;
  readonly zdr: { readonly offered: boolean; readonly terms: string };
  readonly euProcessing: { readonly offered: boolean; readonly terms: string };
  readonly checkedOn: string;
  readonly source: string;
}

/**
 * What each provider's search offers, beside the backend table, with the date
 * its terms were checked and the published source they were read from.
 * Anthropic's search with dynamic filtering is not offered under ZDR, so the
 * request builder asks for the basic version only.
 */
export const PROVIDER_OWN_SEARCH_OFFERS: Readonly<
  Record<ProviderOwnSearchOrigin, ProviderOwnSearchOffer>
> = {
  "anthropic-api": {
    origin: "anthropic-api",
    label: "Anthropic API web search",
    zdr: { offered: true, terms: "Basic web search, under the person's ZDR agreement" },
    euProcessing: { offered: false, terms: "No" },
    checkedOn: "2026-11-14",
    source: "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool",
  },
  "openai-responses": {
    origin: "openai-responses",
    label: "OpenAI API web search",
    zdr: { offered: true, terms: "With limits, under the person's ZDR terms" },
    euProcessing: { offered: false, terms: "Not confirmed" },
    checkedOn: "2026-11-14",
    source: "https://platform.openai.com/docs/guides/tools-web-search",
  },
};

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

export type ProviderOwnSearchDecision =
  | {
      readonly kind: "allowed";
      readonly origin: ProviderOwnSearchOrigin;
      /** Anthropic's basic web search; the dynamic filtering version is never requested under ZDR. */
      readonly basicOnly: boolean;
    }
  | {
      readonly kind: "withheld";
      readonly reason:
        | "no-own-search"
        | "zdr-not-stated"
        | "zdr-not-offered"
        | "eu-processing-not-offered";
    };

/**
 * Whether the host's data policy lets this endpoint's own search run. Under
 * Any it runs wherever the route selects it; under ZDR only it runs only where
 * the provider offers ZDR and the person stated it; under either EU policy no
 * provider's own search runs until a provider documents EU processing for it.
 */
export function decideProviderOwnSearch(input: {
  readonly origin: ProviderOwnSearchOrigin | undefined;
  readonly policy: WebSearchDataPolicy;
  readonly zdrStated: boolean;
}): ProviderOwnSearchDecision {
  if (input.origin === undefined) return { kind: "withheld", reason: "no-own-search" };
  const offer = PROVIDER_OWN_SEARCH_OFFERS[input.origin];
  if (input.policy === "eu-only" || input.policy === "eu-and-zdr") {
    if (!offer.euProcessing.offered) {
      return { kind: "withheld", reason: "eu-processing-not-offered" };
    }
  }
  if (input.policy === "zdr-only" || input.policy === "eu-and-zdr") {
    if (!offer.zdr.offered) return { kind: "withheld", reason: "zdr-not-offered" };
    if (!input.zdrStated) return { kind: "withheld", reason: "zdr-not-stated" };
    return { kind: "allowed", origin: input.origin, basicOnly: true };
  }
  return { kind: "allowed", origin: input.origin, basicOnly: false };
}

/**
 * Whether a native harness turn offers the provider's own search, and how.
 * The research route picks between Octant's own search and the provider's in
 * the order Architecture gives (`resolveResearchBackend`); the data policy
 * may then withhold the provider's; and below Full access a thread that has
 * read outside content is not offered it, since Octant sees a built-in query
 * only after the provider sent it and so could not refuse one that carries
 * data. Such a thread searches through `web-search` when a backend is
 * eligible. Below Full access the offer also ends within the turn at its
 * first search or tool answer.
 */
export function decideHarnessProviderSearch(input: {
  readonly research: boolean;
  readonly routing: ChatResearchRouting;
  readonly origin: ProviderOwnSearchOrigin | undefined;
  readonly policy: WebSearchDataPolicy;
  readonly zdrStated: boolean;
  readonly webSearchReady: boolean;
  readonly tainted: boolean;
  readonly fullAccess: boolean;
}): { readonly basicOnly: boolean; readonly withdrawAfterFirstStep: boolean } | undefined {
  const route = resolveResearchBackend({
    researchEnabled: input.research,
    routing: input.routing,
    webSearchReady: input.webSearchReady,
    appManagedTools: "supported",
    nativeResearch: input.origin === undefined ? "unsupported" : "supported",
  });
  if (route.kind !== "selected" || route.backend !== "provider-native") return undefined;
  const decision = decideProviderOwnSearch({
    origin: input.origin,
    policy: input.policy,
    zdrStated: input.zdrStated,
  });
  if (decision.kind !== "allowed") return undefined;
  if (input.tainted && !input.fullAccess) return undefined;
  return { basicOnly: decision.basicOnly, withdrawAfterFirstStep: !input.fullAccess };
}
