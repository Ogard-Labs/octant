import {
  decodeProviderInstanceId,
  type AgentEligibleModelRef,
  type AnthropicCompatibleProviderConfiguration,
  type AzureFoundryProviderConfiguration,
  type ClaudeProviderConfiguration,
  type DevinProviderConfiguration,
  type GrokProviderConfiguration,
  type GlmProviderConfiguration,
  type GooseProviderConfiguration,
  type KiloProviderConfiguration,
  type MistralVibeProviderConfiguration,
  type GeminiImageProviderConfiguration,
  type OpenAiCompatibleProviderConfiguration,
  type OpenAiImageProviderConfiguration,
  type OllamaProviderConfiguration,
  type OhMyPiProviderConfiguration,
  type PiProviderConfiguration,
  type PermissionPersistence,
  type ProviderDefaults,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderAuthenticationAttempt,
  type ProviderObservedState,
  type ProviderInstance,
  type ProviderRegistryCommand,
  type ProviderRegistryCommandResult,
  type ProviderRegistrySnapshot,
} from "@octant/contracts";
import { createProviderClient, type ProviderClient } from "@octant/client-runtime/provider-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getInjectedHostBridge,
  type OctantHostBridge,
  type ProviderCredentialStatus,
} from "../shell/hostBridge";

export type ProviderControllerStatus = "loading" | "ready" | "disconnected";

