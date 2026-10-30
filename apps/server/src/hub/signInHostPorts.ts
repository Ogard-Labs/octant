// What this host can say about a provider account, for hub-started sign-in. It
// only reads: it asks the provider registry whether the provider's own app is
// signed in, the same probe Settings' "check the connection" runs. It never runs
// a sign-in, never reads a token, and a probe that cannot answer counts as
// unavailable rather than signed in.

import type { HubSignInKind, ProviderInstance } from "@octant/contracts";
import type { ProviderServiceApi } from "../providers/providerService";
import { HOST_WINDOW_ID } from "./provisionHostPorts";
import type { SignInAccountState, SignInHostPorts } from "./spokeSignInService";

export interface SignInHostDependencies {
  readonly providers: Pick<ProviderServiceApi, "bootstrap" | "probe">;
}

/** The instances whose sign-in is the provider's own app, never an API key. */
function instancesFor(
  kind: HubSignInKind,
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<ProviderInstance> {
  return instances.filter((instance) =>
    kind === "claude-subscription"
      ? instance.driverKind === "claude" && instance.configuration.authentication === "subscription"
      : instance.driverKind === "codex",
  );
}

export function createSignInHostPorts(deps: SignInHostDependencies): SignInHostPorts {
  return {
    accountState: async (kind): Promise<SignInAccountState> => {
      const snapshot = await deps.providers.bootstrap(HOST_WINDOW_ID);
      const candidates = instancesFor(kind, snapshot.instances).filter(
        (instance) => instance.enabled,
      );
      if (candidates.length === 0) return "unavailable";
      let answered = false;
      for (const instance of candidates) {
        const observed = await deps.providers.probe(HOST_WINDOW_ID, instance.id);
        if (observed.readiness === "ready") return "signed-in";
        if (observed.readiness === "unauthenticated") answered = true;
      }
      return answered ? "signed-out" : "unavailable";
    },
  };
}
