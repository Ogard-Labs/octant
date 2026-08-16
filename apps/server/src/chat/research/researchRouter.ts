import {
  resolveResearchBackend,
  type ResearchBackendDecision,
  type ResearchBackendInput,
} from "@octant/domain/research-policy";
import type {
  ResearchResultSet as SearxngResearchResultSet,
  SearxngSearchInput,
} from "./searxngClient";

export interface ResearchExecuteInput {
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface ProviderNativeResearchResultSet {
  readonly query: string;
  readonly backend: "provider-native";
  readonly results: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }>;
}

export type ResearchExecutionResult = SearxngResearchResultSet | ProviderNativeResearchResultSet;

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

export interface SearxngClientLike {
  search(input: SearxngSearchInput): Promise<SearxngResearchResultSet>;
}

export interface ResearchRouterDependencies {
  readonly searxngClient: SearxngClientLike;
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
        attribution: "SearXNG",
        execute: (executeInput) => this.dependencies.searxngClient.search(executeInput),
      };
    }

    return {
      kind: "ready",
      backend: "provider-native",
      attribution: "Provider-native search",
    };
  }
}
