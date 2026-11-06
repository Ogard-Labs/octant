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
