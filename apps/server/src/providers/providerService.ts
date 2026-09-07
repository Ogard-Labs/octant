import {
  ActorId,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeProviderFailure,
  decodeProviderCatalogSnapshot,
  decodeProviderInstanceId,
  decodeProviderObservedState,
  decodeProviderProbeResult,
  decodeProviderRegistryCommand,
  decodeProviderRegistryCommandResult,
  decodeProviderRegistrySnapshot,
  type ProviderDriverKind,
  type ProviderFailure,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderCatalogSnapshot,
  type ProviderObservedState,
  type ProviderProbeResult,
  type ProviderRegistryCommandResult,
  type ProviderRegistrySnapshot,
  type WindowId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderModelId,
  type ProviderExecutionPolicy,
  type OctantMode,
} from "@octant/contracts";
import {
  ProviderPolicyRejected,
  changeAnthropicCompatibleConfiguration,
  changeAzureFoundryConfiguration,
  changeBflImageConfiguration,
  changeIdeogramImageConfiguration,
  changeClaudeConfiguration,
  changeDevinConfiguration,
  changeGeminiImageConfiguration,
  changeGrokConfiguration,
  changeGooseConfiguration,
  changeGlmConfiguration,
  changeGeminiConfiguration,
  changeCopilotConfiguration,
  changeClineConfiguration,
  changeQwenConfiguration,
  changeKiloConfiguration,
  changeMistralVibeConfiguration,
  changeOllamaConfiguration,
  changePiConfiguration,
  changeOpenAiCompatibleConfiguration,
  changeOpenAiImageConfiguration,
  changeProviderBinary,
  createAnthropicCompatibleProvider,
  createAzureFoundryProvider,
  createBflImageProvider,
  createIdeogramImageProvider,
  createClaudeProvider,
  createDevinProvider,
  createGeminiImageProvider,
  createGrokProvider,
  createGooseProvider,
  createGlmProvider,
  createGeminiProvider,
  createCopilotProvider,
  createClineProvider,
  createQwenProvider,
  createKiloProvider,
  createOpenAiCompatibleProvider,
  createOpenAiImageProvider,
  createCodexProvider,
  createKimiCodeProvider,
  createMistralVibeProvider,
  createOllamaProvider,
  createPiProvider,
  createOhMyPiProvider,
  changeOhMyPiConfiguration,
  createOpenCodeProvider,
  removeProvider,
  renameProvider,
  setProviderEnabled,
  updateProviderDefaults,
  orderProviderInstances,
  orderProviderModels,
  describeProviderConfigurationChange,
  invalidateModelCapabilityEvidence,
  isImageProfileDriverKind,
  type CapabilityEvidenceChange,
} from "@octant/domain";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { admittedBundledProviderDriverKinds } from "@octant/plugin-host/provider-drivers";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import type { PersistenceService } from "../persistence/persistenceService";
import { ProjectionApplicationFailed } from "../persistence/projection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { PROVIDER_DEFAULTS_AGGREGATE_ID } from "./providerProjection";
import {
  ProviderRuntimeInvalidationRejected,
  type ProviderRuntimeRegistry,
} from "./providerRuntimeRegistry";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const unavailableCapabilities = {
  streaming: "unavailable",
  resume: "unavailable",
  interruption: "unavailable",
  approvals: "unavailable",
  userQuestions: "unavailable",
  reasoning: "unavailable",
  usage: "unavailable",
  toolActivity: "unavailable",
  fileChanges: "unavailable",
  diffs: "unavailable",
  taskProgress: "unavailable",
  nativeChildAgents: "unavailable",
  nativeAttachments: "unavailable",
  nativeWebResearch: "unavailable",
  appManagedTools: "unavailable",
  citations: "unavailable",
} as const satisfies ProviderObservedState["capabilities"];

export interface ProviderServiceApi {
  readonly bootstrap: (authenticatedWindowId: WindowId) => Promise<ProviderRegistrySnapshot>;
  readonly execute: (
    authenticatedWindowId: WindowId,
    command: unknown,
  ) => Promise<ProviderRegistryCommandResult>;
  readonly probe: (
    authenticatedWindowId: WindowId,
    instanceId: unknown,
  ) => Promise<ProviderProbeResult>;
  readonly smokeTurn: (
    authenticatedWindowId: WindowId,
    instanceId: unknown,
    input: PackagedProviderSmokeTurnInput,
  ) => Promise<PackagedProviderSmokeTurnResult>;
}

interface PackagedProviderSmokeTurnCommon {
  readonly sessionId: ProviderSessionId;
  readonly modelId: ProviderModelId;
  readonly prompt: string;
  readonly mode?: OctantMode;
  readonly executionPolicy?: ProviderExecutionPolicy;
}

export type PackagedProviderSmokeTurnInput = PackagedProviderSmokeTurnCommon &
  (
    | { readonly action: "cancel-after-output" | "complete" }
    | { readonly action: "answer-approval"; readonly approved: boolean }
    | { readonly action: "answer-question"; readonly answer: string }
  );

export interface PackagedProviderSmokeTurnResult {
  readonly events: readonly ProviderRuntimeEvent[];
  readonly observation: ProviderObservedState;
}

interface PackagedProviderSmokeLimits {
  readonly maxEvents?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_PACKAGED_SMOKE_MAX_EVENTS = 256;
const DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS = 30_000;

export interface ProviderServiceOptions {
  readonly persistence: PersistenceService;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly probe?: (instance: ProviderInstance) => Promise<unknown>;
  readonly driver?: (instance: ProviderInstance) => ProviderDriver;
  readonly isDriverPluginEffective?: (driverKind: ProviderDriverKind) => boolean;
  readonly clearResumeIdentities?: (instanceId: ProviderInstanceId) => Promise<void>;
  /** Clears process-local provider limit evidence when identity/configuration changes. */
  readonly clearRuntimeUsageLimits?: (instanceId: ProviderInstanceId) => void;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class ProviderServiceError extends Error {
  override readonly name = "ProviderServiceError";

  constructor(readonly failure: ProviderFailure) {
    super(failure.message);
  }
}

export class ProviderService implements ProviderServiceApi {
  readonly #persistence: PersistenceService;
  readonly #runtime: ProviderRuntimeRegistry;
  readonly #probeProvider: NonNullable<ProviderServiceOptions["probe"]>;
  readonly #instanceOperationTails = new Map<ProviderInstanceId, Promise<void>>();
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #driverProvider: ProviderServiceOptions["driver"];
  readonly #isDriverPluginEffective: (driverKind: ProviderDriverKind) => boolean;
  readonly #clearResumeIdentities: ProviderServiceOptions["clearResumeIdentities"];
  readonly #clearRuntimeUsageLimits: ProviderServiceOptions["clearRuntimeUsageLimits"];

