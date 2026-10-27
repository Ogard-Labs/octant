import type { ProviderFailure } from "@octant/contracts";
import { Effect, type Scope } from "effect";
import type { ProviderAcquireInput, ProviderConnection, ProviderDriver } from "./driver";

/**
 * Acquires a connection from a driver, refusing a remote placement the driver
 * cannot take before the driver sees it. Every acquisition that carries a
 * placement goes through here: a driver written before placement existed reads
 * `projectRoot` as a folder on this host, and handed a remote one it would run
 * the runtime here against a path that names something else.
 */
export function acquireProviderConnection(
  driver: ProviderDriver,
  input: ProviderAcquireInput,
): Effect.Effect<ProviderConnection, ProviderFailure, Scope.Scope> {
  const refusal = input.placement === undefined ? undefined : remotePlacementRefusal(driver, input);
  return refusal === undefined ? driver.acquire(input) : Effect.fail(refusal);
}

/** Why a driver cannot take a remote placement for this acquisition, if it cannot. */
function remotePlacementRefusal(
  driver: Pick<ProviderDriver, "remotePlacement">,
  input: Pick<ProviderAcquireInput, "mode">,
): ProviderFailure | undefined {
  // Code is the only mode a remote root binds; Chat has no folder, and
  // Work's confinement and document adapters do not reach a target.
  if (input.mode !== "code") {
    return { category: "unsupported", message: "Only Code threads run on a remote target." };
  }
  const support = driver.remotePlacement;
  if (support === undefined || support.postures.length === 0) {
    return { category: "unsupported", message: "This provider does not run on a remote target." };
  }
  return undefined;
}
