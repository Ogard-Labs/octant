import type { ProviderFailure } from "@octant/contracts";
import { SshDeniedRootEntries, SshPlacedVariables } from "@octant/contracts/ssh-executor-protocol";
import { Effect, Schema, type Scope } from "effect";
import type {
  ProviderAcquireInput,
  ProviderConnection,
  ProviderDriver,
  ProviderPlacedLaunch,
} from "./driver";

const isPlacedVariables = Schema.is(SshPlacedVariables);
const isDeniedRootEntries = Schema.is(SshDeniedRootEntries);

/**
 * Whether a launch's fixed variables and denied root entries are ones a target
 * accepts, so a driver decides what it can declare from the seam and not from
 * one target's protocol. The bounds are the executor's own wire schemas, the
 * one definition both sides read; a launch outside them is refused at the
 * host before any frame.
 */
export function placedLaunchExpressible(
  launch: Pick<ProviderPlacedLaunch, "accountState" | "fixedVariables" | "deniedRootEntries">,
): boolean {
  const fixed = launch.fixedVariables ?? {};
  return (
    isPlacedVariables(Object.entries(fixed).map(([name, value]) => ({ name, value }))) &&
    isDeniedRootEntries(launch.deniedRootEntries ?? []) &&
    // The target sets an account-state path's variable to that path itself.
    !(launch.accountState ?? []).some(
      (state) => state.variable !== undefined && Object.hasOwn(fixed, state.variable),
    )
  );
}

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
