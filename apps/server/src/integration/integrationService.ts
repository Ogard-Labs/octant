import type {
  IntegrationAuthenticationCommand,
  IntegrationAuthenticationSnapshot,
  IntegrationCommand,
  IntegrationExecutionResult,
} from "@octant/contracts/integration";
import {
  decodeIntegrationAuthenticationSnapshot,
  decodeIntegrationExecutionResult,
} from "@octant/contracts/integration";
import type { IntegrationHostPort, IntegrationRuntime } from "@octant/plugin-api/integration";
import { createIntegrationHostPort } from "./integrationHostPort";
import { constructIntegrationRuntime } from "./integrationLoader";
import { createIntegrationOAuthHost, type IntegrationOAuthHost } from "./integrationOAuth";
import type { IntegrationConnectionStore } from "./integrationConnectionStore";
import { startLinearOAuthCallbackListener } from "./linearOAuthCallbackListener";
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
  readonly executeOperation: (
    pluginSlug: string,
    command: Extract<IntegrationCommand, { kind: "operation" }>,
    signal: AbortSignal,
  ) => Promise<IntegrationExecutionResult>;
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

const LINEAR_SLUG = "linear";
const UNAVAILABLE_REMEDIATION = "That integration is not available on this host.";

const firstPartyIntegrationFactories = {
  linear: (config: LinearIntegrationConfig) => (hostPort: IntegrationHostPort) =>
    createLinearIntegration(hostPort, config),
} as const;

export function createLinearIntegrationService(options: {
  readonly vault: IntegrationSecretVault;
  readonly config: LinearIntegrationConfig;
  readonly fetch?: (input: Request) => Promise<Response>;
  readonly now?: () => number;
  readonly connectionStore?: IntegrationConnectionStore;
  readonly startCallbackListener?: boolean;
  readonly isEffective?: () => boolean;
}): IntegrationService {
  let bound: IntegrationService | undefined;

  const ensureBound = (pluginSlug: string): IntegrationService | undefined => {
    if (pluginSlug !== LINEAR_SLUG) return undefined;
    if (options.isEffective?.() === false) return undefined;
    bound ??= constructLinearBoundService(options);
    return bound;
  };

  return {
    snapshot: async (pluginSlug, signal) => {
      const service = ensureBound(pluginSlug);
      if (service === undefined) return unavailableAuthentication();
      return service.snapshot(pluginSlug, signal);
    },
    execute: async (pluginSlug, command, signal) => {
      const service = ensureBound(pluginSlug);
      if (service === undefined) return unavailableAuthentication();
      return service.execute(pluginSlug, command, signal);
    },
    executeOperation: async (pluginSlug, command, signal) => {
      const service = ensureBound(pluginSlug);
      if (service === undefined) return unavailableOperation();
      return service.executeOperation(pluginSlug, command, signal);
    },
    completeAuthorization: async (pluginSlug, request) => {
      const service = ensureBound(pluginSlug);
      if (service === undefined) return { kind: "refused", reason: UNAVAILABLE_REMEDIATION };
      return service.completeAuthorization(pluginSlug, request);
    },
    putSecret: async (pluginSlug, scope, secret) => {
      const service = ensureBound(pluginSlug);
      if (service === undefined) return { kind: "unavailable", reason: UNAVAILABLE_REMEDIATION };
      return service.putSecret(pluginSlug, scope, secret);
    },
    deleteSecret: async (pluginSlug, scope) => {
      const service = ensureBound(pluginSlug);
      if (service === undefined) return;
      await service.deleteSecret(pluginSlug, scope);
    },
  };
}

function constructLinearBoundService(options: {
  readonly vault: IntegrationSecretVault;
  readonly config: LinearIntegrationConfig;
  readonly fetch?: (input: Request) => Promise<Response>;
  readonly now?: () => number;
  readonly connectionStore?: IntegrationConnectionStore;
  readonly startCallbackListener?: boolean;
}): IntegrationService {
  const oauth = createIntegrationOAuthHost({
    vault: options.vault,
    credentialIds: LINEAR_CREDENTIAL_IDS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.connectionStore === undefined ? {} : { connectionStore: options.connectionStore }),
    ...(options.startCallbackListener === false
      ? {}
      : {
          startCallbackListener: ({ onAuthorize }) =>
            startLinearOAuthCallbackListener({ onAuthorize }),
        }),
  });
  const hostPort = createIntegrationHostPort({
    fetch: oauth.authorizedFetch,
    requestCredential: oauth.requestCredential,
    beginPkceAuthorization: oauth.beginPkceAuthorization,
    refreshPkceAuthorization: oauth.refreshPkceAuthorization,
    revokeCredential: oauth.revokeCredential,
  });
  const loaded = constructIntegrationRuntime(
    firstPartyIntegrationFactories.linear(options.config),
    hostPort,
    LINEAR_SLUG,
  );
  if (loaded.kind !== "loaded") {
    throw new Error("Linear integration failed to load.");
  }
  return createBoundService(LINEAR_SLUG, loaded.runtime, oauth);
}

function unavailableAuthentication(): IntegrationAuthenticationSnapshot {
  return decodeIntegrationAuthenticationSnapshot({
    state: "unavailable",
    capabilities: [],
    remediation: UNAVAILABLE_REMEDIATION,
  });
}

function unavailableOperation(): IntegrationExecutionResult {
  return decodeIntegrationExecutionResult({
    kind: "refused",
    reason: UNAVAILABLE_REMEDIATION,
  });
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
    executeOperation: async (pluginSlug, command, signal) => {
      if (!requireLinear(pluginSlug)) {
        return decodeIntegrationExecutionResult({
          kind: "refused",
          reason: "That integration is not available on this host.",
        });
      }
      const observation = await runtime.execute(command, signal);
      if (observation.kind !== "operation") {
        return decodeIntegrationExecutionResult({
          kind: "failed",
          reason: "Linear issue browse is unavailable.",
          retryable: false,
        });
      }
      return decodeIntegrationExecutionResult(observation.result);
    },
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
