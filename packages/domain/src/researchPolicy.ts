import type { ChatResearchRouting } from "@octant/contracts/chat";

export type ResearchBackend = "searxng" | "provider-native";

export type ResearchBackendDecision =
  | { readonly kind: "disabled" }
  | { readonly kind: "selected"; readonly backend: ResearchBackend }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "no-eligible-web-search-backend"
        | "app-managed-tools-unsupported"
        | "native-research-unsupported"
        | "native-research-withheld-by-data-policy";
    };

export interface ResearchBackendInput {
  readonly researchEnabled: boolean;
  readonly routing: ChatResearchRouting;
  /** The host's data policy leaves at least one of its web search backends eligible. */
  readonly webSearchReady: boolean;
  readonly appManagedTools: "supported" | "unsupported" | "unavailable";
  readonly nativeResearch: "supported" | "unsupported" | "unavailable";
  /**
   * The provider supports its own search, but the host's web search data
   * policy withholds it (`providerNativeResearchUnderPolicy`). Absent, nothing
   * withholds it.
   */
  readonly nativeResearchWithheld?: boolean;
}

function isSupported(value: "supported" | "unsupported" | "unavailable"): value is "supported" {
  return value === "supported";
}

function selectOctant(input: ResearchBackendInput): ResearchBackendDecision {
  if (!input.webSearchReady) {
    return { kind: "unavailable", reason: "no-eligible-web-search-backend" };
  }
  if (!isSupported(input.appManagedTools)) {
    return { kind: "unavailable", reason: "app-managed-tools-unsupported" };
  }
  return { kind: "selected", backend: "searxng" };
}

function selectNative(input: ResearchBackendInput): ResearchBackendDecision {
  if (!isSupported(input.nativeResearch)) {
    return { kind: "unavailable", reason: "native-research-unsupported" };
  }
  if (input.nativeResearchWithheld === true) {
    return { kind: "unavailable", reason: "native-research-withheld-by-data-policy" };
  }
  return { kind: "selected", backend: "provider-native" };
}

export function resolveResearchBackend(input: ResearchBackendInput): ResearchBackendDecision {
  if (!input.researchEnabled) {
    return { kind: "disabled" };
  }

  if (input.routing === "searxng") {
    return selectOctant(input);
  }

  if (input.routing === "provider-native") {
    return selectNative(input);
  }

  // Automatic prefers the provider's own search: it needs no endpoint, so a
  // fresh install searches without setup. Octant's own web search is the
  // fallback for a provider that has none.
  const native = selectNative(input);
  if (native.kind === "selected") {
    return native;
  }

  return selectOctant(input);
}
