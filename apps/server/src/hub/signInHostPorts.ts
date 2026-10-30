// What this host can say about a provider account, for hub-started sign-in. It
// only reads: it asks the provider registry whether the provider's own app is
// signed in, the same probe Settings' "check the connection" runs. It never runs
// a sign-in, never reads a token, and a probe that cannot answer counts as
// unavailable rather than signed in.

import type { HubSignInKind, ProviderInstance } from "@octant/contracts";
import {
  CODEX_ACCOUNT_PROFILE,
  formatClaudeAuthLoginCommand,
  formatProviderAccountSignInCommand,
} from "@octant/domain";
import type { ProviderServiceApi } from "../providers/providerService";
import { HOST_WINDOW_ID } from "./provisionHostPorts";
import type { SignInAccountState, SignInHostPorts } from "./spokeSignInService";

export interface SignInHostDependencies {
  readonly providers: Pick<ProviderServiceApi, "bootstrap" | "probe">;
}

/** The enabled instances whose sign-in is the provider's own app, never an API key. */
function instancesFor(
  kind: HubSignInKind,
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<ProviderInstance> {
  return instances.filter(
    (instance) =>
      instance.enabled &&
      (kind === "claude-subscription"
        ? instance.driverKind === "claude" &&
          instance.configuration.authentication === "subscription"
        : instance.driverKind === "codex"),
  );
}

/**
 * The provider's own sign-in command for this instance, naming its binary and
 * its isolated account directory exactly as Provider Settings does, so the
 * person signs in to the account this host will use.
 */
function signInCommandFor(instance: ProviderInstance): string | undefined {
  if (instance.driverKind === "claude") {
    return formatClaudeAuthLoginCommand({
      binaryPath: instance.configuration.binaryPath,
      ...(instance.configuration.configDirectory === undefined
        ? {}
        : { configDirectory: instance.configuration.configDirectory }),
    });
  }
  if (instance.driverKind === "codex") {
    return formatProviderAccountSignInCommand({
      profile: CODEX_ACCOUNT_PROFILE,
      binaryPath: instance.configuration.binaryPath,
      ...(instance.configuration.codexHome === undefined
        ? {}
        : { stateDirectory: instance.configuration.codexHome }),
    });
  }
  return undefined;
}

export function createSignInHostPorts(deps: SignInHostDependencies): SignInHostPorts {
  return {
    accountState: async (kind): Promise<SignInAccountState> => {
      const snapshot = await deps.providers.bootstrap(HOST_WINDOW_ID);
      const candidates = instancesFor(kind, snapshot.instances);
      if (candidates.length === 0) return "unavailable";
      let answered = false;
      for (const instance of candidates) {
        const observed = await deps.providers.probe(HOST_WINDOW_ID, instance.id);
        // Ready is not a plan sign-in: Codex is also ready with an API key or a
        // custom model provider that needs no OpenAI login.
        if (observed.readiness === "ready" && observed.accountAuthentication === "subscription") {
          return "signed-in";
        }
        if (
          observed.readiness === "unauthenticated" ||
          (observed.readiness === "ready" && observed.accountAuthentication !== undefined)
        ) {
          answered = true;
        }
      }
      return answered ? "signed-out" : "unavailable";
    },
    signInCommand: async (kind) => {
      const snapshot = await deps.providers.bootstrap(HOST_WINDOW_ID);
      const [instance] = instancesFor(kind, snapshot.instances);
      return instance === undefined ? undefined : signInCommandFor(instance);
    },
  };
}
