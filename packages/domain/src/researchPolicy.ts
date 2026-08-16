import type { ChatResearchRouting } from "@octant/contracts/chat";

export type ResearchBackend = "searxng" | "provider-native";

export type ResearchBackendDecision =
  | { readonly kind: "disabled" }
  | { readonly kind: "selected"; readonly backend: ResearchBackend }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "searxng-not-configured"
        | "app-managed-tools-unsupported"
        | "native-research-unsupported";
    };

export interface ResearchBackendInput {
  readonly researchEnabled: boolean;
  readonly routing: ChatResearchRouting;
  readonly searxngConfigured: boolean;
  readonly appManagedTools: "supported" | "unsupported" | "unavailable";
  readonly nativeResearch: "supported" | "unsupported" | "unavailable";
}

function isSupported(value: "supported" | "unsupported" | "unavailable"): value is "supported" {
  return value === "supported";
}

function selectSearxng(input: ResearchBackendInput): ResearchBackendDecision {
  if (!input.searxngConfigured) {
    return { kind: "unavailable", reason: "searxng-not-configured" };
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
  return { kind: "selected", backend: "provider-native" };
}

export function resolveResearchBackend(input: ResearchBackendInput): ResearchBackendDecision {
  if (!input.researchEnabled) {
    return { kind: "disabled" };
  }

  if (input.routing === "searxng") {
    return selectSearxng(input);
  }

  if (input.routing === "provider-native") {
    return selectNative(input);
  }

  const searxng = selectSearxng(input);
  if (searxng.kind === "selected") {
    return searxng;
  }

  return selectNative(input);
}
