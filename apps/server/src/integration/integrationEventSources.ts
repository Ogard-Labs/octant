import type { IntegrationEventSourceProvider } from "@octant/plugin-api/integration";

/** Contributions share a normalized source port; the scheduler has no vendor reach. */
export function integrationEventSources(
  providers: ReadonlyArray<IntegrationEventSourceProvider>,
): IntegrationEventSourceProvider {
  return {
    choices: async () =>
      (await Promise.all(providers.map((provider) => provider.choices().catch(() => []))))
        .flat()
        .slice(0, 64),
    bind: async (selection, signal) => {
      for (const provider of providers) {
        if (signal.aborted) return undefined;
        const source = await provider.bind(selection, signal);
        if (source !== undefined) return source;
      }
      return undefined;
    },
  };
}

/**
 * A source made after the routine scheduler, such as the webhook source the hub
 * services own: it lists nothing and binds nothing until it is bound.
 */
export function lateIntegrationEventSources(): {
  readonly provider: IntegrationEventSourceProvider;
  readonly bind: (provider: IntegrationEventSourceProvider) => void;
} {
  let bound: IntegrationEventSourceProvider | undefined;
  return {
    provider: {
      choices: async () => (bound === undefined ? [] : bound.choices()),
      bind: async (selection, signal) =>
        bound === undefined ? undefined : bound.bind(selection, signal),
    },
    bind: (provider) => {
      bound = provider;
    },
  };
}
