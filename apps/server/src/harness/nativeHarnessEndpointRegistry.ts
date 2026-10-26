import type { ProviderInstanceId } from "@octant/contracts";
import type { ProviderHarnessEndpoint } from "@octant/provider-sdk/harness-endpoint";
import type { EndpointRetryOptions } from "../providers/endpointRetry";
import type { ModelContextWindowMemory } from "../providers/modelContextWindowFacts";
import type { NativeHarnessLeadFallback } from "./nativeHarnessTransport";

/** A direct endpoint as another instance's lead can reach it when its own model is down. */
export type NativeHarnessEndpoint = ProviderHarnessEndpoint;

/**
 * The direct endpoints this host runs, by provider instance. A lead whose
 * model keeps failing may continue on a model of a different instance; the
 * registry is how that instance's transport is found without the loop
 * knowing any driver. A driver registers itself when it is built and
 * replaces its entry when it is rebuilt.
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

/** What the server hands a direct-endpoint driver so its harness can retry and fall back. */
export interface NativeHarnessEndpointHooks {
  readonly endpoints?: NativeHarnessEndpointRegistry;
  readonly leadFallback?: NativeHarnessLeadFallback;
  /** A test replaces the clock and the random source so no real time passes. */
  readonly retry?: EndpointRetryOptions;
  /** Where what a request teaches about its model's window is kept past the session. */
  readonly contextWindows?: ModelContextWindowMemory;
}