  constructor(options: ProviderServiceOptions) {
    this.#persistence = options.persistence;
    this.#runtime = options.runtimeRegistry;
    if (options.probe !== undefined) this.#probeProvider = options.probe;
    else if (options.driver !== undefined) {
      // A refused probe must surface as the driver's typed failure, not as the
      // Error wrapper `Effect.runPromise` rejects with. That wrapper carries the
      // failure only as its message text, so the classification below read
      // every version floor, missing binary, and sign-in refusal as a generic
      // "degraded" and told the user nothing about what to do.
      this.#probeProvider = async (instance) => {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(options.driver!(instance).probe({ instanceId: instance.id })),
        );
        if (Exit.isSuccess(exit)) return exit.value;
        const refused = Cause.failureOption(exit.cause);
        throw Option.isSome(refused) ? refused.value : Cause.squash(exit.cause);
      };
    } else {
      this.#probeProvider = async () => {
        throw this.#unavailable();
      };
    }
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#driverProvider = options.driver;
    this.#isDriverPluginEffective =
      options.isDriverPluginEffective ??
      ((driverKind) => admittedBundledProviderDriverKinds().has(driverKind));
    this.#clearResumeIdentities = options.clearResumeIdentities;
    this.#clearRuntimeUsageLimits = options.clearRuntimeUsageLimits;
  }

  async bootstrap(_authenticatedWindowId: WindowId): Promise<ProviderRegistrySnapshot> {
    this.#assertReady();
    try {
      this.reconcileConfiguredProviders();
      const instances = this.#persistence.readProviderInstances();
      const configuredIds = new Set(instances.map(({ id }) => id));
      const defaults = this.#persistence.readProviderDefaults();
      const orderedInstances = orderProviderInstances(instances, defaults.providerOrder ?? []);
      const instanceById = new Map(
        orderedInstances.map((instance) => [String(instance.id), instance]),
      );
      const persistedCatalogs = this.#persistence
        .readProviderCatalogs?.()
        .filter(({ instanceId }) => configuredIds.has(instanceId))
        .flatMap((catalog) => {
          const instance = instanceById.get(String(catalog.instanceId));
          if (instance === undefined || !this.#isDriverKindAvailable(instance.driverKind)) {
            return [];
          }
          return [
            {
              ...catalog,
              models: orderProviderModels(catalog.models, catalog.manualModelOrder),
            },
          ];
        });
      const providerIndex = new Map(
        orderedInstances.map((instance, index) => [String(instance.id), index]),
      );
      persistedCatalogs?.sort(
        (left, right) =>
          (providerIndex.get(String(left.instanceId)) ?? Number.MAX_SAFE_INTEGER) -
          (providerIndex.get(String(right.instanceId)) ?? Number.MAX_SAFE_INTEGER),
      );
      const catalogByInstance = new Map(
        (persistedCatalogs ?? []).map((catalog) => [String(catalog.instanceId), catalog]),
      );
      const observedStates = this.#runtime
        .observedStates()
        .filter(({ instanceId }) => configuredIds.has(instanceId))
        .map((state) => {
          const instance = instanceById.get(String(state.instanceId));
          if (instance === undefined || !this.#isDriverKindAvailable(instance.driverKind)) {
            return decodeProviderObservedState({
              instanceId: state.instanceId,
              readiness: "unavailable",
              processState: "stopped",
              models: [],
              capabilities: unavailableCapabilities,
              message: "This provider driver is not available.",
              observedAt: state.observedAt,
            });
          }
          return {
            ...state,
            models: orderProviderModels(
              state.models,
              catalogByInstance.get(String(state.instanceId))?.manualModelOrder ?? [],
            ),
          };
        })
        .sort(
          (left, right) =>
            (providerIndex.get(String(left.instanceId)) ?? Number.MAX_SAFE_INTEGER) -
            (providerIndex.get(String(right.instanceId)) ?? Number.MAX_SAFE_INTEGER),
        );
      return decodeProviderRegistrySnapshot({
        instances: orderedInstances,
        defaults,
        observedStates,
        ...(persistedCatalogs === undefined || persistedCatalogs.length === 0
          ? {}
          : { catalogs: persistedCatalogs }),
      });
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  pendingInstanceOperationCount(): number {
    return this.#instanceOperationTails.size;
  }

  /**
   * Rebuilds runtime provider state from the persisted provider set so a
   * configuration change takes effect without restarting the server. A provider
   * no driver can serve is published as an unusable observation that carries
   * its reason, so the provider picker can explain it instead of the server
   * refusing to reconcile.
   */
  reconcileConfiguredProviders(): void {
    const instances = this.#persistence.readProviderInstances();
    const configured = new Set(instances.map((instance) => String(instance.id)));
    for (const observed of this.#runtime.observedStates()) {
      if (!configured.has(String(observed.instanceId))) {
        this.#runtime.clearObservedState(observed.instanceId);
      }
    }
    for (const instance of instances) {
      if (!instance.enabled) continue;
      const unusable = this.#unusableConfigurationObservation(instance);
      if (unusable !== undefined) this.#runtime.setObservedState(unusable);
    }
  }

  /**
   * Pre-spawns one runtime per enabled provider so the first turn of a new
   * thread does not pay provider startup. Each runtime then stays warm under
   * the driver's own idle lease. A provider that refuses to start records its
   * observation and never fails the warm pass.
   */
  async warmEnabledProviders(): Promise<void> {
    this.reconcileConfiguredProviders();
    for (const instance of this.#persistence.readProviderInstances()) {
      if (!instance.enabled) continue;
      if (this.#runtime.hasRuntime(instance.id)) continue;
      if (this.#unusableConfigurationObservation(instance) !== undefined) continue;
      try {
        await this.#probeConfiguredInstance(instance.id);
      } catch {
        // A refused warm start is already visible as a failed observation.
      }
    }
  }

  async smokeTurn(
    _authenticatedWindowId: WindowId,
    inputInstanceId: unknown,
    input: PackagedProviderSmokeTurnInput,
  ): Promise<PackagedProviderSmokeTurnResult> {
    let instanceId: ProviderInstanceId;
    try {
      instanceId = decodeProviderInstanceId(inputInstanceId);
      this.#assertReady();
      const instance = this.#persistence.readProviderInstance(instanceId);
      if (instance === undefined) throw this.#invalid("Provider instance was not found.");
      if (!instance.enabled) {
        throw this.#unsupported("Packaged provider smoke requires an enabled provider.");
      }
      this.#assertDriverPluginEffective(instance);
      if (this.#driverProvider === undefined) throw this.#unavailable();
      const result = await runPackagedProviderSmokeTurn(this.#driverProvider(instance), {
        instanceId,
        ...input,
      });
      const observation = this.#runtime.observedState(instanceId);
      if (observation === undefined) throw this.#unavailable();
      return { ...result, observation };
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async execute(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<ProviderRegistryCommandResult> {
    let command: ReturnType<typeof decodeProviderRegistryCommand>;
    try {
      command = decodeProviderRegistryCommand(input);
    } catch {
      throw this.#invalid("Provider command is invalid.");
    }
    if (command.kind === "probe-provider") {
      const result = await this.probe(authenticatedWindowId, command.instanceId);
      return decodeProviderRegistryCommandResult({ kind: "provider-probed", result });
    }
    if (command.kind === "verify-foundry-tools") {
      const result = await this.verifyFoundryTools(
        authenticatedWindowId,
        command.instanceId,
        command.modelId,
      );
      return decodeProviderRegistryCommandResult({
        kind: "foundry-tools-verified",
        instanceId: command.instanceId,
        modelId: command.modelId,
        appManagedTools: result,
      });
    }
    if (
      command.kind === "begin-provider-authentication" ||
      command.kind === "complete-provider-authentication"
    ) {
      this.#assertReady();
      try {
        return await this.#withInstanceOperation(command.instanceId, async () => {
          const instance = this.#persistence.readProviderInstance(command.instanceId);
          if (instance === undefined) throw this.#invalid("Provider instance was not found.");
          if (!instance.enabled) {
            throw this.#invalid("Enable this provider before authenticating it.");
          }
          this.#assertDriverPluginEffective(instance);
          if (this.#driverProvider === undefined) throw this.#unavailable();
          const driver = this.#driverProvider(instance);
          if (command.kind === "begin-provider-authentication") {
            if (driver.beginAuthentication === undefined) {
              throw this.#unsupported("This provider does not support browser authentication.");
            }
            const attempt = await Effect.runPromise(
              Effect.scoped(driver.beginAuthentication({ instanceId: instance.id })),
            );
            return decodeProviderRegistryCommandResult({
              kind: "provider-authentication-started",
              instanceId: instance.id,
              attempt,
            });
          }
          if (driver.completeAuthentication === undefined) {
            throw this.#unsupported("This provider does not support browser authentication.");
          }
          await Effect.runPromise(
            Effect.scoped(
              driver.completeAuthentication({
                instanceId: instance.id,
                attemptId: command.attemptId,
              }),
            ),
          );
          this.#invalidateCatalog(
            instance.id,
            { kind: "authentication" },
            "provider authentication changed",
            decodeTimestamp(this.#clock()),
          );
          this.#clearRuntimeUsageLimits?.(instance.id);
          return decodeProviderRegistryCommandResult({
            kind: "provider-authentication-completed",
            instanceId: instance.id,
          });
        });
      } catch (error) {
        throw this.#mapFailure(error);
      }
    }
    this.#assertReady();
    try {
      if (command.kind === "update-provider-defaults") {
        const current = this.#persistence.readProviderDefaults();
        this.#assertVersion(current.version, command.expectedVersion);
        const defaults = updateProviderDefaults(
          current,
          command.permissionPersistence,
          command.providerOrder,
          command.agentEligibleModels,
        );
        this.#persistence.journal.append({
          aggregate: {
            aggregateType: "provider-defaults",
            aggregateId: PROVIDER_DEFAULTS_AGGREGATE_ID,
          },
          expectedVersion: command.expectedVersion,
          events: [this.#pendingEvent("provider.defaults-updated@1", { defaults })],
        });
        const authoritative = this.#persistence.readProviderDefaults();
        if (authoritative.version !== defaults.version) throw this.#unavailable();
        return decodeProviderRegistryCommandResult({
          kind: "provider-defaults-updated",
          defaults: authoritative,
        });
      }

      const result = await this.#withInstanceOperation(command.instanceId, async () => {
        this.#assertReady();
        const current = this.#persistence.readProviderInstance(command.instanceId);
        const instances = this.#persistence.readProviderInstances();
        if (
          command.kind === "create-opencode-provider" ||
          command.kind === "create-codex-provider" ||
          command.kind === "create-kimi-code-provider" ||
          command.kind === "create-claude-provider" ||
          command.kind === "create-devin-provider" ||
          command.kind === "create-kilo-provider" ||
          command.kind === "create-pi-provider" ||
          command.kind === "create-oh-my-pi-provider" ||
          command.kind === "create-ollama-provider" ||
          command.kind === "create-mistral-vibe-provider" ||
          command.kind === "create-grok-provider" ||
          command.kind === "create-goose-provider" ||
          command.kind === "create-glm-provider" ||
          command.kind === "create-gemini-provider" ||
          command.kind === "create-copilot-provider" ||
          command.kind === "create-cline-provider" ||
          command.kind === "create-qwen-provider" ||
          command.kind === "create-openai-compatible-provider" ||
          command.kind === "create-anthropic-compatible-provider" ||
          command.kind === "create-azure-foundry-provider" ||
          command.kind === "create-openai-image-provider" ||
          command.kind === "create-gemini-native-image-provider" ||
          command.kind === "create-bfl-image-provider" ||
          command.kind === "create-ideogram-image-provider"
        ) {
          if (current !== undefined || command.expectedVersion !== 0) {
            throw this.#invalid("Provider configuration changed; reload and retry.");
          }
          const enabled = "enabled" in command ? command.enabled : undefined;
          const common = {
            id: command.instanceId,
            displayName: command.displayName,
            existingInstances: instances,
            expectedVersion: command.expectedVersion,
            createdAt: decodeTimestamp(this.#clock()),
            ...(enabled === undefined ? {} : { enabled }),
          };
          let instance: ProviderInstance;
          switch (command.kind) {
            case "create-opencode-provider":
              instance = createOpenCodeProvider({ ...common, binaryPath: command.binaryPath });
              break;
            case "create-codex-provider":
              instance = createCodexProvider({ ...common, binaryPath: command.binaryPath });
              break;
            case "create-kimi-code-provider":
              instance = createKimiCodeProvider({ ...common, binaryPath: command.binaryPath });
              break;
            case "create-claude-provider":
              instance = createClaudeProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-devin-provider":
              instance = createDevinProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-kilo-provider":
              instance = createKiloProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-pi-provider":
              instance = createPiProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-oh-my-pi-provider":
              instance = createOhMyPiProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-ollama-provider":
              instance = createOllamaProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-mistral-vibe-provider":
              instance = createMistralVibeProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-grok-provider":
              instance = createGrokProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-goose-provider":
              instance = createGooseProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-glm-provider":
              instance = createGlmProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-gemini-provider":
              instance = createGeminiProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-copilot-provider":
              instance = createCopilotProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-cline-provider":
              instance = createClineProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-qwen-provider":
              instance = createQwenProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-openai-compatible-provider":
              instance = createOpenAiCompatibleProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-anthropic-compatible-provider":
              instance = createAnthropicCompatibleProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-azure-foundry-provider":
              instance = createAzureFoundryProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-openai-image-provider":
              instance = createOpenAiImageProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-gemini-native-image-provider":
              instance = createGeminiImageProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-bfl-image-provider":
              instance = createBflImageProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
            case "create-ideogram-image-provider":
              instance = createIdeogramImageProvider({
                ...common,
                configuration: command.configuration,
              });
              break;
          }
          this.#assertDriverPluginEffective(instance);
          this.#appendInstance(command.expectedVersion, "provider.instance-created@1", instance);
          const authoritative = this.#authoritativeInstance(instance);
          this.#publishSelectedAuthenticationObservation(authoritative);
          return decodeProviderRegistryCommandResult({
            kind: "provider-created",
            instance: authoritative,
          });
        }

        if (current === undefined) throw this.#invalid("Provider instance was not found.");
        this.#assertVersion(current.version, command.expectedVersion);
        const updatedAt = decodeTimestamp(this.#clock());
        if (command.kind === "remove-provider") {
          const removed = removeProvider(current, {
            activeSessionCount: this.#runtime.activeSessionCount(current.id),
            updatedAt,
          });
          await this.#runtime.invalidateRuntime(current.id);
          this.#persistence.journal.append({
            aggregate: { aggregateType: "provider-instance", aggregateId: current.id },
            expectedVersion: command.expectedVersion,
            events: [
              this.#pendingEvent("provider.instance-removed@1", {
                instanceId: current.id,
                version: removed.version,
              }),
            ],
          });
          if (this.#persistence.readProviderInstance(current.id) !== undefined) {
            throw this.#unavailable();
          }
          if (current.driverKind === "claude") {
            await this.#clearResumeIdentities?.(current.id);
          }
          this.#invalidateCatalog(current.id, { kind: "all" }, "provider removed", updatedAt);
          this.#clearRuntimeUsageLimits?.(current.id);
          return decodeProviderRegistryCommandResult({
            kind: "provider-removed",
            instanceId: current.id,
            version: removed.version,
          });
        }

        let instance: ProviderInstance;
        let eventName: string;
        if (command.kind === "rename-provider") {
          instance = renameProvider(current, {
            displayName: command.displayName,
            existingInstances: instances,
            updatedAt,
          });
          eventName = "provider.instance-renamed@1";
        } else if (command.kind === "change-provider-binary") {
          if (
            current.driverKind !== "opencode" &&
            current.driverKind !== "codex" &&
            current.driverKind !== "kimi-code"
          ) {
            throw this.#unsupported("This provider does not use a CLI binary.");
          }
          if (this.#runtime.activeSessionCount(current.id) !== 0) {
            throw this.#invalid("Stop active sessions before changing this provider runtime.");
          }
          instance = changeProviderBinary(current, {
            binaryPath: command.binaryPath,
            activeSessionCount: 0,
            updatedAt,
          });
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-binary-changed@1";
        } else if (command.kind === "change-openai-compatible-configuration") {
          if (current.driverKind !== "openai-compatible") {
            throw this.#unsupported("This provider does not use HTTP configuration.");
          }
          instance = changeOpenAiCompatibleConfiguration(current, command.configuration, updatedAt);
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-anthropic-compatible-configuration") {
          if (current.driverKind !== "anthropic-compatible") {
            throw this.#unsupported("This provider does not use HTTP configuration.");
          }
          instance = changeAnthropicCompatibleConfiguration(
            current,
            command.configuration,
            updatedAt,
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-azure-foundry-configuration") {
          if (current.driverKind !== "azure-foundry") {
            throw this.#unsupported("This provider does not use Azure AI Foundry configuration.");
          }
          instance = changeAzureFoundryConfiguration(current, command.configuration, updatedAt);
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-openai-image-configuration") {
          if (current.driverKind !== "openai-image") {
            throw this.#unsupported("This provider does not use OpenAI image configuration.");
          }
          instance = changeOpenAiImageConfiguration(current, command.configuration, updatedAt);
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-gemini-native-image-configuration") {
          if (current.driverKind !== "gemini-native-image") {
            throw this.#unsupported("This provider does not use Gemini image configuration.");
          }
          instance = changeGeminiImageConfiguration(current, command.configuration, updatedAt);
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-bfl-image-configuration") {
          if (current.driverKind !== "bfl-image") {
            throw this.#unsupported("This provider does not use BFL image configuration.");
          }
          instance = changeBflImageConfiguration(current, command.configuration, updatedAt);
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-ideogram-image-configuration") {
          if (current.driverKind !== "ideogram-image") {
            throw this.#unsupported("This provider does not use Ideogram image configuration.");
          }
          instance = changeIdeogramImageConfiguration(current, command.configuration, updatedAt);
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-claude-configuration") {
          if (current.driverKind !== "claude") {
            throw this.#unsupported("This provider does not use Claude configuration.");
          }
          instance = changeClaudeConfiguration(current, {
            configuration: command.configuration,
            activeSessionCount: this.#runtime.activeSessionCount(current.id),
            updatedAt,
          });
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-mistral-vibe-configuration") {
          if (current.driverKind !== "mistral-vibe") {
            throw this.#unsupported("This provider does not use Mistral Vibe configuration.");
          }
          instance = changeMistralVibeConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-grok-configuration") {
          if (current.driverKind !== "grok") {
            throw this.#unsupported("This provider does not use Grok Build configuration.");
          }
          instance = changeGrokConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-goose-configuration") {
          if (current.driverKind !== "goose") {
            throw this.#unsupported("This provider does not use Goose configuration.");
          }
          instance = changeGooseConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-glm-configuration") {
          if (current.driverKind !== "glm") {
            throw this.#unsupported("This provider does not use GLM Agent configuration.");
          }
          instance = changeGlmConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-gemini-configuration") {
          if (current.driverKind !== "gemini") {
            throw this.#unsupported("This provider does not use Gemini CLI configuration.");
          }
          instance = changeGeminiConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-copilot-configuration") {
          if (current.driverKind !== "copilot") {
            throw this.#unsupported("This provider does not use GitHub Copilot configuration.");
          }
          instance = changeCopilotConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-cline-configuration") {
          if (current.driverKind !== "cline") {
            throw this.#unsupported("This provider does not use Cline configuration.");
          }
          instance = changeClineConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-qwen-configuration") {
          if (current.driverKind !== "qwen") {
            throw this.#unsupported("This provider does not use Qwen Code configuration.");
          }
          instance = changeQwenConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-devin-configuration") {
          if (current.driverKind !== "devin") {
            throw this.#unsupported("This provider does not use Devin configuration.");
          }
          instance = changeDevinConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-kilo-configuration") {
          if (current.driverKind !== "kilo") {
            throw this.#unsupported("This provider does not use Kilo configuration.");
          }
          instance = changeKiloConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-pi-configuration") {
          if (current.driverKind !== "pi") {
            throw this.#unsupported("This provider does not use Pi configuration.");
          }
          instance = changePiConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-oh-my-pi-configuration") {
          if (current.driverKind !== "oh-my-pi") {
            throw this.#unsupported("This provider does not use Oh My Pi configuration.");
          }
          instance = changeOhMyPiConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else if (command.kind === "change-ollama-configuration") {
          if (current.driverKind !== "ollama") {
            throw this.#unsupported("This provider does not use Ollama configuration.");
          }
          instance = changeOllamaConfiguration(
            current,
            command.configuration,
            updatedAt,
            this.#runtime.activeSessionCount(current.id),
          );
          await this.#runtime.invalidateRuntime(current.id);
          eventName = "provider.instance-configuration-changed@1";
        } else {
          instance = setProviderEnabled(current, { enabled: command.enabled, updatedAt });
          if (!instance.enabled && this.#runtime.activeSessionCount(instance.id) === 0) {
            await this.#runtime.invalidateRuntime(instance.id);
          }
          eventName = "provider.instance-enabled-changed@1";
        }
        this.#appendInstance(command.expectedVersion, eventName, instance);
        const authoritative = this.#authoritativeInstance(instance);
        if (eventName !== "provider.instance-renamed@1") {
          this.#invalidateCatalog(
            instance.id,
            describeProviderConfigurationChange(current, instance),
            "provider configuration changed",
            updatedAt,
          );
          this.#clearRuntimeUsageLimits?.(instance.id);
        }
        if (
          command.kind === "change-claude-configuration" ||
          command.kind === "change-mistral-vibe-configuration" ||
          command.kind === "change-grok-configuration" ||
          command.kind === "change-glm-configuration" ||
          command.kind === "change-gemini-configuration" ||
          command.kind === "change-cline-configuration" ||
          command.kind === "change-qwen-configuration" ||
          command.kind === "change-devin-configuration"
        ) {
          this.#publishSelectedAuthenticationObservation(authoritative);
        }
        if (command.kind === "set-provider-enabled" && instance.enabled) {
          this.#runtime.clearObservedState(instance.id);
        }
        return decodeProviderRegistryCommandResult({
          kind: "provider-updated",
          instance: authoritative,
        });
      });
      this.reconcileConfiguredProviders();
      return result;
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async probe(_authenticatedWindowId: WindowId, input: unknown): Promise<ProviderProbeResult> {
    let instanceId: ProviderInstanceId;
    try {
      instanceId = decodeProviderInstanceId(input);
    } catch {
      throw this.#invalid("Provider instance ID is invalid.");
    }
    return this.#probeConfiguredInstance(instanceId);
  }

  #probeConfiguredInstance(instanceId: ProviderInstanceId): Promise<ProviderProbeResult> {
    return this.#withInstanceOperation(instanceId, async () => {
      try {
        this.#assertReady();
        const instance = this.#persistence.readProviderInstance(instanceId);
        if (instance === undefined) {
          // Clear any stale observation for a missing provider.
          this.#runtime.clearObservedState(instanceId);
          this.#clearRuntimeUsageLimits?.(instanceId);
          throw this.#invalid("Provider instance was not found.");
        }
        if (!instance.enabled) {
          // Clear any stale observation for a disabled provider.
          this.#runtime.clearObservedState(instanceId);
          this.#clearRuntimeUsageLimits?.(instanceId);
          throw this.#invalid("Enable this provider before probing it.");
        }
        if (!this.#isDriverKindAvailable(instance.driverKind)) {
          this.#runtime.clearObservedState(instanceId);
          this.#clearRuntimeUsageLimits?.(instanceId);
          throw this.#unsupported("This provider driver is not available.");
        }
        // Do NOT clear the runtime observed state for a valid enabled probe:
        // the web client already clears its local snapshot for the "checking"
        // UI state, and clearing the server runtime state would race with
        // Chat's #prepareTurnExecution probe (which calls driver.probe()
        // directly, outside this serialization queue) and erase
        // verifiedToolModelIds mid-verification. The driver probe overwrites
        // the runtime state naturally on success, and the failed-probe path
        // below sets a failed observation on error.
        const result = decodeProviderProbeResult(await this.#probeProvider(instance));
        if (result.instanceId !== instance.id) {
          throw { category: "protocol", message: "Provider returned an invalid probe result." };
        }
        // The driver probe carries verifiedToolModelIds forward from the prior
        // runtime observation. On a fresh restart the runtime is empty, so
        // also check the persisted catalog and merge any saved verifications
        // so users do not need to rerun the generating verification after
        // restart. Skip invalidated catalogs: a config change invalidates
        // prior verification evidence, and reviving stale IDs could enable
        // tools for a deployment that now points at a different endpoint or
        // capability set.
        const persistedCatalog = this.#persistence.readProviderCatalog?.(instanceId);
        const persistedVerified =
          persistedCatalog?.invalidated === false
            ? persistedCatalog.verifiedToolModelIds
            : undefined;
        const mergedResult =
          persistedVerified === undefined || persistedVerified.length === 0
            ? result
            : {
                ...result,
                verifiedToolModelIds: [
                  ...new Set([
                    ...(result.verifiedToolModelIds ?? []),
                    ...persistedVerified.map((id) => String(id) as ProviderModelId),
                  ]),
                ].map((id) => id as ProviderModelId),
              };
        // Order the observed models so configured deployments (manual IDs)
        // appear first in the configured order. The web defaults Chat/Code
        // selection to models[0], so a discovered-first catalog would select a
        // non-deployment id for Azure AI Foundry until a bootstrap reload
        // reorders it from the persisted manualModelOrder.
        const manualModelOrder =
          instance.configuration.kind === "openai-compatible-http" ||
          instance.configuration.kind === "anthropic-compatible-http" ||
          instance.configuration.kind === "azure-foundry-openai-http"
            ? instance.configuration.manualModelIds
            : mergedResult.models.filter(({ source }) => source === "manual").map(({ id }) => id);
        const orderedResult =
          manualModelOrder.length === 0
            ? mergedResult
            : {
                ...mergedResult,
                models: orderProviderModels(mergedResult.models, manualModelOrder),
              };
        const observed = this.#runtime.setObservedState(orderedResult);
        this.#persistCatalog(observed);
        return observed;
      } catch (error) {
        const failedObservation = this.#failedProbeObservation(instanceId, error);
        if (failedObservation !== undefined) this.#runtime.setObservedState(failedObservation);
        throw this.#mapFailure(error);
      }
    });
  }

  async verifyFoundryTools(
    _authenticatedWindowId: WindowId,
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  ): Promise<"supported" | "unsupported"> {
    return this.#withInstanceOperation(instanceId, async () => {
      this.#assertReady();
      const instance = this.#persistence.readProviderInstance(instanceId);
      if (instance === undefined) throw this.#invalid("Provider instance was not found.");
      if (instance.driverKind !== "azure-foundry") {
        throw this.#invalid("Tool verification is only available for Azure AI Foundry providers.");
      }
      if (!instance.enabled) throw this.#invalid("Enable this provider before verifying tools.");
      this.#assertDriverPluginEffective(instance);
      // Validate the target modelId against the configured deployment IDs so
      // an authenticated renderer cannot probe and record an arbitrary
      // unconfigured model as verified. The Settings UI only exposes
      // configured IDs, but the server-side command handler is the authority
      // boundary.
      const configuredIds = instance.configuration.manualModelIds.map((id) => String(id));
      if (!configuredIds.includes(String(modelId))) {
        throw this.#invalid(
          "Azure AI Foundry tool verification is only available for configured deployment IDs.",
        );
      }
      // Require a prior Connection Check so the verification has an observed
      // state to update. Without this, the server would return success but
      // silently discard the verification since there is no runtime observation
      // to store it in.
      const observed = this.#runtime.observedState(instanceId);
      if (observed === undefined) {
        throw this.#invalid(
          "Run Check connection for this Azure AI Foundry provider before verifying tools.",
        );
      }
      if (this.#driverProvider === undefined) throw this.#unavailable();
      const driver = this.#driverProvider(instance);
      if (driver.verifyToolCapability === undefined) throw this.#unavailable();
      try {
        const result = await Effect.runPromise(
          Effect.scoped(driver.verifyToolCapability({ instanceId, modelId })),
        );
        // Re-read the current observed state AFTER the driver call so we merge
        // only verifiedToolModelIds into the latest observation. The driver call
        // may take time, and a concurrent probe or turn could have updated the
        // observation in the meantime; snapshotting before the call would
        // overwrite those updates with a stale copy.
        const current = this.#runtime.observedState(instanceId);
        if (current === undefined) {
          // The observation was cleared while the verification was in flight.
          // The verification result is lost, but we avoid overwriting a cleared
          // state with a stale snapshot.
          return result.appManagedTools;
        }
        const priorVerified = current.verifiedToolModelIds ?? [];
        const verifiedToolModelIds =
          result.appManagedTools === "supported"
            ? [...new Set([...priorVerified, String(modelId)])].map((id) => id as ProviderModelId)
            : priorVerified.filter((id) => String(id) !== String(modelId));
        const updated = { ...current, verifiedToolModelIds };
        this.#runtime.setObservedState(updated);
        // Persist the verification evidence so it survives app restart/replay.
        // Without this, verifiedToolModelIds disappears after restart and users
        // must rerun the generating verification before Chat research works.
        this.#persistCatalog(updated);
        return result.appManagedTools;
      } catch (error) {
        // Map the raw ProviderFailure (401, 403, 429, unsupported protocol,
        // etc.) to a ProviderServiceError so providerRoutes serializes the
        // actionable diagnostic instead of returning a generic 503.
        throw this.#mapFailure(error);
      }
    });
  }

  #unusableConfigurationObservation(instance: ProviderInstance): ProviderObservedState | undefined {
    if (this.#driverProvider === undefined) return undefined;
    try {
      this.#driverProvider(instance);
      return undefined;
    } catch (error) {
      const failure = providerFailureOfError(error) ?? {
        category: "invalid-configuration",
        message: "Provider driver configuration is invalid.",
      };
      return decodeProviderObservedState({
        instanceId: instance.id,
        readiness: probeFailureReadiness(failure.category),
        processState: "stopped",
        models: [],
        capabilities: unavailableCapabilities,
        message: failure.message,
        observedAt: decodeTimestamp(this.#clock()),
      });
    }
  }

  #failedProbeObservation(
    instanceId: ProviderInstanceId,
    error: unknown,
  ): ProviderObservedState | undefined {
    if (error instanceof ProviderServiceError) return undefined;
    const failure = providerFailureOfError(error);
    const readiness = probeFailureReadiness(failure?.category ?? "provider-failed");
    return decodeProviderObservedState({
      instanceId,
      readiness,
      processState: "stopped",
      models: [],
      capabilities: unavailableCapabilities,
      // Only the category crosses into the observed state: a driver's own
      // sentence can quote provider output, and this state reaches every client.
      message: probeFailureMessage(readiness),
      observedAt: decodeTimestamp(this.#clock()),
    });
  }

  #persistCatalog(observed: ProviderObservedState): void {
    if (this.#persistence.readProviderCatalog === undefined) return;
    if (observed.readiness !== "ready" && observed.models.length === 0) return;
    const current = this.#persistence.readProviderCatalog(observed.instanceId);
    const instance = this.#persistence.readProviderInstance(observed.instanceId);
    const snapshot: ProviderCatalogSnapshot = decodeProviderCatalogSnapshot({
      instanceId: observed.instanceId,
      version: (current?.version ?? 0) + 1,
      models: observed.models,
      manualModelOrder:
        instance?.configuration.kind === "openai-compatible-http" ||
        instance?.configuration.kind === "anthropic-compatible-http" ||
        instance?.configuration.kind === "azure-foundry-openai-http"
          ? instance.configuration.manualModelIds
          : observed.models.filter(({ source }) => source === "manual").map(({ id }) => id),
      ...(observed.verifiedToolModelIds === undefined
        ? {}
        : { verifiedToolModelIds: observed.verifiedToolModelIds }),
      invalidated: false,
      updatedAt: observed.observedAt,
    });
    this.#persistence.journal.append({
      aggregate: {
        aggregateType: "provider-catalog",
        aggregateId: observed.instanceId,
      },
      expectedVersion: current?.version ?? 0,
      events: [this.#pendingEvent("provider.catalog-updated@1", { snapshot })],
    });
    const authoritative = this.#persistence.readProviderCatalog(observed.instanceId);
    if (authoritative?.version !== snapshot.version) throw this.#unavailable();
  }

  #invalidateCatalog(
    instanceId: ProviderInstanceId,
    change: CapabilityEvidenceChange,
    reason: string,
    invalidatedAt: UtcTimestamp,
  ): void {
    if (this.#persistence.readProviderCatalog === undefined) return;
    const current = this.#persistence.readProviderCatalog(instanceId);
    if (current === undefined) return;
    const updatedModels = current.models.map((model) => ({
      ...model,
      capabilityEvidence: model.capabilityEvidence
        ? invalidateModelCapabilityEvidence(model.capabilityEvidence, change, invalidatedAt, reason)
        : model.capabilityEvidence,
    }));
    const evidenceChanged = updatedModels.some(
      (model, index) => model.capabilityEvidence !== current.models[index]?.capabilityEvidence,
    );
    if (current.invalidated && !evidenceChanged) return;
    const snapshot = decodeProviderCatalogSnapshot({
      ...current,
      version: current.version + 1,
      invalidated: true,
      invalidatedAt,
      invalidationReason: reason,
      updatedAt: invalidatedAt,
      models: updatedModels,
      // Clear verifiedToolModelIds on invalidation: a config change
      // (endpoint, protocol, or deployment IDs) invalidates prior per-
      // deployment tool verification evidence. Keeping stale IDs would
      // allow the next Check connection to revive them and enable tools
      // for a deployment that may now point at a different endpoint or
      // capability set.
      verifiedToolModelIds: undefined,
    });
    this.#persistence.journal.append({
      aggregate: { aggregateType: "provider-catalog", aggregateId: instanceId },
      expectedVersion: current.version,
      events: [this.#pendingEvent("provider.catalog-updated@1", { snapshot })],
    });
    const authoritative = this.#persistence.readProviderCatalog(instanceId);
    if (authoritative?.version !== snapshot.version) throw this.#unavailable();
  }

  async #withInstanceOperation<T>(instanceId: ProviderInstanceId, operation: () => Promise<T>) {
    const previous = this.#instanceOperationTails.get(instanceId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#instanceOperationTails.set(instanceId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#instanceOperationTails.get(instanceId) === tail) {
        this.#instanceOperationTails.delete(instanceId);
      }
    }
  }

  #appendInstance(expectedVersion: number, eventName: string, instance: ProviderInstance): void {
    this.#persistence.journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: instance.id },
      expectedVersion: expectedVersion as never,
      events: [this.#pendingEvent(eventName, { instance })],
    });
  }

  #publishSelectedAuthenticationObservation(instance: ProviderInstance): void {
    if (
      instance.driverKind !== "claude" &&
      instance.driverKind !== "mistral-vibe" &&
      instance.driverKind !== "grok" &&
      instance.driverKind !== "glm" &&
      instance.driverKind !== "gemini" &&
      instance.driverKind !== "cline" &&
      instance.driverKind !== "qwen" &&
      instance.driverKind !== "devin"
    ) {
      return;
    }
    this.#runtime.setObservedState(
      decodeProviderObservedState({
        instanceId: instance.id,
        readiness: "checking",
        processState: "stopped",
        ...(instance.configuration.authentication === "api-key"
          ? { credentialStatus: "missing" }
          : {}),
        models: [],
        capabilities: unavailableCapabilities,
        observedAt: decodeTimestamp(this.#clock()),
      }),
    );
  }

  #authoritativeInstance(expected: ProviderInstance): ProviderInstance {
    const authoritative = this.#persistence.readProviderInstance(expected.id);
    if (authoritative === undefined || authoritative.version !== expected.version) {
      throw this.#unavailable();
    }
    return authoritative;
  }

  #pendingEvent(eventName: string, payload: unknown) {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      correlationId: decodeCorrelationId(this.#uuid()),
      actor: { kind: "local-user" as const, actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
      occurredAt: decodeTimestamp(this.#clock()),
      payload,
    };
  }

  #assertVersion(actual: number, expected: number): void {
    if (actual !== expected)
      throw this.#invalid("Provider configuration changed; reload and retry.");
  }

  #assertDriverPluginEffective(instance: ProviderInstance): void {
    if (!this.#isDriverKindAvailable(instance.driverKind)) {
      throw this.#unsupported("This provider driver is not available.");
    }
  }

  #isDriverKindAvailable(driverKind: ProviderDriverKind): boolean {
    return isImageProfileDriverKind(driverKind) || this.#isDriverPluginEffective(driverKind);
  }

  #assertReady(): void {
    try {
      const status = this.#persistence.status();
      if (status.state !== "current" || status.integrity !== "ok") throw new Error("not ready");
    } catch {
      throw this.#unavailable();
    }
  }

  #mapFailure(error: unknown): ProviderServiceError {
    if (error instanceof ProviderServiceError) return error;
    if (error instanceof ProviderPolicyRejected) return this.#invalid(error.message);
    if (error instanceof ProviderRuntimeInvalidationRejected) return this.#invalid(error.message);
    if (error instanceof ConcurrencyConflict) {
      return this.#invalid("Provider configuration changed; reload and retry.");
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#unavailable();
    }
    if (isProviderFailure(error)) return new ProviderServiceError(decodeProviderFailure(error));
    return this.#unavailable();
  }

  #invalid(message: string): ProviderServiceError {
    return new ProviderServiceError({ category: "invalid-configuration", message });
  }

  #unsupported(message: string): ProviderServiceError {
    return new ProviderServiceError({ category: "unsupported", message });
  }

  #unavailable(): ProviderServiceError {
    return new ProviderServiceError({
      category: "unavailable",
      message: "Octant Provider service is unavailable.",
    });
  }
}