export interface ProviderControllerOptions {
  readonly client?: ProviderClient;
  readonly hostBridge?: OctantHostBridge;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export interface TransientProviderCredential {
  readonly value: string;
  readonly clear: () => void;
}

const emptyDefaults: ProviderDefaults = {
  permissionPersistence: "current-session",
  version: 0 as ProviderDefaults["version"],
};
const settledMutationQueue = Promise.resolve();

function findProvider(current: ProviderRegistrySnapshot, instanceId: ProviderInstanceId) {
  return current.instances.find((instance) => instance.id === instanceId);
}

function configurationAuthentication(instance: ProviderInstance): string | undefined {
  return "authentication" in instance.configuration
    ? instance.configuration.authentication
    : undefined;
}

function usesSubscriptionAuthentication(instance: ProviderInstance): boolean {
  return configurationAuthentication(instance) === "subscription";
}

export function useProviderController(options: ProviderControllerOptions) {
  const hostBridge =
    options.hostBridge ??
    (typeof window === "undefined" ? undefined : getInjectedHostBridge(window));
  const fallbackClient = useMemo(
    () =>
      options.serverUrl !== undefined && options.windowCapability !== undefined
        ? createProviderClient({
            baseUrl: options.serverUrl,
            fetch: globalThis.fetch,
            windowCapability: options.windowCapability,
          })
        : undefined,
    [options.serverUrl, options.windowCapability],
  );
  const client = options.client ?? fallbackClient;
  const mounted = useRef(true);
  const authoritative = useRef<ProviderRegistrySnapshot | undefined>(undefined);
  const mutationQueue = useRef(settledMutationQueue);
  const credentialCleanupRequired = useRef<Set<ProviderInstanceId>>(new Set());
  const credentialStatusUnconfirmed = useRef<Set<ProviderInstanceId>>(new Set());
  const [snapshot, setSnapshot] = useState<ProviderRegistrySnapshot>();
  const [status, setStatus] = useState<ProviderControllerStatus>("loading");
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [probingIds, setProbingIds] = useState<ReadonlySet<ProviderInstanceId>>(new Set());

  const install = useCallback((value: ProviderRegistrySnapshot) => {
    for (const instanceId of credentialStatusUnconfirmed.current) {
      const instance = findProvider(value, instanceId);
      if (instance === undefined || !usesSubscriptionAuthentication(instance)) {
        credentialStatusUnconfirmed.current.delete(instanceId);
      }
    }
    authoritative.current = value;
    if (!mounted.current) return;
    setSnapshot(value);
    setStatus("ready");
  }, []);

  const load = useCallback(async () => {
    if (client === undefined) {
      setStatus("disconnected");
      setMessage("Provider authority is unavailable for this window.");
      return false;
    }
    setStatus("loading");
    const cleanupIds = [...credentialCleanupRequired.current];
    const cleanupAttempted = cleanupIds.length > 0;
    let statusVerificationCompleted = false;
    let cleanupFailed = credentialCleanupRequired.current.size > 0 && hostBridge === undefined;
    let statusUnconfirmed =
      credentialStatusUnconfirmed.current.size > 0 && hostBridge === undefined;
    if (hostBridge !== undefined) {
      const cleanupResults = await Promise.all(
        cleanupIds.map(async (instanceId) => {
          try {
            await hostBridge.clearProviderCredential(instanceId);
            credentialCleanupRequired.current.delete(instanceId);
            return true;
          } catch {
            return false;
          }
        }),
      );
      cleanupFailed = cleanupResults.some((cleaned) => !cleaned);
    }
    try {
      const loaded = await client.bootstrap();
      if (hostBridge !== undefined) {
        const subscriptionProviders = loaded.instances.filter(usesSubscriptionAuthentication);
        const credentialStatuses = await Promise.all(
          subscriptionProviders.map(async (instance) => {
            try {
              return await hostBridge.providerCredentialStatus(instance.id);
            } catch {
              return "unavailable" as const;
            }
          }),
        );
        for (const [index, status] of credentialStatuses.entries()) {
          const instanceId = subscriptionProviders[index]!.id;
          if (status === "stored") {
            credentialCleanupRequired.current.add(instanceId);
            credentialStatusUnconfirmed.current.delete(instanceId);
            cleanupFailed = true;
          } else if (status === "missing") {
            credentialCleanupRequired.current.delete(instanceId);
            statusVerificationCompleted =
              credentialStatusUnconfirmed.current.delete(instanceId) || statusVerificationCompleted;
          } else {
            credentialStatusUnconfirmed.current.add(instanceId);
            statusUnconfirmed = true;
          }
        }
      }
      install(loaded);
      if (statusUnconfirmed) {
        setMessage(
          "Provider credential status could not be verified. Retry from the Octant host before removing this provider.",
        );
      } else if (cleanupFailed) {
        setMessage(
          "Stored provider credential cleanup is still required. Retry cleanup or remove the provider from the Octant host.",
        );
      } else if (cleanupAttempted) {
        setMessage(
          "Stored provider credential cleanup completed. Review the provider before retrying.",
        );
      } else if (statusVerificationCompleted) {
        setMessage("Provider credential status was verified. Review the provider before retrying.");
      } else {
        setMessage(undefined);
      }
      return !cleanupFailed && !statusUnconfirmed;
    } catch (error) {
      if (mounted.current) {
        setStatus("disconnected");
        setMessage(failureMessage(error));
      }
      return false;
    }
  }, [client, hostBridge, install]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const recoverRegistryFailure = useCallback(
    async (error: unknown, fixedMessage?: string) => {
      if (client === undefined) return;
      // For invalid-configuration errors (domain policy rejections), surface
      // the actionable domain text (e.g. "Azure AI Foundry base URL must end
      // with the /openai/v1/ path.") alongside the fixed message so the user
      // knows which field to fix. Other error categories keep the fixed
      // message only to avoid leaking internal diagnostics.
      const domainDetail = domainValidationMessage(error);
      const message =
        fixedMessage === undefined
          ? failureMessage(error)
          : domainDetail.length > 0
            ? `${fixedMessage} ${domainDetail}`
            : fixedMessage;
      try {
        install(await client.bootstrap());
        if (mounted.current) {
          setMessage(
            `${message} Loaded authoritative provider state; review the result before retrying.`,
          );
        }
      } catch {
        if (mounted.current) {
          setStatus("disconnected");
          setMessage(message);
        }
      }
    },
    [client, install],
  );

  const execute = useCallback(
    (build: (current: ProviderRegistrySnapshot) => ProviderRegistryCommand | undefined) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, async () => {
        if (client === undefined || authoritative.current === undefined) return false;
        const command = build(authoritative.current);
        if (command === undefined) return false;
        try {
          applyResult(await client.execute(command), authoritative.current, install);
          return true;
        } catch (error) {
          await recoverRegistryFailure(error);
          return false;
        }
      }),
    [client, install, recoverRegistryFailure],
  );

  const create = useCallback(
    (
      driverKind: "opencode" | "codex" | "kimi-code" | "devin" | "kilo" | "pi" | "oh-my-pi" | "goose",
      displayName: string,
      binaryPath: string,
    ) =>
      execute(() => {
        const instanceId = decodeProviderInstanceId(crypto.randomUUID());
        const expectedVersion = 0 as ProviderDefaults["version"];
        if (driverKind === "devin") {
          return {
            kind: "create-devin-provider",
            instanceId,
            expectedVersion,
            displayName,
            configuration: {
              kind: "devin-acp",
              binaryPath,
              authentication: "subscription",
            },
          };
        }
        if (driverKind === "pi") {
          return {
            kind: "create-pi-provider",
            instanceId,
            expectedVersion,
            displayName,
            configuration: { kind: "pi-rpc", binaryPath },
          };
        }
        if (driverKind === "oh-my-pi") {
          return {
            kind: "create-oh-my-pi-provider",
            instanceId,
            expectedVersion,
            displayName,
            configuration: {
              kind: "oh-my-pi-rpc",
              binaryPath,
              // Discovery and create share the pinned version used by the fail-closed probe.
              supportedVersion: "17.2.1",
            },
          };
        }
        if (driverKind === "kilo") {
          return {
            kind: "create-kilo-provider",
            instanceId,
            expectedVersion,
            displayName,
            configuration: { kind: "kilo-acp", binaryPath },
          };
        }
        if (driverKind === "goose") {
          return {
            kind: "create-goose-provider",
            instanceId,
            expectedVersion,
            displayName,
            configuration: { kind: "goose-acp", binaryPath },
          };
        }
        return {
          kind:
            driverKind === "opencode"
              ? "create-opencode-provider"
              : driverKind === "codex"
                ? "create-codex-provider"
                : "create-kimi-code-provider",
          instanceId,
          expectedVersion,
          displayName,
          binaryPath,
        };
      }),
    [execute],
  );
  const createOpenAiCompatible = useCallback(
    (
      displayName: string,
      configuration: OpenAiCompatibleProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          try {
            applyResult(
              await client.execute({
                kind: "create-openai-compatible-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be created.");
            return false;
          }
          if (configuration.authentication !== "bearer" || credentialValue.length === 0) {
            return true;
          }
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          try {
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch {
            if (mounted.current) {
              setMessage("The provider was created, but its credential could not be stored.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const createAnthropicCompatible = useCallback(
    (
      displayName: string,
      configuration: AnthropicCompatibleProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          try {
            applyResult(
              await client.execute({
                kind: "create-anthropic-compatible-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be created.");
            return false;
          }
          if (configuration.authentication === "none" || credentialValue.length === 0) {
            return true;
          }
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          try {
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch {
            if (mounted.current) {
              setMessage("The provider was created, but its credential could not be stored.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const createAzureFoundry = useCallback(
    (
      displayName: string,
      configuration: AzureFoundryProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          // Foundry requires an API key, so report unavailable credential
          // management before asking for a key the user cannot enter on
          // browser/remote hosts where the Keychain bridge is absent.
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          if (credentialValue.length === 0) {
            if (mounted.current) {
              setMessage("Enter an Azure AI Foundry API key before creating this provider.");
            }
            return false;
          }
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          try {
            applyResult(
              await client.execute({
                kind: "create-azure-foundry-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be created.");
            return false;
          }
          try {
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch {
            if (mounted.current) {
              setMessage("The provider was created, but its credential could not be stored.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const createOpenAiImage = useCallback(
    (
      displayName: string,
      configuration: OpenAiImageProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          if (credentialValue.length === 0) {
            if (mounted.current) {
              setMessage("Enter an OpenAI API key before creating this image profile.");
            }
            return false;
          }
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          try {
            applyResult(
              await client.execute({
                kind: "create-openai-image-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be created.");
            return false;
          }
          try {
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch {
            if (mounted.current) {
              setMessage("The provider was created, but its credential could not be stored.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const createGeminiImage = useCallback(
    (
      displayName: string,
      configuration: GeminiImageProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          if (credentialValue.length === 0) {
            if (mounted.current) {
              setMessage("Enter a Gemini API key before creating this image profile.");
            }
            return false;
          }
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          try {
            applyResult(
              await client.execute({
                kind: "create-gemini-native-image-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be created.");
            return false;
          }
          try {
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch {
            if (mounted.current) {
              setMessage("The provider was created, but its credential could not be stored.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const createOllama = useCallback(
    (displayName: string, configuration: OllamaProviderConfiguration) =>
      execute(() => ({
        kind: "create-ollama-provider",
        instanceId: decodeProviderInstanceId(crypto.randomUUID()),
        expectedVersion: 0 as ProviderDefaults["version"],
        displayName,
        configuration,
      })),
    [execute],
  );
  const createClaude = useCallback(
    (
      displayName: string,
      configuration: ClaudeProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          if (configuration.authentication === "api-key" && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          if (configuration.authentication === "api-key" && credentialValue.length === 0) {
            if (mounted.current) {
              setMessage("Enter an Anthropic API key before creating this provider.");
            }
            return false;
          }
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          let created = false;
          try {
            applyResult(
              await client.execute({
                kind: "create-claude-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
            created = true;
            if (configuration.authentication === "api-key") {
              await hostBridge!.setProviderCredential(instanceId, credentialValue);
            }
            return true;
          } catch (error) {
            if (configuration.authentication === "api-key" && created) {
              if (mounted.current) {
                setMessage("The provider was created, but its credential could not be stored.");
              }
            } else {
              await recoverRegistryFailure(error, "Provider configuration could not be created.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const createMistralVibe = useCallback(
    (
      displayName: string,
      configuration: MistralVibeProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          if (configuration.authentication === "api-key" && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          if (configuration.authentication === "api-key" && credentialValue.length === 0) {
            if (mounted.current) {
              setMessage("Enter a Mistral API key before creating this provider.");
            }
            return false;
          }
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          let created = false;
          try {
            applyResult(
              await client.execute({
                kind: "create-mistral-vibe-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
            created = true;
            if (configuration.authentication === "api-key") {
              await hostBridge!.setProviderCredential(instanceId, credentialValue);
            }
            return true;
          } catch (error) {
            if (configuration.authentication === "api-key" && created) {
              if (mounted.current) {
                setMessage("The provider was created, but its credential could not be stored.");
              }
            } else {
              await recoverRegistryFailure(error, "Provider configuration could not be created.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const createGrok = useCallback(
    (
      displayName: string,
      configuration: GrokProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          if (configuration.authentication === "api-key" && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          if (configuration.authentication === "api-key" && credentialValue.length === 0) {
            if (mounted.current) {
              setMessage("Enter an xAI API key before creating this provider.");
            }
            return false;
          }
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          let created = false;
          try {
            applyResult(
              await client.execute({
                kind: "create-grok-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
            created = true;
            if (configuration.authentication === "api-key") {
              await hostBridge!.setProviderCredential(instanceId, credentialValue);
            }
            return true;
          } catch (error) {
            if (configuration.authentication === "api-key" && created) {
              if (mounted.current) {
                setMessage("The provider was created, but its credential could not be stored.");
              }
            } else {
              await recoverRegistryFailure(error, "Provider configuration could not be created.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const createGlm = useCallback(
    (
      displayName: string,
      configuration: GlmProviderConfiguration,
      credential: TransientProviderCredential,
    ) => {
      const instanceId = decodeProviderInstanceId(crypto.randomUUID());
      return queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          if (credentialValue.length === 0) {
            if (mounted.current) {
              setMessage("Enter a Z.AI API key before creating this provider.");
            }
            return false;
          }
          const current = authoritative.current;
          if (client === undefined || current === undefined) return false;
          let created = false;
          try {
            applyResult(
              await client.execute({
                kind: "create-glm-provider",
                instanceId,
                expectedVersion: 0 as ProviderDefaults["version"],
                displayName,
                configuration,
              }),
              current,
              install,
            );
            created = true;
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch (error) {
            if (created) {
              if (mounted.current) {
                setMessage("The provider was created, but its credential could not be stored.");
              }
            } else {
              await recoverRegistryFailure(error, "Provider configuration could not be created.");
            }
            return false;
          }
        }),
      );
    },
    [client, hostBridge, install, recoverRegistryFailure],
  );

  const beginProviderAuthentication = useCallback(
    async (instanceId: ProviderInstanceId): Promise<ProviderAuthenticationAttempt | undefined> => {
      if (client === undefined) return undefined;
      if (mounted.current) {
        setBusy(true);
        setMessage(undefined);
      }
      try {
        const result = await client.execute({
          kind: "begin-provider-authentication",
          instanceId,
        });
        if (result.kind !== "provider-authentication-started") {
          throw new Error("Provider returned an invalid authentication result.");
        }
        return result.attempt;
      } catch (error) {
        if (mounted.current) setMessage(failureMessage(error));
        return undefined;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [client],
  );

  const completeProviderAuthentication = useCallback(
    async (
      instanceId: ProviderInstanceId,
      attemptId: ProviderAuthenticationAttempt["attemptId"],
    ): Promise<boolean> => {
      if (client === undefined) return false;
      if (mounted.current) {
        setBusy(true);
        setMessage(undefined);
      }
      try {
        const result = await client.execute({
          kind: "complete-provider-authentication",
          instanceId,
          attemptId,
        });
        if (result.kind !== "provider-authentication-completed") {
          throw new Error("Provider returned an invalid authentication result.");
        }
        return true;
      } catch (error) {
        if (mounted.current) setMessage(failureMessage(error));
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [client],
  );
  const changeClaudeConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: ClaudeProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (client === undefined || current === undefined || instance?.driverKind !== "claude") {
            return false;
          }
          const previousAuthentication = instance.configuration.authentication;
          const nextAuthentication = configuration.authentication;
          if (
            nextAuthentication === "api-key" &&
            previousAuthentication === "subscription" &&
            credentialValue.length === 0
          ) {
            if (mounted.current) {
              setMessage("Enter an Anthropic API key before switching authentication modes.");
            }
            return false;
          }
          const mustClear =
            previousAuthentication === "api-key" && nextAuthentication === "subscription";
          const mustSet = nextAuthentication === "api-key" && credentialValue.length > 0;
          if ((mustClear || mustSet) && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          // Only credential work needs the desktop bridge. A renderer without
          // one can still edit a binary path or re-save an instance whose key
          // is unchanged, so the requirement stays inside the branches that
          // actually touch the Keychain.
          const bridge = hostBridge;
          // A key is stored before the change that starts using it, but cleared
          // only after the change that stops. The server refuses this command
          // while the instance has an active session, and clearing first left
          // the instance still configured for API-key authentication with no
          // key to connect with and nothing able to put it back.
          if (mustSet && bridge !== undefined) {
            try {
              await bridge.setProviderCredential(instanceId, credentialValue);
            } catch {
              if (mounted.current) {
                setMessage(
                  "The provider credential could not be stored, so the configuration was unchanged.",
                );
              }
              return false;
            }
          }
          try {
            applyResult(
              await client.execute({
                kind: "change-claude-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
            if (mustClear && bridge !== undefined) {
              // The instance no longer uses the key. A clear that fails here
              // leaves a secret behind rather than an unusable provider, so it
              // is retried by the same deferred cleanup the other paths use.
              await bridge
                .clearProviderCredential(instanceId)
                .catch(() => void credentialCleanupRequired.current.add(instanceId));
            }
            return true;
          } catch (error) {
            if (mustSet && previousAuthentication === "subscription" && bridge !== undefined) {
              try {
                await bridge.clearProviderCredential(instanceId);
              } catch {
                try {
                  const refreshed = await client.bootstrap();
                  const refreshedInstance = findProvider(refreshed, instanceId);
                  if (refreshedInstance?.driverKind !== "claude") throw new Error();
                  if (
                    refreshedInstance.configuration.authentication ===
                      configuration.authentication &&
                    refreshedInstance.configuration.binaryPath === configuration.binaryPath
                  ) {
                    install(refreshed);
                  } else {
                    applyResult(
                      await client.execute({
                        kind: "change-claude-configuration",
                        instanceId,
                        expectedVersion: refreshedInstance.version,
                        configuration,
                      }),
                      refreshed,
                      install,
                    );
                  }
                  if (mounted.current) {
                    setMessage(
                      "Provider API-key configuration was saved after credential cleanup could not be confirmed. Check the connection before use.",
                    );
                  }
                  return true;
                } catch (recoveryError) {
                  credentialCleanupRequired.current.add(instanceId);
                  await recoverRegistryFailure(
                    recoveryError,
                    "Stored provider credential cleanup is required. Retry cleanup or remove the provider from the Octant host.",
                  );
                  return false;
                }
              }
            }
            await recoverRegistryFailure(
              error,
              mustClear
                ? "Provider configuration could not be updated, so its credential was left in place."
                : "Provider configuration could not be updated.",
            );
            return false;
          }
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const changeMistralVibeConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: MistralVibeProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (
            client === undefined ||
            current === undefined ||
            instance?.driverKind !== "mistral-vibe"
          ) {
            return false;
          }
          const previousAuthentication = instance.configuration.authentication;
          const nextAuthentication = configuration.authentication;
          if (
            nextAuthentication === "api-key" &&
            previousAuthentication === "subscription" &&
            credentialValue.length === 0
          ) {
            if (mounted.current) {
              setMessage("Enter a Mistral API key before switching authentication modes.");
            }
            return false;
          }
          const mustClear =
            previousAuthentication === "api-key" && nextAuthentication === "subscription";
          const mustSet = nextAuthentication === "api-key" && credentialValue.length > 0;
          if ((mustClear || mustSet) && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          // Only credential work needs the desktop bridge. A renderer without
          // one can still edit a binary path or re-save an instance whose key
          // is unchanged, so the requirement stays inside the branches that
          // actually touch the Keychain.
          const bridge = hostBridge;
          // A key is stored before the change that starts using it, but cleared
          // only after the change that stops. The server refuses this command
          // while the instance has an active session, and clearing first left
          // the instance still configured for API-key authentication with no
          // key to connect with and nothing able to put it back.
          if (mustSet && bridge !== undefined) {
            try {
              await bridge.setProviderCredential(instanceId, credentialValue);
            } catch {
              if (mounted.current) {
                setMessage(
                  "The provider credential could not be stored, so the configuration was unchanged.",
                );
              }
              return false;
            }
          }
          try {
            applyResult(
              await client.execute({
                kind: "change-mistral-vibe-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
            if (mustClear && bridge !== undefined) {
              // The instance no longer uses the key. A clear that fails here
              // leaves a secret behind rather than an unusable provider, so it
              // is retried by the same deferred cleanup the other paths use.
              await bridge
                .clearProviderCredential(instanceId)
                .catch(() => void credentialCleanupRequired.current.add(instanceId));
            }
            return true;
          } catch (error) {
            if (mustSet && previousAuthentication === "subscription" && bridge !== undefined) {
              try {
                await bridge.clearProviderCredential(instanceId);
              } catch {
                credentialCleanupRequired.current.add(instanceId);
              }
            }
            await recoverRegistryFailure(
              error,
              mustClear
                ? "Provider configuration could not be updated, so its credential was left in place."
                : "Provider configuration could not be updated.",
            );
            return false;
          }
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const changeGrokConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: GrokProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (client === undefined || current === undefined || instance?.driverKind !== "grok") {
            return false;
          }
          const previousAuthentication = instance.configuration.authentication;
          const nextAuthentication = configuration.authentication;
          if (
            nextAuthentication === "api-key" &&
            previousAuthentication === "subscription" &&
            credentialValue.length === 0
          ) {
            if (mounted.current) {
              setMessage("Enter an xAI API key before switching authentication modes.");
            }
            return false;
          }
          const mustClear =
            previousAuthentication === "api-key" && nextAuthentication === "subscription";
          const mustSet = nextAuthentication === "api-key" && credentialValue.length > 0;
          if ((mustClear || mustSet) && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          // Only credential work needs the desktop bridge. A renderer without
          // one can still edit a binary path or re-save an instance whose key
          // is unchanged, so the requirement stays inside the branches that
          // actually touch the Keychain.
          const bridge = hostBridge;
          // A key is stored before the change that starts using it, but cleared
          // only after the change that stops. The server refuses this command
          // while the instance has an active session, and clearing first left
          // the instance still configured for API-key authentication with no
          // key to connect with and nothing able to put it back.
          if (mustSet && bridge !== undefined) {
            try {
              await bridge.setProviderCredential(instanceId, credentialValue);
            } catch {
              if (mounted.current) {
                setMessage(
                  "The provider credential could not be stored, so the configuration was unchanged.",
                );
              }
              return false;
            }
          }
          try {
            applyResult(
              await client.execute({
                kind: "change-grok-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
            if (mustClear && bridge !== undefined) {
              // The instance no longer uses the key. A clear that fails here
              // leaves a secret behind rather than an unusable provider, so it
              // is retried by the same deferred cleanup the other paths use.
              await bridge
                .clearProviderCredential(instanceId)
                .catch(() => void credentialCleanupRequired.current.add(instanceId));
            }
            return true;
          } catch (error) {
            if (mustSet && previousAuthentication === "subscription" && bridge !== undefined) {
              try {
                await bridge.clearProviderCredential(instanceId);
              } catch {
                credentialCleanupRequired.current.add(instanceId);
              }
            }
            await recoverRegistryFailure(
              error,
              mustClear
                ? "Provider configuration could not be updated, so its credential was left in place."
                : "Provider configuration could not be updated.",
            );
            return false;
          }
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const changeGooseConfiguration = useCallback(
    (instanceId: ProviderInstanceId, configuration: GooseProviderConfiguration) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        if (instance?.driverKind !== "goose") return undefined;
        return {
          kind: "change-goose-configuration",
          instanceId,
          expectedVersion: instance.version,
          configuration,
        };
      }),
    [execute],
  );
  const changeGlmConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: GlmProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (client === undefined || current === undefined || instance?.driverKind !== "glm") {
            return false;
          }
          const mustSet = credentialValue.length > 0;
          if (mustSet && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          const bridge = hostBridge;
          if (mustSet && bridge !== undefined) {
            try {
              await bridge.setProviderCredential(instanceId, credentialValue);
            } catch {
              if (mounted.current) {
                setMessage(
                  "The provider credential could not be stored, so the configuration was unchanged.",
                );
              }
              return false;
            }
          }
          try {
            applyResult(
              await client.execute({
                kind: "change-glm-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
            return true;
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be updated.");
            return false;
          }
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const changeDevinConfiguration = useCallback(
    (instanceId: ProviderInstanceId, configuration: DevinProviderConfiguration) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        if (instance?.driverKind !== "devin") return undefined;
        return {
          kind: "change-devin-configuration",
          instanceId,
          expectedVersion: instance.version,
          configuration,
        };
      }),
    [execute],
  );
  const changePiConfiguration = useCallback(
    (instanceId: ProviderInstanceId, configuration: PiProviderConfiguration) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        if (instance?.driverKind !== "pi") return undefined;
        return {
          kind: "change-pi-configuration",
          instanceId,
          expectedVersion: instance.version,
          configuration,
        };
      }),
    [execute],
  );
  const changeOhMyPiConfiguration = useCallback(
    (instanceId: ProviderInstanceId, configuration: OhMyPiProviderConfiguration) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        if (instance?.driverKind !== "oh-my-pi") return undefined;
        return {
          kind: "change-oh-my-pi-configuration",
          instanceId,
          expectedVersion: instance.version,
          configuration,
        };
      }),
    [execute],
  );
  const changeKiloConfiguration = useCallback(
    (instanceId: ProviderInstanceId, configuration: KiloProviderConfiguration) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        if (instance?.driverKind !== "kilo") return undefined;
        return {
          kind: "change-kilo-configuration",
          instanceId,
          expectedVersion: instance.version,
          configuration,
        };
      }),
    [execute],
  );
  const changeOllamaConfiguration = useCallback(
    (instanceId: ProviderInstanceId, configuration: OllamaProviderConfiguration) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        if (instance?.driverKind !== "ollama") return undefined;
        return {
          kind: "change-ollama-configuration",
          instanceId,
          expectedVersion: instance.version,
          configuration,
        };
      }),
    [execute],
  );
  const rename = useCallback(
    (instanceId: ProviderInstanceId, displayName: string) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        return instance === undefined
          ? undefined
          : { kind: "rename-provider", instanceId, expectedVersion: instance.version, displayName };
      }),
    [execute],
  );
  const changeBinary = useCallback(
    (instanceId: ProviderInstanceId, binaryPath: string) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        return instance === undefined
          ? undefined
          : {
              kind: "change-provider-binary",
              instanceId,
              expectedVersion: instance.version,
              binaryPath,
            };
      }),
    [execute],
  );
  const changeOpenAiCompatibleConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: OpenAiCompatibleProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (
            client === undefined ||
            current === undefined ||
            instance?.driverKind !== "openai-compatible"
          ) {
            return false;
          }
          try {
            applyResult(
              await client.execute({
                kind: "change-openai-compatible-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be updated.");
            return false;
          }
          if (configuration.authentication !== "bearer" || credentialValue.length === 0) {
            return true;
          }
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          try {
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch {
            if (mounted.current) {
              setMessage(
                "Provider configuration was saved, but its credential could not be stored.",
              );
            }
            return false;
          }
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const changeOpenAiImageConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: OpenAiImageProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (
            client === undefined ||
            current === undefined ||
            instance?.driverKind !== "openai-image"
          ) {
            return false;
          }
          try {
            applyResult(
              await client.execute({
                kind: "change-openai-image-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be updated.");
            return false;
          }
          if (credentialValue.length === 0) return true;
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          try {
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch {
            if (mounted.current) {
              setMessage(
                "Provider configuration was saved, but its credential could not be stored.",
              );
            }
            return false;
          }
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const changeGeminiImageConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: GeminiImageProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (
            client === undefined ||
            current === undefined ||
            instance?.driverKind !== "gemini-native-image"
          ) {
            return false;
          }
          try {
            applyResult(
              await client.execute({
                kind: "change-gemini-native-image-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be updated.");
            return false;
          }
          if (credentialValue.length === 0) return true;
          if (hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          try {
            await hostBridge.setProviderCredential(instanceId, credentialValue);
            return true;
          } catch {
            if (mounted.current) {
              setMessage(
                "Provider configuration was saved, but its credential could not be stored.",
              );
            }
            return false;
          }
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const changeAnthropicCompatibleConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: AnthropicCompatibleProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (
            client === undefined ||
            current === undefined ||
            instance?.driverKind !== "anthropic-compatible"
          ) {
            return false;
          }
          const previousAuthentication = instance.configuration.authentication;
          const nextAuthentication = configuration.authentication;
          const authChanged = previousAuthentication !== nextAuthentication;
          if (
            authChanged &&
            (nextAuthentication === "api-key" || nextAuthentication === "bearer") &&
            credentialValue.length === 0
          ) {
            if (mounted.current) {
              setMessage("Enter an API key before switching authentication modes.");
            }
            return false;
          }
          const mustClear =
            authChanged &&
            (previousAuthentication === "api-key" || previousAuthentication === "bearer") &&
            nextAuthentication === "none";
          const mustSet =
            (nextAuthentication === "api-key" || nextAuthentication === "bearer") &&
            credentialValue.length > 0;
          if ((mustClear || mustSet) && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          try {
            if (mustClear) await hostBridge!.clearProviderCredential(instanceId);
            if (mustSet) await hostBridge!.setProviderCredential(instanceId, credentialValue);
          } catch {
            if (mounted.current) {
              setMessage(
                mustClear
                  ? "The provider credential could not be cleared, so the authentication change was cancelled."
                  : "The provider credential could not be stored, so the configuration was unchanged.",
              );
            }
            return false;
          }
          try {
            applyResult(
              await client.execute({
                kind: "change-anthropic-compatible-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
            return true;
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be updated.");
            return false;
          }
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const changeAzureFoundryConfiguration = useCallback(
    (
      instanceId: ProviderInstanceId,
      configuration: AzureFoundryProviderConfiguration,
      credential: TransientProviderCredential,
    ) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, () =>
        withTransientCredential(credential, async (credentialValue) => {
          const current = authoritative.current;
          const instance = current === undefined ? undefined : findProvider(current, instanceId);
          if (
            client === undefined ||
            current === undefined ||
            instance?.driverKind !== "azure-foundry"
          ) {
            return false;
          }
          const mustSet = credentialValue.length > 0;
          if (mustSet && hostBridge === undefined) {
            if (mounted.current) {
              setMessage("Provider credential management is unavailable on this host.");
            }
            return false;
          }
          const priorConfiguration = instance.configuration;
          // Validate the configuration server-side before rotating the Keychain credential so a
          // rejected /openai/v1/ URL or stale version leaves the prior key intact.
          try {
            applyResult(
              await client.execute({
                kind: "change-azure-foundry-configuration",
                instanceId,
                expectedVersion: instance.version,
                configuration,
              }),
              current,
              install,
            );
          } catch (error) {
            await recoverRegistryFailure(error, "Provider configuration could not be updated.");
            return false;
          }
          if (mustSet) {
            try {
              await hostBridge!.setProviderCredential(instanceId, credentialValue);
            } catch {
              // The new endpoint is committed but its key could not be stored.
              // Roll back the configuration so the prior endpoint and prior key
              // stay paired instead of leaving a new endpoint with a stale key.
              const rolledBackCurrent = authoritative.current;
              const rolledBackInstance =
                rolledBackCurrent === undefined
                  ? undefined
                  : findProvider(rolledBackCurrent, instanceId);
              let rollbackConfirmed = false;
              if (
                rolledBackCurrent !== undefined &&
                rolledBackInstance !== undefined &&
                rolledBackInstance.driverKind === "azure-foundry"
              ) {
                try {
                  applyResult(
                    await client.execute({
                      kind: "change-azure-foundry-configuration",
                      instanceId,
                      expectedVersion: rolledBackInstance.version,
                      configuration: priorConfiguration,
                    }),
                    rolledBackCurrent,
                    install,
                  );
                  rollbackConfirmed = true;
                } catch {
                  // Best-effort rollback failed; the saved config may still
                  // point at the new endpoint with the old key.
                }
              }
              if (mounted.current) {
                setMessage(
                  rollbackConfirmed
                    ? "The new API key could not be stored. The configuration was rolled back; the prior endpoint and key remain active."
                    : "The new API key could not be stored and the automatic rollback could not be confirmed. Reload Settings to verify the saved endpoint and re-enter the API key.",
                );
              }
              return false;
            }
          }
          return true;
        }),
      ),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const setEnabled = useCallback(
    (instanceId: ProviderInstanceId, enabled: boolean) =>
      execute((current) => {
        const instance = findProvider(current, instanceId);
        return instance === undefined
          ? undefined
          : {
              kind: "set-provider-enabled",
              instanceId,
              expectedVersion: instance.version,
              enabled,
            };
      }),
    [execute],
  );
  const remove = useCallback(
    (instanceId: ProviderInstanceId) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, async () => {
        const current = authoritative.current;
        const instance = current === undefined ? undefined : findProvider(current, instanceId);
        if (client === undefined || current === undefined || instance === undefined) return false;
        if (credentialStatusUnconfirmed.current.has(instanceId)) {
          if (mounted.current) {
            setMessage(
              "Provider credential status could not be verified. Retry from the Octant host before removing this provider.",
            );
          }
          return false;
        }
        const mustClear =
          instance.driverKind === "openai-compatible" ||
          instance.driverKind === "azure-foundry" ||
          instance.driverKind === "openai-image" ||
          instance.driverKind === "gemini-native-image" ||
          (instance.driverKind === "anthropic-compatible" &&
            (instance.configuration.authentication === "api-key" ||
              instance.configuration.authentication === "bearer" ||
              credentialCleanupRequired.current.has(instanceId))) ||
          configurationAuthentication(instance) === "api-key" ||
          (usesSubscriptionAuthentication(instance) &&
            credentialCleanupRequired.current.has(instanceId));
        // Only credential-bearing instances need the desktop bridge, so the
        // requirement stays inside the branches that actually touch the
        // Keychain.
        const bridge = hostBridge;
        if (mustClear && bridge === undefined) {
          if (mounted.current) {
            setMessage("Provider credential management is unavailable on this host.");
          }
          return false;
        }
        try {
          applyResult(
            await client.execute({
              kind: "remove-provider",
              instanceId,
              expectedVersion: instance.version,
            }),
            current,
            install,
          );
        } catch (error) {
          // The server refuses this command while the instance has an active
          // session. Clearing first left a still-configured API-key instance
          // with no key to connect with and nothing able to put it back, so
          // the key is only removed once the instance is gone.
          await recoverRegistryFailure(error, "Provider removal failed.");
          return false;
        }
        if (mustClear && bridge !== undefined) {
          // The instance no longer exists. A clear that fails here leaves a
          // secret behind rather than an unusable provider, so it is retried
          // by the same deferred cleanup the other paths use.
          try {
            await bridge.clearProviderCredential(instanceId);
            credentialCleanupRequired.current.delete(instanceId);
          } catch {
            credentialCleanupRequired.current.add(instanceId);
            if (mounted.current) {
              setMessage(
                "The provider was removed, but its stored credential could not be cleared. Retry cleanup from the Octant host.",
              );
            }
          }
        }
        return true;
      }),
    [client, hostBridge, install, recoverRegistryFailure],
  );
  const providerCredentialStatus = useCallback(
    async (instanceId: ProviderInstanceId): Promise<ProviderCredentialStatus> => {
      if (hostBridge === undefined) return "unavailable";
      try {
        return await hostBridge.providerCredentialStatus(instanceId);
      } catch {
        return "unavailable";
      }
    },
    [hostBridge],
  );
  const clearProviderCredential = useCallback(
    (instanceId: ProviderInstanceId) =>
      queueProviderMutation(mutationQueue, mounted, setBusy, setMessage, async () => {
        if (hostBridge === undefined) {
          if (mounted.current) {
            setMessage("Provider credential management is unavailable on this host.");
          }
          return false;
        }
        try {
          await hostBridge.clearProviderCredential(instanceId);
          return true;
        } catch {
          if (mounted.current) setMessage("The provider credential could not be cleared.");
          return false;
        }
      }),
    [hostBridge],
  );
  const updatePermissionPersistence = useCallback(
    (permissionPersistence: PermissionPersistence) =>
      execute((current) => ({
        kind: "update-provider-defaults",
        expectedVersion: current.defaults.version,
        permissionPersistence,
      })),
    [execute],
  );
  const updateProviderOrder = useCallback(
    (providerOrder: ReadonlyArray<ProviderInstanceId>) =>
      execute((current) => ({
        kind: "update-provider-defaults",
        expectedVersion: current.defaults.version,
        permissionPersistence: current.defaults.permissionPersistence,
        providerOrder,
      })),
    [execute],
  );
  // Settings-defined default agent-eligible pool. Membership is a
  // selection default only: it never configures credentials, activates a
  // provider, or widens authority. An empty list clears the stored pool.
  const updateAgentEligibleModels = useCallback(
    (agentEligibleModels: ReadonlyArray<AgentEligibleModelRef>) =>
      execute((current) => ({
        kind: "update-provider-defaults",
        expectedVersion: current.defaults.version,
        permissionPersistence: current.defaults.permissionPersistence,
        agentEligibleModels,
      })),
    [execute],
  );
  const probe = useCallback(
    async (instanceId: ProviderInstanceId) => {
      if (client === undefined) return false;
      const current = authoritative.current;
      if (current !== undefined) {
        install({
          ...current,
          observedStates: current.observedStates.filter((value) => value.instanceId !== instanceId),
        });
      }
      setProbingIds((current) => new Set(current).add(instanceId));
      setMessage(undefined);
      try {
        const observed = await client.probe(instanceId);
        const current = authoritative.current;
        if (current !== undefined) {
          install({
            ...current,
            observedStates: [
              ...current.observedStates.filter((value) => value.instanceId !== instanceId),
              observed,
            ],
          });
        }
        return true;
      } catch (error) {
        try {
          install(await client.bootstrap());
        } catch {
          // The locally cleared snapshot remains fail-closed when authority is unavailable.
        }
        if (mounted.current) setMessage(redactedProbeFailureMessage(error));
        return false;
      } finally {
        if (mounted.current) {
          setProbingIds((current) => {
            const next = new Set(current);
            next.delete(instanceId);
            return next;
          });
        }
      }
    },
    [client, install],
  );

  const verifyFoundryTools = useCallback(
    async (instanceId: ProviderInstanceId, modelId: ProviderModelId) => {
      if (client === undefined) return false;
      setProbingIds((current) => new Set(current).add(instanceId));
      setMessage(undefined);
      try {
        const result = await client.execute({
          kind: "verify-foundry-tools",
          instanceId,
          modelId,
        });
        if (result.kind === "foundry-tools-verified") {
          const current = authoritative.current;
          if (current !== undefined) {
            install({
              ...current,
              observedStates: current.observedStates.map((state) => {
                if (state.instanceId !== instanceId) return state;
                const priorVerified = state.verifiedToolModelIds ?? [];
                const verifiedToolModelIds =
                  result.appManagedTools === "supported"
                    ? [...new Set([...priorVerified, String(modelId)])].map(
                        (id) => id as ProviderModelId,
                      )
                    : priorVerified.filter((id) => String(id) !== String(modelId));
                return { ...state, verifiedToolModelIds };
              }),
            });
          }
          if (mounted.current) {
            setMessage(
              result.appManagedTools === "supported"
                ? "Azure AI Foundry deployment supports Octant-managed tools."
                : "Azure AI Foundry deployment does not support Octant-managed tools.",
            );
          }
          return true;
        }
        return false;
      } catch (error) {
        if (mounted.current) setMessage(redactedProbeFailureMessage(error));
        return false;
      } finally {
        if (mounted.current) {
          setProbingIds((current) => {
            const next = new Set(current);
            next.delete(instanceId);
            return next;
          });
        }
      }
    },
    [client, install],
  );

  return {
    status,
    snapshot,
    instances: snapshot?.instances ?? [],
    readInstances: () => authoritative.current?.instances ?? [],
    defaults: snapshot?.defaults ?? emptyDefaults,
    observedByInstance: new Map(
      snapshot?.observedStates.map((value) => [value.instanceId, value] as const) ?? [],
    ) as ReadonlyMap<ProviderInstanceId, ProviderObservedState>,
    busy,
    probingIds,
    credentialManagementAvailable: hostBridge !== undefined,
    ...(message === undefined ? {} : { message }),
    retry: load,
    create,
    createClaude,
    createMistralVibe,
    createGrok,
    createGlm,
    createOllama,
    createOpenAiCompatible,
    createAnthropicCompatible,
    createAzureFoundry,
    createOpenAiImage,
    createGeminiImage,
    rename,
    changeBinary,
    changeClaudeConfiguration,
    changeDevinConfiguration,
    changeKiloConfiguration,
    changePiConfiguration,
    changeOhMyPiConfiguration,
    changeOllamaConfiguration,
    changeMistralVibeConfiguration,
    changeGrokConfiguration,
    changeGooseConfiguration,
    changeGlmConfiguration,
    changeOpenAiCompatibleConfiguration,
    changeOpenAiImageConfiguration,
    changeGeminiImageConfiguration,
    changeAnthropicCompatibleConfiguration,
    changeAzureFoundryConfiguration,
    setEnabled,
    remove,
    providerCredentialStatus,
    clearProviderCredential,
    beginProviderAuthentication,
    completeProviderAuthentication,
    probe,
    verifyFoundryTools,
    updatePermissionPersistence,
    updateProviderOrder,
    updateAgentEligibleModels,
  };
}

export type ProviderController = ReturnType<typeof useProviderController>;

function queueProviderMutation(
  queue: { current: Promise<void> },
  mounted: { readonly current: boolean },
  setBusy: (value: boolean) => void,
  setMessage: (value: string | undefined) => void,
  operation: () => Promise<boolean>,
): Promise<boolean> {
  let result = false;
  const task = queue.current.then(async () => {
    if (mounted.current) {
      setBusy(true);
      setMessage(undefined);
    }
    try {
      result = await operation();
    } finally {
      if (mounted.current) setBusy(false);
    }
  });
  queue.current = task.catch(() => undefined);
  return task.then(() => result);
}

async function withTransientCredential(
  credential: TransientProviderCredential,
  operation: (value: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await operation(credential.value);
  } finally {
    try {
      credential.clear();
    } catch {
      // Clearing is best-effort because the renderer owns the transient input state.
    }
  }
}

function applyResult(
  result: ProviderRegistryCommandResult,
  current: ProviderRegistrySnapshot,
  install: (snapshot: ProviderRegistrySnapshot) => void,
): void {
  if (result.kind === "provider-created") {
    install({ ...current, instances: [...current.instances, result.instance] });
  } else if (result.kind === "provider-updated") {
    // The server invalidates and clears the runtime observation on config
    // changes and enable/disable toggles, but NOT on a plain rename. Mirror
    // that here: only clear the observed state when the configuration or
    // enabled flag actually changed, so a rename does not cause a UI flicker
    // where the observation disappears.
    const priorInstance = current.instances.find((value) => value.id === result.instance.id);
    const configChanged =
      priorInstance === undefined ||
      JSON.stringify(priorInstance.configuration) !==
        JSON.stringify(result.instance.configuration) ||
      priorInstance.enabled !== result.instance.enabled;
    install({
      ...current,
      instances: current.instances.map((value) =>
        value.id === result.instance.id ? result.instance : value,
      ),
      observedStates: configChanged
        ? current.observedStates.filter((value) => value.instanceId !== result.instance.id)
        : current.observedStates,
    });
  } else if (result.kind === "provider-removed") {
    install({
      ...current,
      instances: current.instances.filter((value) => value.id !== result.instanceId),
      observedStates: current.observedStates.filter(
        (value) => value.instanceId !== result.instanceId,
      ),
    });
  } else if (result.kind === "provider-defaults-updated") {
    install({ ...current, defaults: result.defaults });
  } else if (result.kind === "provider-probed") {
    install({
      ...current,
      observedStates: [
        ...current.observedStates.filter((value) => value.instanceId !== result.result.instanceId),
        result.result,
      ],
    });
  }
}

function failureMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Octant Provider service is unavailable.";
}

function domainValidationMessage(error: unknown): string {
  // Only surface the error text for invalid-configuration (domain policy
  // rejection) errors, which carry actionable user-facing messages. Other
  // categories (protocol, unavailable, provider-failed) may include internal
  // diagnostics that should not leak to the user.
  if (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === "invalid-configuration" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "";
}

function redactedProbeFailureMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || !("category" in error)) {
    return "Octant Provider service is unavailable.";
  }
  if (error.category === "unauthenticated") return "Provider authentication is required.";
  if (error.category === "invalid-configuration") return "Provider configuration is invalid.";
  if (error.category === "unsupported") return "Provider operation is unsupported.";
  if (error.category === "unauthorized") return "Provider operation is not authorized.";
  if (error.category === "interrupted") return "Provider operation was interrupted.";
  if (error.category === "stale-resume") return "Provider session state is stale.";
  if (error.category === "protocol") return "Provider returned an invalid response.";
  if (error.category === "provider-failed") return "Provider operation failed.";
  return "Octant Provider service is unavailable.";
}
