import {
  resolveResearchBackend,
  type ResearchBackendDecision,
  type ResearchBackendInput,
} from "@octant/domain/research-policy";
import type { WebSearchAnswer, WebSearchInput } from "../../webSearch/webSearchBackends";

export type ResearchExecuteInput = WebSearchInput;

export interface ProviderNativeResearchResultSet {
  readonly query: string;
  readonly backend: "provider-native";
  readonly results: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }>;
}

export type ResearchExecutionResult = WebSearchAnswer | ProviderNativeResearchResultSet;

export type ResearchRouteDecision =
  | ResearchBackendDecision
  | {
      readonly kind: "ready";
      readonly backend: "searxng";
      readonly attribution: string;
      readonly execute: (input: ResearchExecuteInput) => Promise<ResearchExecutionResult>;
    }
  | {
      readonly kind: "ready";
      readonly backend: "provider-native";
      readonly attribution: string;
    };

/** Octant's own `web-search` over the host's eligible backends. */
export interface WebSearchLike {
  search(input: WebSearchInput): Promise<WebSearchAnswer>;
}

export interface ResearchRouterDependencies {
  readonly webSearch: WebSearchLike;
  /** @deprecated Provider-native research executes inside the selected provider adapter. */
  readonly providerNativeExecute?: (
    input: ResearchExecuteInput,
  ) => Promise<ProviderNativeResearchResultSet>;
}

export class ResearchRouter {
  constructor(private readonly dependencies: ResearchRouterDependencies) {}

  resolve(input: ResearchBackendInput): ResearchRouteDecision {
    const decision = resolveResearchBackend(input);
    if (decision.kind !== "selected") {
      return decision;
    }

    if (decision.backend === "searxng") {
      return {
        kind: "ready",
        backend: "searxng",
        attribution: "Octant web search",
        execute: (executeInput) => this.dependencies.webSearch.search(executeInput),
      };
    }

    return {
      kind: "ready",
      backend: "provider-native",
      attribution: "Provider-native search",
    };
  }
}