export async function runPackagedProviderSmokeTurn(
  driver: ProviderDriver,
  input: PackagedProviderSmokeTurnInput & { readonly instanceId: ProviderInstanceId },
  limits: PackagedProviderSmokeLimits = {},
): Promise<{ readonly events: readonly ProviderRuntimeEvent[] }> {
  const maxEvents = limits.maxEvents ?? DEFAULT_PACKAGED_SMOKE_MAX_EVENTS;
  const timeoutMs = limits.timeoutMs ?? DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS;
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const createdProjectRoot = await mkdtemp(join(canonicalTemporaryRoot, "octant-provider-smoke-"));
  try {
    const projectRoot = await realpath(createdProjectRoot);
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({
            instanceId: input.instanceId,
            projectRoot,
            ...(input.mode === undefined ? {} : { mode: input.mode }),
          });
          yield* connection.start({
            sessionId: input.sessionId,
            modelId: input.modelId,
            executionPolicy: input.executionPolicy ?? "approval-gated",
          });
          yield* Effect.addFinalizer(() =>
            connection.stop(input.sessionId).pipe(Effect.catchAll(() => Effect.void)),
          );
          const events: ProviderRuntimeEvent[] = [];
          let answeredRequestId: string | undefined;
          let matchingRequestCount = 0;
          let interruptedAfterOutput = false;
          const runtimeEvents = yield* connection.subscribe;
          const collected = yield* Effect.fork(
            runtimeEvents.pipe(
              Stream.filter((event) => event.sessionId === input.sessionId),
              Stream.take(maxEvents + 1),
              Stream.takeUntil(
                (event) =>
                  event.kind === "completed" ||
                  event.kind === "interrupted" ||
                  event.kind === "failed",
              ),
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  events.push(event);
                  if (
                    input.action === "cancel-after-output" &&
                    event.kind === "text-delta" &&
                    !interruptedAfterOutput
                  ) {
                    interruptedAfterOutput = true;
                    yield* connection.interrupt(input.sessionId);
                  } else if (
                    input.action === "answer-approval" &&
                    event.kind === "approval-request"
                  ) {
                    matchingRequestCount += 1;
                    if (matchingRequestCount === 1) {
                      answeredRequestId = event.requestId;
                      yield* connection.answerApproval({
                        sessionId: input.sessionId,
                        requestId: event.requestId,
                        approved: input.approved,
                      });
                    }
                  } else if (
                    input.action === "answer-question" &&
                    event.kind === "user-input-request"
                  ) {
                    matchingRequestCount += 1;
                    if (matchingRequestCount === 1) {
                      answeredRequestId = event.requestId;
                      yield* connection.answerUserInput({
                        sessionId: input.sessionId,
                        requestId: event.requestId,
                        answer: input.answer,
                      });
                    }
                  }
                }),
              ),
            ),
          );
          yield* connection.send({
            sessionId: input.sessionId,
            prompt: input.prompt,
            attachments: [],
            tools: [],
          });
          yield* Fiber.join(collected);
          if (input.action === "answer-approval" || input.action === "answer-question") {
            if (matchingRequestCount === 0 || answeredRequestId === undefined) {
              return yield* Effect.fail({
                category: "protocol" as const,
                message: "Provider smoke observed no matching normalized request.",
              });
            }
            if (matchingRequestCount !== 1) {
              return yield* Effect.fail({
                category: "protocol" as const,
                message: "Provider smoke requires exactly one matching normalized request.",
              });
            }
          } else if (input.action === "cancel-after-output" && !interruptedAfterOutput) {
            return yield* Effect.fail({
              category: "protocol" as const,
              message: "Provider cancellation smoke observed no output before interruption.",
            });
          }
          const last = events.at(-1);
          if (
            events.length > maxEvents ||
            last === undefined ||
            (last.kind !== "completed" && last.kind !== "interrupted" && last.kind !== "failed")
          ) {
            return yield* Effect.fail({
              category: "protocol" as const,
              message: "Provider smoke did not return a bounded terminal event sequence.",
            });
          }
          return { events };
        }),
      ).pipe(
        Effect.timeoutFail({
          duration: timeoutMs,
          onTimeout: () => ({
            category: "interrupted" as const,
            message: "Provider smoke timed out.",
          }),
        }),
      ),
    );
  } finally {
    await rm(createdProjectRoot, { recursive: true, force: true });
  }
}

