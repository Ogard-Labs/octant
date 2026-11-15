import type { ProviderInstanceId, ProviderSessionId, ProviderTurnInput } from "@octant/contracts";
import type { ProviderHarnessEndpoint } from "@octant/provider-sdk/harness-endpoint";
import type { EndpointRetryOptions } from "../providers/endpointRetry";
import type { ModelContextWindowMemory } from "../providers/modelContextWindowFacts";
import type {
  NativeHarnessLeadFallback,
  NativeHarnessProviderSearchDecisions,
} from "./nativeHarnessTransport";

/** A direct endpoint as another instance's lead can reach it when its own model is down. */
export type NativeHarnessEndpoint = ProviderHarnessEndpoint;

/**
 * The direct endpoints this host runs, by provider instance. A lead whose
 * model keeps failing may continue on a model of a different instance; the
 * registry is how that instance's transport is found without the loop
 * knowing any driver. `runOnNativeHarness` registers a driver's endpoint
 * when the driver is built and replaces the entry when it is rebuilt.
 */
export class NativeHarnessEndpointRegistry {
  readonly #endpoints = new Map<string, NativeHarnessEndpoint>();

  register(instanceId: ProviderInstanceId, endpoint: NativeHarnessEndpoint): void {
    this.#endpoints.set(String(instanceId), endpoint);
  }

  get(instanceId: ProviderInstanceId): NativeHarnessEndpoint | undefined {
    return this.#endpoints.get(String(instanceId));
  }
}

/**
 * Where each session's provider-search grant is decided while its turn runs.
 * The composition tracks a session when its turn is sent with a grant; the
 * session's loop asks before each request and releases it when it ends.
 */
export class NativeHarnessProviderSearchGrants implements NativeHarnessProviderSearchDecisions {
  readonly #decide = new Map<
    string,
    (providerInstanceId: ProviderInstanceId) => ProviderTurnInput["providerWebSearch"]
  >();

  /** Decides the session's grant from now on, for whichever endpoint a request goes to. */
  track(
    sessionId: ProviderSessionId,
    decide: (providerInstanceId: ProviderInstanceId) => ProviderTurnInput["providerWebSearch"],
  ): void {
    this.#decide.set(String(sessionId), decide);
  }

  now(
    sessionId: ProviderSessionId,
    providerInstanceId: ProviderInstanceId,
  ): ReturnType<NativeHarnessProviderSearchDecisions["now"]> {
    const decide = this.#decide.get(String(sessionId));
    return decide === undefined
      ? { status: "untracked" }
      : { status: "decided", grant: decide(providerInstanceId) };
  }

  release(sessionId: ProviderSessionId): void {
    this.#decide.delete(String(sessionId));
  }
}

/** What the server hands the harness that runs a direct endpoint so it can retry, fall back, and learn. */
export interface NativeHarnessEndpointHooks {
  readonly endpoints?: NativeHarnessEndpointRegistry;
  readonly leadFallback?: NativeHarnessLeadFallback;
  /** Whether an instance a lead falls back to runs the provider's own web search. */
  readonly ownSearchOn?: (instanceId: ProviderInstanceId) => boolean;
  /** Each running turn's provider-search grant as the host decides it now. */
  readonly providerSearch?: NativeHarnessProviderSearchDecisions;
  /** A test replaces the clock and the random source so no real time passes. */
  readonly retry?: EndpointRetryOptions;
  /** Where what a request teaches about its model's window is kept past the session. */
  readonly contextWindows?: ModelContextWindowMemory;
}
