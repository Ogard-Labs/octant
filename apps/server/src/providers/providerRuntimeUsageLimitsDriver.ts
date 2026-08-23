import type { ProviderRuntimeEvent } from "@octant/contracts";
import { Effect, Stream } from "effect";
import type { ProviderDriver, ProviderConnection } from "@octant/provider-sdk/driver";
import type { ProviderRuntimeUsageLimitsStore } from "./providerRuntimeUsageLimitsStore";

/**
 * Observes the normalized event stream at the shared driver boundary. The
 * tap preserves the original stream and therefore cannot compete with the
 * turn runtime for a single-use event source.
 */
export function attachProviderRuntimeUsageLimits(
  driver: ProviderDriver,
  store: Pick<ProviderRuntimeUsageLimitsStore, "record">,
): ProviderDriver {
  return {
    ...driver,
    acquire: (input) =>
      driver.acquire(input).pipe(Effect.map((connection) => wrapConnection(connection, store))),
  };
}

function wrapConnection(
  connection: ProviderConnection,
  store: Pick<ProviderRuntimeUsageLimitsStore, "record">,
): ProviderConnection {
  return {
    ...connection,
    events: connection.events.pipe(
      Stream.tap((event: ProviderRuntimeEvent) => Effect.sync(() => store.record(event))),
    ),
  };
}
