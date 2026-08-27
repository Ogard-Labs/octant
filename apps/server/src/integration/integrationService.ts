import type {
  IntegrationAuthenticationCommand,
  IntegrationAuthenticationSnapshot,
} from "@octant/contracts/integration";
import { decodeIntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import type { IntegrationRuntime } from "@octant/plugin-api/integration";
import { createIntegrationHostPort } from "./integrationHostPort";
import { constructIntegrationRuntime } from "./integrationLoader";
import { createIntegrationOAuthHost, type IntegrationOAuthHost } from "./integrationOAuth";
import type { IntegrationConnectionStore } from "./integrationConnectionStore";
import type { IntegrationSecretVault } from "./integrationCredentialVault";
import { LINEAR_CREDENTIAL_IDS } from "./linearCredentialIds";
import {
  createLinearIntegration,
  type LinearIntegrationConfig,
} from "../plugins/linear/linearIntegration";

export interface IntegrationService {
  readonly snapshot: (
    pluginSlug: string,
    signal: AbortSignal,
  ) => Promise<IntegrationAuthenticationSnapshot>;
  readonly execute: (
    pluginSlug: string,
    command: IntegrationAuthenticationCommand,
    signal: AbortSignal,
  ) => Promise<IntegrationAuthenticationSnapshot>;
  readonly completeAuthorization: (
    pluginSlug: string,
    request: { readonly state: string; readonly code: string },
  ) => Promise<{ readonly kind: "stored" } | { readonly kind: "refused"; readonly reason: string }>;
  readonly putSecret: (
    pluginSlug: string,
    scope: "personal-api-key",
    secret: string,
  ) => Promise<
    { readonly kind: "stored" } | { readonly kind: "unavailable"; readonly reason: string }
  >;
  readonly deleteSecret: (pluginSlug: string, scope: "personal-api-key") => Promise<void>;
}

export function createLinearIntegrationService(options: {
  readonly vault: IntegrationSecretVault;
  readonly config: LinearIntegrationConfig;
  readonly fetch?: (input: Request) => Promise<Response>;
  readonly now?: () => number;
  readonly connectionStore?: IntegrationConnectionStore;
}): IntegrationService {
  const oauth = createIntegrationOAuthHost({
    vault: options.vault,
    credentialIds: LINEAR_CREDENTIAL_IDS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.connectionStore === undefined ? {} : { connectionStore: options.connectionStore }),
  });
  const hostPort = createIntegrationHostPort({
    fetch: oauth.authorizedFetch,
    requestCredential: oauth.requestCredential,
    beginPkceAuthorization: oauth.beginPkceAuthorization,
    refreshPkceAuthorization: oauth.refreshPkceAuthorization,
    revokeCredential: oauth.revokeCredential,
  });
  const loaded = constructIntegrationRuntime(
    (port: typeof hostPort) => createLinearIntegration(port, options.config),
    hostPort,
    "linear",
  );
  if (loaded.kind !== "loaded") {
    throw new Error("Linear integration failed to load.");
  }
  const runtime = loaded.runtime;
  return createBoundService("linear", runtime, oauth);
}

function createBoundService(
  slug: string,
  runtime: IntegrationRuntime,
  oauth: IntegrationOAuthHost,
): IntegrationService {
  const requireLinear = (pluginSlug: string): boolean => pluginSlug === slug;

  const observationToSnapshot = async (
    pluginSlug: string,
    command: { readonly kind: "authenticate"; readonly command: IntegrationAuthenticationCommand },
    signal: AbortSignal,
    execute: boolean,
  ): Promise<IntegrationAuthenticationSnapshot> => {
    if (!requireLinear(pluginSlug)) {
      return decodeIntegrationAuthenticationSnapshot({
        state: "unavailable",
        capabilities: [],
        remediation: "That integration is not available on this host.",
      });
    }
    const observation = execute
      ? await runtime.execute(command, signal)
      : await runtime.observe(command, signal);
    if (observation.kind !== "authentication") {
      return decodeIntegrationAuthenticationSnapshot({
        state: "unavailable",
        capabilities: [],
        remediation: "Linear authentication is unavailable.",
      });
    }
    if (observation.snapshot.account !== undefined && observation.snapshot.state === "ready") {
      oauth.recordAccount(
        observation.snapshot.account,
        observation.snapshot.account.source === "personal-api-key" ? "personal-api-key" : "oauth",
      );
    }
    return decodeIntegrationAuthenticationSnapshot(observation.snapshot);
  };

  return {
    snapshot: (pluginSlug, signal) =>
      observationToSnapshot(
        pluginSlug,
        { kind: "authenticate", command: { kind: "refresh" } },
        signal,
        false,
      ),
    execute: (pluginSlug, command, signal) =>
      observationToSnapshot(pluginSlug, { kind: "authenticate", command }, signal, true),
    completeAuthorization: async (pluginSlug, request) => {
      if (!requireLinear(pluginSlug)) {
        return { kind: "refused", reason: "That integration is not available on this host." };
      }
      return oauth.completePkceAuthorization(request);
    },
    putSecret: async (pluginSlug, scope, secret) => {
      if (!requireLinear(pluginSlug)) {
        return { kind: "unavailable", reason: "That integration is not available on this host." };
      }
      return oauth.putSecret(scope, secret);
    },
    deleteSecret: async (pluginSlug, scope) => {
      if (!requireLinear(pluginSlug)) return;
      await oauth.deleteSecret(scope);
    },
  };
}