function providerFailureOfError(error: unknown): ProviderFailure | undefined {
  if (isProviderFailure(error)) return decodeProviderFailure(error);
  if (error instanceof Error && "failure" in error && isProviderFailure(error.failure)) {
    return decodeProviderFailure(error.failure);
  }
  return undefined;
}

function isProviderFailure(value: unknown): value is ProviderFailure {
  try {
    decodeProviderFailure(value);
    return true;
  } catch {
    return false;
  }
}

function probeFailureReadiness(
  category: ProviderFailure["category"],
): Exclude<ProviderObservedState["readiness"], "ready" | "checking"> {
  if (category === "unauthenticated") return "unauthenticated";
  if (category === "unavailable" || category === "interrupted") return "unavailable";
  if (
    category === "invalid-configuration" ||
    category === "unsupported" ||
    category === "incompatible"
  ) {
    return "incompatible";
  }
  return "degraded";
}

function probeFailureMessage(
  readiness: Exclude<ProviderObservedState["readiness"], "ready" | "checking">,
): string {
  if (readiness === "unauthenticated") return "Provider authentication is required.";
  if (readiness === "unavailable") return "Provider runtime is unavailable.";
  if (readiness === "incompatible") return "Provider configuration is incompatible.";
  return "Provider probe failed.";
}
