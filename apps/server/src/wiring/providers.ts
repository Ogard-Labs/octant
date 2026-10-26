import { createLocalUsageHistoryCheckpointStore } from "../persistence/localUsageHistoryCheckpointStore";
import { createLocalUsageHistoryLastReadStore } from "../persistence/localUsageHistoryLastReadStore";
import { createSelectedExtensionResolver } from "../extensions/selectedExtensions";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  decodeCodeCheckoutId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeCodeWorktreeRef,
  decodeCodeWorktreeSourcePreview,
  decodeWindowId,
  type DiscoveryCandidate,
  LOCAL_HOST_ID,
  type PermissionPersistence,
  type ProviderDriverKind,
  type ProviderInstance,
  type ProviderProbeResult,
  type ProviderRuntimeEvent,
  type UtcTimestamp,
  decodeProjectId,
} from "@octant/contracts";
import { ExtensionProviderFamily } from "@octant/contracts/extensions";
import type {
  HarnessEndpointDriver,
  ProviderDriver,
  ProviderLocalUsageHistorySource,
} from "@octant/provider-sdk";
import { Effect, Schema } from "effect";
import { admittedBundledProviderDriverKinds } from "@octant/plugin-host";
import { resolveThreadWorkingDirectory } from "../threadWorkingDirectoryAuthority";
import { attachWorkRequestRuntime } from "../work/workRequestRuntime";
import type { CodeWorktreeRefsPort, CodeWorktreeSourcePreviewPort } from "../code/codeService";
import {
  createManagedWorktreeNodePorts,
  listWorktreeRefs,
  observeManagedWorktreeExecutionIdentity,
} from "../code/managedWorktreeNodePorts";
import { ManagedWorktreeService } from "../code/managedWorktreeService";
import { ManagedRootGrantStore } from "../code/managedRootGrantStore";
import { createManagedCodeThreadCreationPort } from "../code/managedCodeThreadCreation";
import { GitMutationPort } from "../code/gitMutationPort";
import { createAgentRunChildWorktreePort } from "../agentRun/agentRunChildWorktreePort";
import { isRoutineHostScope } from "../routineHostScope";
import { makeOpenAiCompatibleDriver } from "../providers/openAiCompatibleDriver";
import { makeAnthropicCompatibleDriver } from "../providers/anthropicCompatibleDriver";
import { makeAzureFoundryDriver } from "../providers/azureFoundryDriver";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import {
  makeCredentialBrokerClient,
  makeMcpServerCredentialBrokerClient,
  type ProviderCredentialResolver,
} from "../providers/credentialBrokerClient";
import { makeProviderApiKeyPool } from "../providers/providerApiKeyPool";
import { createHostOAuthService, extAgentHostIdFor } from "../providers/oauth/hostOAuthService";
import { makeHostOAuthBrokerClient } from "../providers/oauth/hostOAuthBrokerClient";
import { hostOAuthEventJournal } from "../providers/oauth/hostOAuthEventJournal";
import { createProviderDeviceSignInRouteHandler } from "../providers/oauth/providerDeviceSignInRoutes";
import {
  createProviderOAuthRouteHandler,
  type ProviderOAuthRouteDependencies,
} from "../providers/oauth/providerOAuthRoutes";
import { retireClaudeHelperTokens } from "../providers/claudeHelperTokenRetirement";
import { subscriptionOAuthHostFromBroker } from "../providers/oauth/subscriptionOAuthHost";
import { directoryOAuthHostFromBroker } from "../providers/oauth/directoryOAuthHost";
import { readDirectoryOAuthCredential } from "@octant/provider-sdk/directory-oauth";
import type { CompatibleFetch } from "../providers/openAiCompatibleEndpoint";
import { type ClaudeAgentSdkPort, makeClaudeAgentSdkPort } from "../providers/claudeAgentSdkPort";
import type { ClaudeResumeIdentityPort } from "../providers/claudeDriver";
import { type ClaudeProcessPort, makeClaudeProcessLive } from "../providers/claudeProcess";
import { ClaudeResumeIdentityJournal } from "../providers/claudeResumeIdentityJournal";
import { ClaudeResumeIdentityStore } from "../providers/claudeResumeIdentityStore";
import { type CodexProcessPort, makeCodexProcessLive } from "../providers/codexProcess";
import { type AcpProcessPort, makeAcpProcessLive } from "../providers/acpProcess";
import type { AcpProviderKind } from "../providers/acpProfiles";
import {
  makeProviderDriver,
  ProviderDriverConfigurationError,
} from "../providers/providerDriverFactory";
import {
  JournalNativeHarnessTranscriptStore,
  type NativeHarnessTranscriptStore,
} from "../harness/nativeHarnessTranscriptStore";
import { makeOpenCodeProcessLive, type OpenCodeProcessPort } from "../providers/openCodeProcess";
import { makeOhMyPiProcessLive, type OhMyPiProcessPort } from "../providers/ohMyPiProcess";
import { makePiProcessLive, type PiProcessPort } from "../providers/piProcess";
import { createProviderRouteHandler } from "../providers/providerRoutes";
import { createDiscoveryRouteHandler } from "../providers/discoveryRoutes";
import { createProviderFromDiscoveryCandidate } from "../providers/discoveryProviderCreate";
import { makeDiscoveryService } from "../providers/discoveryService";
import { isProviderExecutableAvailable, ProviderService } from "../providers/providerService";
import {
  CANONICAL_REVIEWED_MODEL_MANIFEST,
  refreshReviewedModelManifest,
  ReviewedModelManifest,
} from "../providers/reviewedModelManifest";
import { ProviderUsageLimitsService } from "../providers/providerUsageLimitsService";
import { unavailableLimitsReason } from "../providers/providerLimitsReporting";
import { createProviderUsageLimitsRouteHandler } from "../providers/providerUsageLimitsRoutes";
import { ProviderAccountPlanUsageStore } from "../providers/providerAccountPlanUsageStore";
import { ProviderUsageReadingStore } from "../providers/providerUsageReadingStore";
import { HeldTurnContextFile, heldTurnContext } from "../providers/heldTurnContext";
import { ProviderRuntimeUsageLimitsStore } from "../providers/providerRuntimeUsageLimitsStore";
import { attachProviderRuntimeUsageLimits } from "../providers/providerRuntimeUsageLimitsDriver";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { NativeHarnessLeadFallbackService } from "../harness/nativeHarnessLeadFallback";
import { GeneratedImageStore } from "../image/generatedImageStore";
import { ImageJobService } from "../image/imageJobService";
import { createLocalUsageHistoryRouteHandler } from "../localUsageHistoryRoutes";
import {
  createLocalUsageHistorySourceForDriver,
  localUsageHistorySourceKey,
} from "../providers/providerUsageHistorySources";
import { createExtensionRouteHandler } from "../extensionRoutes";
import { ExtensionApiService } from "../extensions/extensionApiService";
import { ExtensionActivationService } from "../extensions/extensionActivationService";
import { createPersistedExtensionActivationPolicy } from "../extensions/persistedExtensionActivationPolicy";
import { ExtensionLifecycleService } from "../extensions/extensionLifecycleService";
import {
  type ExtensionRuntimeEvidence,
  ExtensionSupervisor,
} from "../extensions/extensionSupervisor";
import { createNodeExtensionProcessPort } from "../extensions/nodeExtensionProcessPort";
import { ExtensionPackageStore } from "../extensions/extensionPackageStore";
import { createStoredExtensionMaterialLoader } from "../extensions/extensionChatResolver";
import {
  isExtensionCompatibilityCompatible,
  isExtensionPackageCompatible,
} from "../extensions/packageInspector";
import {
  type SkillDiscoveryRootProvider,
  SkillDiscoveryService,
} from "../extensions/skillDiscoveryService";
import { createThreadSkillDiscoveryRootProvider } from "../extensions/threadSkillDiscoveryRootProvider";
import { StandaloneSkillService } from "../extensions/standaloneSkillService";
import { ShellSettingsStandaloneSkillActivationStore } from "../extensions/standaloneSkillActivationStore";
import { createCompositeSkillMarketplace } from "../extensions/compositeSkillMarketplace";
import { CodexPluginPackageResolver } from "../extensions/codexPluginResolver";
import { NpmAgentPluginMarketplace } from "../extensions/npmAgentPluginMarketplace";
import { createDefaultCodexPluginPackageSources } from "../extensions/curatedBuildIosAppsCatalog";
import { AgentPluginMcpSessionManager } from "../extensions/agentPluginMcpSessionManager";
import { LocalPluginFolderRegistry } from "../extensions/localPluginFolderRegistry";
import { UserAddedMcpServerStore } from "../extensions/userAddedMcpServers";
import { AgentToolingDiscovery } from "../extensions/agentToolingDiscovery";
import { McpServerSignIn } from "../extensions/mcpServerSignIn";
import { ExtensionProjectPinStore } from "../extensions/extensionProjectPinStore";
import type {
  ExtensionProjectPinListing,
  McpServerSignInView,
} from "@octant/contracts/extension-rpc";
import { validateAgentPluginsMcpDocument } from "@octant/plugin-host/agent-plugins";
import { LocalPluginImportReceiptStore } from "../extensions/localPluginImportReceiptStore";
import { createExtensionToolCallAuthorizer } from "../extensions/extensionToolCallAuthorizer";
import { ExtensionToolGrantStore } from "../extensions/extensionToolGrantStore";
import {
  readApprovalOutsideContent,
  readThreadExternalContentTaint,
} from "../context/externalContentTaintProjection";
import {
  type NativeHarnessEndpointHooks,
  NativeHarnessEndpointRegistry,
} from "../harness/nativeHarnessEndpointRegistry";
import {
  claudePlanUsageStateDirectory,
  defaultShellSettings,
  effectiveClaudeAccountConfigDirectory,
  isImageProfileDriverKind,
} from "@octant/domain";
import { ChatAttachmentStore } from "../chat/chatAttachmentStore";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart, ServerStartupFailed } from "./serverShape";
import type { HarnessStateWiring } from "./harnessState";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { ComputerUseWiring } from "./computerUse";
import type { WorkRequestStateWiring } from "./workRequestState";

export interface ConfiguredProviderDriverOptions {
  readonly openCodeProcess: OpenCodeProcessPort;
  readonly codexProcess: CodexProcessPort;
  readonly acpProcess?: AcpProcessPort;
  readonly acpHome?: (kind: AcpProviderKind, instanceId: ProviderInstance["id"]) => string;
  readonly piProcess?: PiProcessPort;
  readonly piHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly ohMyPiProcess?: OhMyPiProcessPort;
  readonly ohMyPiHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly claudeProcess?: ClaudeProcessPort;
  readonly claudeSdk?: ClaudeAgentSdkPort;
  readonly claudeResumeIdentityPort?: ClaudeResumeIdentityPort;
  readonly isProjectConfinedPath?: (projectRoot: string, absolutePath: string) => boolean;
  readonly claudeInstances?: ReadonlyArray<ProviderInstance>;
  readonly codexInstances?: ReadonlyArray<ProviderInstance>;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly permissionPersistence: () => PermissionPersistence;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly subscriptionOAuth?: import("@octant/provider-sdk/subscription-oauth").SubscriptionOAuthHost;
  readonly directoryOAuth?: import("@octant/provider-sdk/directory-oauth").DirectoryOAuthHost;
  readonly fetch?: CompatibleFetch;
  /** Shared by every harness driver built from these options, so a later turn can resume an earlier one. */
  readonly nativeHarnessTranscripts?: NativeHarnessTranscriptStore;
  /** How every harness driver built from these options retries and where its lead falls back. */
  readonly nativeHarness?: NativeHarnessEndpointHooks;
  readonly onRuntimeEvent?: (event: ProviderRuntimeEvent) => void;
  readonly admittedDriverKinds?: ReadonlySet<ProviderDriverKind>;
  readonly localUsageHistorySourceForInstance?: (
    instance: ProviderInstance,
  ) => ProviderLocalUsageHistorySource | undefined;
}

export function makeConfiguredProviderDriver(
  instance: ProviderInstance,
  options: ConfiguredProviderDriverOptions,
): ProviderDriver {
  if (!instance.enabled) {
    throw new Error("Provider instance is disabled.");
  }
  if (isImageProfileDriverKind(instance.driverKind)) {
    throw new ProviderDriverConfigurationError();
  }
  const admitted = options.admittedDriverKinds ?? admittedBundledProviderDriverKinds();
  if (!admitted.has(instance.driverKind)) {
    throw new Error("Provider driver plugin is not effective.");
  }
  let driver: ProviderDriver;
  if (instance.driverKind === "openai-compatible") {
    driver = runDirectEndpointOnNativeHarness(
      makeOpenAiCompatibleDriver({
        instanceId: instance.id,
        configuration: instance.configuration,
        runtimeRegistry: options.runtimeRegistry,
        ...(options.credentialResolver === undefined
          ? {}
          : { credentialResolver: options.credentialResolver }),
        ...(options.subscriptionOAuth === undefined
          ? {}
          : { subscriptionOAuth: options.subscriptionOAuth }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      instance,
      options,
    );
  } else if (instance.driverKind === "anthropic-compatible") {
    driver = runDirectEndpointOnNativeHarness(
      makeAnthropicCompatibleDriver({
        instanceId: instance.id,
        configuration: instance.configuration,
        runtimeRegistry: options.runtimeRegistry,
        ...(options.credentialResolver === undefined
          ? {}
          : { credentialResolver: options.credentialResolver }),
        ...(options.subscriptionOAuth === undefined
          ? {}
          : { subscriptionOAuth: options.subscriptionOAuth }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      instance,
      options,
    );
  } else if (instance.driverKind === "azure-foundry") {
    driver = runDirectEndpointOnNativeHarness(
      makeAzureFoundryDriver({
        instanceId: instance.id,
        configuration: instance.configuration,
        runtimeRegistry: options.runtimeRegistry,
        ...(options.credentialResolver === undefined
          ? {}
          : { credentialResolver: options.credentialResolver }),
        ...(options.directoryOAuth === undefined ? {} : { directoryOAuth: options.directoryOAuth }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      instance,
      options,
    );
  } else {
    driver = makeProviderDriver(instance, {
      openCodeProcess: options.openCodeProcess,
      codexProcess: options.codexProcess,
      runtimeRegistry: options.runtimeRegistry,
      permissionPersistence: options.permissionPersistence,
      ...(options.acpProcess === undefined ? {} : { acpProcess: options.acpProcess }),
      ...(options.acpHome === undefined ? {} : { acpHome: options.acpHome }),
      ...(options.piProcess === undefined ? {} : { piProcess: options.piProcess }),
      ...(options.piHome === undefined ? {} : { piHome: options.piHome }),
      ...(options.ohMyPiProcess === undefined ? {} : { ohMyPiProcess: options.ohMyPiProcess }),
      ...(options.ohMyPiHome === undefined ? {} : { ohMyPiHome: options.ohMyPiHome }),
      ...(options.claudeProcess === undefined ? {} : { claudeProcess: options.claudeProcess }),
      ...(options.claudeSdk === undefined ? {} : { claudeSdk: options.claudeSdk }),
      ...(options.claudeResumeIdentityPort === undefined
        ? {}
        : { claudeResumeIdentityPort: options.claudeResumeIdentityPort }),
      ...(options.isProjectConfinedPath === undefined
        ? {}
        : { isProjectConfinedPath: options.isProjectConfinedPath }),
      ...(options.claudeInstances === undefined
        ? {}
        : { claudeInstances: options.claudeInstances }),
      ...(options.codexInstances === undefined ? {} : { codexInstances: options.codexInstances }),
      ...(options.credentialResolver === undefined
        ? {}
        : { credentialResolver: options.credentialResolver }),
      ...(options.nativeHarnessTranscripts === undefined
        ? {}
        : { nativeHarnessTranscripts: options.nativeHarnessTranscripts }),
      ...(options.nativeHarness === undefined ? {} : { nativeHarness: options.nativeHarness }),
    });
  }
  const localUsageHistory = options.localUsageHistorySourceForInstance?.(instance);
  if (localUsageHistory !== undefined) {
    driver = { ...driver, localUsageHistory };
  }
  return options.onRuntimeEvent === undefined
    ? driver
    : attachProviderRuntimeUsageLimits(driver, { record: options.onRuntimeEvent });
}

/**
 * A direct endpoint driver on the host's harness. Its sessions are journaled,
 * so a Chat or Work follow-up continues the last one, and the host can always
 * rebuild the history when it cannot.
 */
function runDirectEndpointOnNativeHarness(
  driver: HarnessEndpointDriver,
  instance: ProviderInstance,
  options: ConfiguredProviderDriverOptions,
): ProviderDriver {
  return runOnNativeHarness(driver, {
    instanceId: instance.id,
    runtimeRegistry: options.runtimeRegistry,
    conversationOwnership: "host-resumable",
    ...(options.nativeHarnessTranscripts === undefined
      ? {}
      : { transcripts: options.nativeHarnessTranscripts }),
    ...(options.nativeHarness === undefined ? {} : { harness: options.nativeHarness }),
  });
}

export function pathIsProjectConfined(projectRoot: string, absolutePath: string): boolean {
  if (
    !isAbsolute(projectRoot) ||
    resolve(projectRoot) !== projectRoot ||
    !isAbsolute(absolutePath) ||
    resolve(absolutePath) !== absolutePath
  ) {
    return false;
  }
  try {
    const canonicalRoot = realpathSync(projectRoot);
    if (canonicalRoot !== projectRoot) return false;
    let nearestExistingPath = absolutePath;
    while (true) {
      try {
        lstatSync(nearestExistingPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        const parent = dirname(nearestExistingPath);
        if (parent === nearestExistingPath) return false;
        nearestExistingPath = parent;
      }
    }
    return isPathWithin(canonicalRoot, realpathSync(nearestExistingPath));
  } catch {
    return false;
  }
}

/** The credential store's answer for an instance that holds no credential. */
function isMissingCredential(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === "unauthenticated"
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  const confined = relative(root, candidate);
  return (
    confined === "" ||
    (confined !== ".." && !confined.startsWith(`..${sep}`) && !isAbsolute(confined))
  );
}

export type ProvidersDependencies = Pick<
  ServerStart,
  "latencyStats" | "options" | "persistence" | "version"
> &
  Pick<
    AuthorityWiring,
    | "extensionToolApprovalService"
    | "isPairedDeviceScope"
    | "processAuthorityNow"
    | "windowAuthorityStore"
  > &
  Pick<
    AgentRunsWiring,
    | "agentRunChildWorktree"
    | "agentRunProcessSupervisor"
    | "agentRunSessionStore"
    | "externalContentIngestionStore"
    | "managedWorktreeReceipts"
    | "nativeHarnessRouter"
  > &
  Pick<HarnessStateWiring, "nativeHarnessSessions"> &
  Pick<IntegrationsWiring, "githubExtensionSnapshot"> &
  Pick<ComputerUseWiring, "computerUseProcess"> &
  Pick<WorkRequestStateWiring, "workRequestRuntime"> &
  Pick<FoundationsWiring, "providerRuntimeRegistry" | "workThreadProjection">;

export function wireProviders(deps: ProvidersDependencies) {
  const {
    agentRunChildWorktree,
    agentRunProcessSupervisor,
    agentRunSessionStore,
    computerUseProcess,
    extensionToolApprovalService,
    externalContentIngestionStore,
    githubExtensionSnapshot,
    isPairedDeviceScope,
    managedWorktreeReceipts,
    nativeHarnessRouter,
    nativeHarnessSessions,
    options,
    persistence,
    processAuthorityNow,
    providerRuntimeRegistry,
    version,
    windowAuthorityStore,
    workThreadProjection,
    workRequestRuntime,
  } = deps;
  return Effect.gen(function* () {
    const codeThreadDrivers = new Map<
      string,
      { readonly instanceId: string; readonly version: number; readonly driver: ProviderDriver }
    >();
    const providerDataDirectory = persistence.dataDirectory;
    // What each provider-owned session already holds outlives this process, as
    // the runtime's own history does, so a resumed session's first turn after
    // a restart is sent only what is new.
    heldTurnContext.persistTo(
      new HeldTurnContextFile(join(providerDataDirectory, "providers", "held-turn-context.json")),
    );
    const providerRuntimeUsageLimitsStore = new ProviderRuntimeUsageLimitsStore();
    const providerAccountPlanUsageStore = new ProviderAccountPlanUsageStore(
      join(providerDataDirectory, "providers", "plan-usage.json"),
    );
    void providerAccountPlanUsageStore.load().catch(() => undefined);
    let providerUsageLimitsServiceRef: ProviderUsageLimitsService | undefined;
    const recordProviderRuntimeUsage = (event: ProviderRuntimeEvent): void => {
      providerRuntimeUsageLimitsStore.record(event);
      if (event.kind === "rate-limit-window" || event.kind === "rate-limit-bucket") {
        // Saved as it arrives, so a host that closes before the next poll
        // keeps the reading.
        providerUsageLimitsServiceRef?.noteRuntimeEvidence();
      }
      if (event.kind !== "rate-limit-window") return;
      const instance = persistence
        .readProviderInstances()
        .find((candidate) => String(candidate.id) === String(event.instanceId));
      if (instance === undefined) return;
      const directory = claudePlanUsageStateDirectory(instance, homedir());
      if (directory === undefined) return;
      void providerAccountPlanUsageStore.recordWindow(event, directory).catch(() => undefined);
    };
    const openCodeProcess = options.openCodeProcess ?? makeOpenCodeProcessLive();
    const codexProcess = options.codexProcess ?? makeCodexProcessLive({ octantVersion: version });
    const acpProcess = options.acpProcess ?? makeAcpProcessLive();
    const piProcess = options.piProcess ?? makePiProcessLive();
    const ohMyPiProcess = options.ohMyPiProcess ?? makeOhMyPiProcessLive();
    const extensionPackageStore = new ExtensionPackageStore({
      dataDirectory: providerDataDirectory,
      uuid: randomUUID,
    });
    let recordExtensionRuntimeEvidence: ((event: ExtensionRuntimeEvidence) => void) | undefined;
    const extensionSupervisor =
      options.extensionSupervisor ??
      new ExtensionSupervisor({
        process: createNodeExtensionProcessPort({
          receiptDirectory: join(providerDataDirectory, "extensions", "runtime-receipts"),
        }),
        clock: () => new Date().toISOString(),
        authorizeLaunch: (input) => extensionPackageStore.authorizeRuntimeLaunch(input),
        evidence: (event) => recordExtensionRuntimeEvidence?.(event),
      });
    const extensionLifecycleService = new ExtensionLifecycleService({
      connection: persistence.connection,
      journal: persistence.journal,
      store: extensionPackageStore,
      supervisor: extensionSupervisor,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      isCompatible: (manifest) => isExtensionPackageCompatible(manifest, version, process.platform),
    });
    recordExtensionRuntimeEvidence = (event) =>
      extensionLifecycleService.recordRuntimeEvidence(event);
    const userGlobalSkillsRoot = join(homedir(), ".agents", "skills");
    const threadSkillRoots = createThreadSkillDiscoveryRootProvider({
      readProjects: () =>
        persistence.readProjects({ lifecycle: "active" }).flatMap((project) => {
          if (project.type === "chat") return [];
          const revision = project.bindingHistory.at(-1);
          return revision === undefined
            ? []
            : [
                {
                  id: project.id,
                  mode: project.type,
                  root: project.binding.canonicalRoot,
                  bindingRevisionId: revision.revisionId,
                },
              ];
        }),
      readThreads: () => [
        ...persistence.readCodeThreads().map((thread) => ({ ...thread, mode: "code" as const })),
        ...workThreadProjection.list().map((thread) => ({ ...thread, mode: "work" as const })),
      ],
      resolveWorkingDirectory: resolveThreadWorkingDirectory,
      userGlobalSkillsRoot,
    });
    const extensionSkillRoots: SkillDiscoveryRootProvider = options.extensionSkillRoots ?? {
      resolve: async () => {
        const roots = await threadSkillRoots.resolve();
        return roots.length > 0
          ? roots
          : [
              {
                workingDirectory: process.cwd(),
                projectRoot: process.cwd(),
                projectRef: "server-working-directory",
                userGlobalSkillsRoot,
              },
            ];
      },
    };
    const skillDiscoveryService = new SkillDiscoveryService({ roots: extensionSkillRoots });
    const isMarketplaceFetchAllowed = () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings())
        .marketplaceFetchesEnabled;
    const skillMarketplace =
      options.skillMarketplace ??
      createCompositeSkillMarketplace({
        appVersion: version,
        platform: process.platform,
        isMarketplaceFetchAllowed,
      });
    const standaloneSkillService = new StandaloneSkillService({
      discovery: skillDiscoveryService,
      lifecycle: extensionLifecycleService,
      marketplace: skillMarketplace,
      activationStore: new ShellSettingsStandaloneSkillActivationStore({ persistence }),
    });
    const refreshStandaloneSkills: () => Promise<void> = async () => {
      await standaloneSkillService.reconcile();
    };
    yield* Effect.tryPromise({
      try: async () => {
        await extensionPackageStore.initialize();
        await providerRuntimeRegistry.reconcile();
        await options.codeOperationRuntime?.reconcile?.();
        await computerUseProcess.reconcile?.();
        await agentRunProcessSupervisor.reconcile?.();
        await extensionSupervisor.reconcile?.();
        await extensionLifecycleService.reconcileStartup();
        await standaloneSkillService.reconcile();
      },
      catch: () =>
        new ServerStartupFailed({
          category: "server-unavailable",
          message: "Octant extension storage requires recovery.",
        }),
    });
    const localPluginFolderRegistry =
      options.localPluginFolderRegistry ??
      new LocalPluginFolderRegistry({
        appVersion: version,
        platform: process.platform,
        statePath: join(providerDataDirectory, "extensions", "local-plugin-folders.json"),
      });
    yield* Effect.promise(() => localPluginFolderRegistry.initialize());
    // The packages the host writes for MCP servers a person adds by hand live
    // in the host's own folder, registered under their own source kind, with
    // their secret values in the broker's namespace for them.
    const userAddedPluginRegistry = new LocalPluginFolderRegistry({
      appVersion: version,
      platform: process.platform,
      statePath: join(providerDataDirectory, "extensions", "user-added-servers.json"),
      sourceKind: "user-added",
    });
    yield* Effect.promise(() => userAddedPluginRegistry.initialize());
    // Sign-in to a hosted server needs the host OAuth service, which is made
    // further down once the broker is known; the holder lets the session
    // manager and the routes reach it from here.
    const mcpServerSignInHolder: { current: McpServerSignIn | undefined } = { current: undefined };
    const signInOrUnavailable = async (
      run: (signIn: McpServerSignIn) => Promise<McpServerSignInView>,
    ): Promise<McpServerSignInView> =>
      mcpServerSignInHolder.current === undefined
        ? {
            kind: "refused",
            reason: "unavailable",
            message: "Signing in needs the credential broker.",
          }
        : run(mcpServerSignInHolder.current);
    const userAddedMcpServers = new UserAddedMcpServerStore({
      directory: join(providerDataDirectory, "extensions", "user-added"),
      registry: userAddedPluginRegistry,
      ...(options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? {}
        : {
            secrets: makeMcpServerCredentialBrokerClient({
              url: options.credentialBrokerUrl,
              token: options.credentialBrokerToken,
            }),
          }),
    });
    // What Claude Code and Codex keep on this computer, read for a local
    // window to pick from; Octant never writes to their files.
    const agentToolingDiscovery = new AgentToolingDiscovery({
      home: homedir(),
      projectRoots: () =>
        persistence
          .readProjects({ lifecycle: "active" })
          .flatMap((project) =>
            "binding" in project &&
            typeof project.binding === "object" &&
            project.binding !== null &&
            "canonicalRoot" in project.binding &&
            typeof project.binding.canonicalRoot === "string"
              ? [project.binding.canonicalRoot]
              : [],
          ),
      env: process.env,
      parseToml: (text) => Bun.TOML.parse(text),
    });
    const extensionPackageResolver =
      options.extensionPackageResolver ??
      new CodexPluginPackageResolver({
        ...(options.codexPluginPackageSources ?? createDefaultCodexPluginPackageSources()),
        localFolderRegistry: localPluginFolderRegistry,
        userAddedRegistry: userAddedPluginRegistry,
        isMarketplaceFetchAllowed,
        agentPluginCatalog: new NpmAgentPluginMarketplace({
          appVersion: version,
          platform: process.platform,
          isMarketplaceFetchAllowed,
        }),
      });
    // A pin offers a plugin on every Work or Code turn in one Project. The
    // turn's extension resolver turns each pinned id into a selection against
    // the Project's current catalog, so a pin to a package that is not
    // installed, trusted and switched on is skipped rather than failing the turn.
    const extensionProjectPinStore = new ExtensionProjectPinStore({
      journal: persistence.journal,
      connection: persistence.connection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const pinnedExtensionIds = (projectId: string): ReadonlyArray<string> =>
      extensionProjectPinStore.list(projectId);
    const extensionToolGrantStore = new ExtensionToolGrantStore({
      journal: persistence.journal,
      connection: persistence.connection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const agentPluginMcpSessionManager =
      options.agentPluginMcpSessionManager ??
      new AgentPluginMcpSessionManager({
        store: extensionPackageStore,
        authorizeToolCall: createExtensionToolCallAuthorizer({
          grants: extensionToolGrantStore,
          approvals: extensionToolApprovalService,
          isHostScope: isRoutineHostScope,
          isPairedDeviceScope,
          threadTainted: (threadId) =>
            readThreadExternalContentTaint(persistence.connection, threadId)
              .externalContentIngested,
          outsideContent: (threadId) =>
            readApprovalOutsideContent(persistence.connection, threadId),
        }),
        recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
        isUserAddedSource: (sourceRef) => userAddedMcpServers.owns(sourceRef),
        resolveUserAddedSecrets: async (launch, target) => {
          const withSecrets = await userAddedMcpServers.resolveLaunchSecrets(launch);
          const signIn = mcpServerSignInHolder.current;
          return signIn === undefined
            ? withSecrets
            : signIn.attachBearer(target.extensionId, target.componentId, withSecrets);
        },
        ...(extensionSupervisor instanceof ExtensionSupervisor
          ? { stdioSupervisor: extensionSupervisor }
          : {}),
      });
    const persistedExtensionActivationPolicy = createPersistedExtensionActivationPolicy({
      readProject: (projectId) => persistence.readProject(projectId),
      readChatThread: (threadId) => persistence.readChatThread(threadId),
      readWorkThread: (threadId) => workThreadProjection.read(threadId),
      readCodeThread: (threadId) => persistence.readCodeThread(threadId),
    });
    const extensionActivationService = new ExtensionActivationService({
      policy: options.extensionActivationPolicy ?? persistedExtensionActivationPolicy,
      compatibility: (packageState) =>
        isExtensionCompatibilityCompatible(packageState.compatibility, version, process.platform),
      catalogStatus:
        options.extensionCatalogStatus ??
        (() => (extensionPackageResolver.searchCatalog === undefined ? "offline" : "available")),
    });
    const extensionApiService = new ExtensionApiService({
      lifecycle: extensionLifecycleService,
      resolver: extensionPackageResolver,
      skills: standaloneSkillService,
      activation: {
        resolve: (snapshot, query) =>
          agentPluginMcpSessionManager.projectEffectiveState(
            extensionActivationService.resolve(snapshot, query),
          ),
      },
      onStateChanged: async (snapshot, command) => {
        // Uninstall, rollback, and withdrawn trust end the package's remembered
        // tool approvals, so bringing it back restores none of them.
        extensionToolGrantStore.revokeForLifecycleChange(command);
        if (
          command.kind === "uninstall-package" &&
          !snapshot.packages.some((candidate) => candidate.extensionId === command.extensionId)
        ) {
          extensionProjectPinStore.forgetExtension(String(command.extensionId));
        }
        // Settings has no thread authority. Drain only package/components whose
        // lifecycle state changed; unrelated in-flight MCP calls remain intact.
        await agentPluginMcpSessionManager.reconcileLifecycleSnapshot(snapshot);
      },
      userAddedMcpServers: {
        owns: (sourceRef) => userAddedMcpServers.owns(sourceRef),
        remove: async (sourceRef, extensionId) => {
          await mcpServerSignInHolder.current?.forgetPackage(extensionId);
          await userAddedMcpServers.remove(sourceRef);
        },
      },
    });
    const resolveSelectedExtensions = createSelectedExtensionResolver({
      snapshot: async () => {
        await standaloneSkillService.reconcile();
        return extensionApiService.snapshot();
      },
      resolveEffectiveState: (snapshot, query) =>
        extensionActivationService.resolve(snapshot, query),
      providerFamily: (thread) => {
        const instance = persistence.readProviderInstance(thread.providerInstanceId);
        return instance === undefined
          ? undefined
          : Schema.decodeUnknownSync(ExtensionProviderFamily)(instance.driverKind);
      },
      reconcileEffectiveState: async (effective) => {
        await agentPluginMcpSessionManager.reconcile(effective);
        return agentPluginMcpSessionManager.projectEffectiveState(effective);
      },
      materialLoader: createStoredExtensionMaterialLoader(extensionPackageStore, {
        mcpToolsForComponent: ({ packageId, componentId, scope }) =>
          agentPluginMcpSessionManager.toolDefinitionsFor(packageId, componentId, scope),
      }),
      toolExecution:
        options.extensionToolExecution ?? agentPluginMcpSessionManager.createToolExecutionPort(),
      carriesAppManagedTools: (thread) => {
        const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
        return (
          observed?.capabilities.appManagedTools === "supported" ||
          observed?.verifiedToolModelIds?.some(
            (candidate) => String(candidate) === String(thread.modelId),
          ) === true
        );
      },
    });
    githubExtensionSnapshot.read = () => extensionApiService.snapshot();
    const extensionRoutes = createExtensionRouteHandler({
      service: extensionApiService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      ...(options.desktopBridgeSecret === undefined
        ? {}
        : { desktopBridgeSecret: options.desktopBridgeSecret }),
      localPluginFolderRegistry,
      localPluginImportReceipts: new LocalPluginImportReceiptStore(),
      userAddedMcpServers,
      agentToolingDiscovery,
      extensionProjectPins: {
        list: () => ({
          projects: persistence
            .readProjects({ lifecycle: "active" })
            .flatMap((project) =>
              project.type === "work" || project.type === "code"
                ? [{ projectId: project.id, name: project.name, type: project.type }]
                : [],
            ),
          pins: extensionProjectPinStore.listAll().map((pin) => ({
            projectId: pin.projectId as ExtensionProjectPinListing["pins"][number]["projectId"],
            extensionId:
              pin.extensionId as ExtensionProjectPinListing["pins"][number]["extensionId"],
          })),
        }),
        set: (projectId, extensionId, pinned) => {
          const project = persistence.readProject(decodeProjectId(projectId));
          if (project === undefined || project.lifecycle !== "active" || project.type === "chat") {
            return "refused";
          }
          return extensionProjectPinStore.set(projectId, extensionId, pinned);
        },
      },
      mcpServerSignIn: {
        status: (extensionId, componentId, principalKind) =>
          signInOrUnavailable((signIn) => signIn.status(extensionId, componentId, principalKind)),
        begin: (extensionId, componentId, principalKind) =>
          signInOrUnavailable((signIn) => signIn.begin(extensionId, componentId, principalKind)),
        poll: (extensionId, componentId, attemptId, principalKind) =>
          signInOrUnavailable((signIn) =>
            signIn.poll(extensionId, componentId, attemptId, principalKind),
          ),
        signOut: (extensionId, componentId, principalKind) =>
          signInOrUnavailable((signIn) => signIn.signOut(extensionId, componentId, principalKind)),
      },
      toolApprovals: extensionToolApprovalService,
      toolGrants: extensionToolGrantStore,
    });
    const managedWorktreePorts = createManagedWorktreeNodePorts();
    const managedWorktreeService = new ManagedWorktreeService({
      grants: new ManagedRootGrantStore(randomUUID, processAuthorityNow),
      receipts: managedWorktreeReceipts,
      ...managedWorktreePorts,
      authority: {
        observeCleanupEligibility: async ({ repositoryId, threadId, checkoutId }) => {
          const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
          const checkout = persistence.readCodeCheckout(decodeCodeCheckoutId(checkoutId));
          if (
            thread === undefined ||
            checkout === undefined ||
            thread.repositoryId !== repositoryId ||
            thread.checkoutId !== checkoutId
          ) {
            return { status: "unavailable" as const };
          }
          return {
            status: "eligible" as const,
            active: thread.lifecycle === "active",
            delivered: true,
            checkoutId: decodeCodeCheckoutId(checkoutId),
            repositoryId: decodeCodeRepositoryId(repositoryId),
          };
        },
      },
      now: Date.now,
    });
    agentRunChildWorktree.current = createAgentRunChildWorktreePort({
      service: managedWorktreeService,
      repository: managedWorktreePorts.repository,
      observeExecutionIdentity: observeManagedWorktreeExecutionIdentity,
      loadReceipt: (receiptId) => managedWorktreeReceipts.load(receiptId),
      findActive: (lookup) => managedWorktreeReceipts.findActive(lookup),
    });
    const managedWorktreeRefsList: CodeWorktreeRefsPort["list"] = async (input, signal) => {
      const project = persistence.readProject(input.projectId);
      if (project?.type !== "code") return [];
      const entries = await listWorktreeRefs(project.binding.canonicalRoot, signal);
      return entries.map((entry) => decodeCodeWorktreeRef(entry));
    };
    const managedWorktreeSourcePreview: CodeWorktreeSourcePreviewPort["preview"] = async (
      input,
      signal,
    ) => {
      const project = persistence.readProject(input.projectId);
      if (project?.type !== "code") return { kind: "failed", reason: "unavailable" };
      const revision = project.bindingHistory.at(-1);
      if (revision === undefined || revision.revisionId !== input.bindingRevisionId) {
        return { kind: "failed", reason: "unavailable" };
      }
      const result = await managedWorktreeService.previewSource(
        {
          repositoryId: input.repositoryId,
          repositoryRoot: project.binding.canonicalRoot,
          refIntent: input.refIntent,
          startFromOrigin: input.startFromOrigin,
          ...(input.remoteName === undefined ? {} : { remoteName: input.remoteName }),
        },
        signal,
      );
      if (result.status === "origin") {
        return decodeCodeWorktreeSourcePreview({
          kind: "origin",
          remoteName: result.remoteName,
          branch: result.branch,
          resolvedHead: result.resolvedHead,
          fetchedAt: result.fetchedAt,
        });
      }
      if (result.status === "local") {
        return decodeCodeWorktreeSourcePreview(
          result.remoteName === undefined
            ? { kind: "local", branch: result.branch, resolvedHead: result.resolvedHead }
            : {
                kind: "local",
                branch: result.branch,
                resolvedHead: result.resolvedHead,
                remoteName: result.remoteName,
              },
        );
      }
      return { kind: "failed", reason: result.reason };
    };
    // Its own mutation port: laying a fork's files down happens once, in a
    // worktree no thread is bound to yet, so nothing else is serialized on it.
    const forkFileWriter = new GitMutationPort();
    const managedCodeThreadCreation = createManagedCodeThreadCreationPort({
      readProject: (projectId) => persistence.readProject(projectId),
      service: managedWorktreeService,
      repository: managedWorktreePorts.repository,
      clock: () => new Date().toISOString(),
      applySourceFiles: async ({ worktreeRoot, files }, signal) => {
        const applied = await forkFileWriter.restoreWorkingTree(
          { checkoutRoot: worktreeRoot, snapshot: files, executionPolicy: "approval-gated" },
          signal,
        );
        return applied.status === "applied" ? "applied" : "failed";
      },
    });
    const acpHome =
      options.acpHome ??
      ((kind: AcpProviderKind, instanceId: ProviderInstance["id"]) =>
        join(providerDataDirectory, "providers", kind, instanceId));
    const piHome =
      options.piHome ??
      ((instanceId: ProviderInstance["id"]) =>
        join(providerDataDirectory, "providers", "pi", instanceId));
    const ohMyPiHome =
      options.ohMyPiHome ??
      ((instanceId: ProviderInstance["id"]) =>
        join(providerDataDirectory, "providers", "oh-my-pi", instanceId));
    const claudeProcess =
      options.claudeProcess ??
      makeClaudeProcessLive({
        onProcessStarted: (process) => {
          return providerRuntimeRegistry.trackProcess(`claude:${process.pid}`, process);
        },
      });
    const claudeSdk =
      options.claudeSdk ?? makeClaudeAgentSdkPort({ spawnClaudeCodeProcess: claudeProcess.spawn });
    const claudeResumeIdentityStore =
      options.claudeResumeIdentityStore ??
      new ClaudeResumeIdentityStore({
        journal: new ClaudeResumeIdentityJournal({
          persistence,
          uuid: randomUUID,
          clock: () => new Date().toISOString(),
        }),
      });
    const nativeHarnessTranscripts = new JournalNativeHarnessTranscriptStore({
      journal: persistence.journal,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    // Each direct endpoint is registered here as its driver is built, and its lead
    // asks the fallback (built below, from the options these hooks are part
    // of) where to go when its own model stays down.
    const nativeHarnessEndpoints = new NativeHarnessEndpointRegistry();
    const nativeHarnessEndpointHooks: NativeHarnessEndpointHooks = {
      endpoints: nativeHarnessEndpoints,
      // What a request teaches about its model's window is kept with the
      // provider's model catalogue; requests only run once the service exists.
      contextWindows: {
        remember: (instanceId, modelId, lesson) =>
          providerService.rememberModelContextWindow(instanceId, modelId, lesson),
      },
      leadFallback: {
        next: (input) => nativeHarnessLeadFallback.next(input),
      },
    };
    const isProjectConfinedPath = options.isProjectConfinedPath ?? pathIsProjectConfined;
    const credentialBroker =
      options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? undefined
        : makeCredentialBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          });
    const credentialResolver =
      credentialBroker === undefined ? undefined : makeProviderApiKeyPool(credentialBroker);
    // The retirement reads the stored value as it is, so it asks the broker
    // and not the key pool, which answers with one key of a pool.
    void retireClaudeHelperTokens({
      dataDirectory: persistence.dataDirectory,
      broker: credentialBroker,
      instances: persistence.readProviderInstances(),
      removedInstanceIds: persistence.readRemovedProviderInstanceIds?.() ?? [],
    }).catch(() => undefined);
    const oauthBroker =
      options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? undefined
        : makeHostOAuthBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          });
    const oauthJournal =
      oauthBroker === undefined
        ? undefined
        : hostOAuthEventJournal({
            journal: persistence.journal,
            connection: persistence.connection,
            uuid: randomUUID,
            now: () => new Date().toISOString(),
          });
    const hostOAuth =
      oauthBroker === undefined || oauthJournal === undefined
        ? undefined
        : createHostOAuthService({
            journal: oauthJournal,
            broker: oauthBroker,
            // The ChatGPT plan sign-in registers this host under a stable id
            // before the first sign-in.
            extAgentHostId: extAgentHostIdFor(persistence.dataDirectory),
          });
    if (hostOAuth !== undefined && oauthJournal !== undefined) {
      for (const acknowledgment of oauthJournal.acknowledgments()) {
        hostOAuth.restoreAcknowledgment(acknowledgment);
      }
    }
    if (hostOAuth !== undefined && oauthBroker !== undefined) {
      mcpServerSignInHolder.current = new McpServerSignIn({
        statePath: join(providerDataDirectory, "extensions", "mcp-server-sign-ins.json"),
        oauth: hostOAuth,
        access: (credentialRef) => oauthBroker.access(credentialRef),
        actorId: OCTANT_LOCAL_ACTOR_ID,
        // The address a user-added server's package names, read from the
        // installed package itself so a sign-in can only ever target the
        // server the person added.
        serverUrl: async (extensionId, componentId) => {
          const packageState = extensionLifecycleService
            .snapshot()
            .packages.find((candidate) => candidate.extensionId === extensionId);
          if (packageState === undefined || packageState.source.kind !== "user-added") {
            return undefined;
          }
          const componentState = packageState.components.find(
            (candidate) => candidate.component.id === componentId,
          );
          if (componentState?.component.kind !== "mcp-server") return undefined;
          let raw: unknown;
          try {
            raw = JSON.parse(
              await extensionPackageStore.readVerifiedConfiguration(
                {
                  extensionId,
                  packageId: packageState.packageId,
                  version: packageState.version,
                  digest: packageState.digest,
                },
                componentId,
              ),
            );
          } catch {
            return undefined;
          }
          const document = validateAgentPluginsMcpDocument(raw, {
            pluginSchema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          });
          const server = document.servers.find(
            (candidate) => candidate.name === componentState.component.displayName,
          );
          return server !== undefined && server.type !== "stdio" ? server.url : undefined;
        },
      });
    }
    const subscriptionOAuth =
      oauthBroker === undefined ? undefined : subscriptionOAuthHostFromBroker(oauthBroker);
    const directoryOAuth =
      oauthBroker === undefined ? undefined : directoryOAuthHostFromBroker(oauthBroker);
    // Clearing an instance's credential also forgets an organization
    // sign-in's grant: the pointer is the only reference to it, so deleting
    // the pointer alone would leave a live refresh token in the broker.
    const clearProviderCredential = async (instanceId: string): Promise<void> => {
      if (credentialBroker === undefined || credentialResolver === undefined) return;
      let stored: string | undefined;
      try {
        stored = await credentialBroker.resolve(instanceId);
      } catch (error) {
        // Only a missing credential means there is no pointer. A store that
        // could not be read may still hold one, and deleting it unread would
        // orphan its grant, so the change is refused instead.
        if (!isMissingCredential(error)) throw error;
        stored = undefined;
      }
      const pointer = stored === undefined ? undefined : readDirectoryOAuthCredential(stored);
      if (pointer !== undefined) await oauthBroker?.forget(pointer.credentialRef);
      await credentialResolver.delete(instanceId);
    };
    const providerService = new ProviderService({
      persistence,
      runtimeRegistry: providerRuntimeRegistry,
      isProviderExecutableAvailable,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      clearResumeIdentities: async (instanceId) => {
        const signal = new AbortController().signal;
        await Promise.all([
          claudeResumeIdentityStore.removeProvider(instanceId, signal),
          agentRunSessionStore.removeProviderIdentities(instanceId, signal),
        ]);
      },
      clearRuntimeUsageLimits: (instanceId) => {
        providerRuntimeUsageLimitsStore.clear(instanceId);
        // This also runs when a provider is reconfigured or probed. The saved
        // plan snapshot outlives those, and goes only with the account.
        if (persistence.readProviderInstance(instanceId) === undefined) {
          void providerAccountPlanUsageStore.forget(instanceId).catch(() => undefined);
        }
      },
      ...(credentialResolver === undefined ? {} : { clearProviderCredential }),
      driver: (instance) =>
        attachWorkRequestRuntime(
          makeConfiguredProviderDriver(instance, {
            openCodeProcess,
            codexProcess,
            acpProcess,
            acpHome,
            piProcess,
            piHome,
            ohMyPiProcess,
            ohMyPiHome,
            nativeHarnessTranscripts,
            nativeHarness: nativeHarnessEndpointHooks,
            claudeProcess,
            claudeSdk,
            claudeResumeIdentityPort: claudeResumeIdentityStore,
            isProjectConfinedPath,
            claudeInstances: persistence.readProviderInstances(),
            codexInstances: persistence.readProviderInstances(),
            runtimeRegistry: providerRuntimeRegistry,
            permissionPersistence: () => persistence.readProviderDefaults().permissionPersistence,
            onRuntimeEvent: recordProviderRuntimeUsage,
            ...(credentialResolver === undefined ? {} : { credentialResolver }),
            ...(subscriptionOAuth === undefined ? {} : { subscriptionOAuth }),
            ...(directoryOAuth === undefined ? {} : { directoryOAuth }),
          }),
          () => workRequestRuntime,
        ),
    });
    const probeProviderForThreads: (
      providerInstanceId: ProviderInstance["id"],
    ) => Promise<ProviderProbeResult> = (providerInstanceId) =>
      providerService.probe(LOCAL_HOST_ID as never, providerInstanceId);
    const reviewedModelManifest = new ReviewedModelManifest();
    // Model classification tracks the canonical manifest branch by commit
    // rather than by app release. It is opt-in so the local-first default
    // reaches no remote, and background so a refused refresh only leaves the
    // built-in conservative limits in place.
    if (process.env.OCTANT_REVIEWED_MODEL_MANIFEST === "1") {
      void refreshReviewedModelManifest({ reference: CANONICAL_REVIEWED_MODEL_MANIFEST })
        .then((refresh) => reviewedModelManifest.accept(refresh))
        .catch(() => undefined);
    }
    const providerRoutes = createProviderRouteHandler({
      service: providerService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      packagedProviderSmokeControl: options.packagedProviderSmokeControl === true,
    });
    const providerSignInDependencies: ProviderOAuthRouteDependencies | undefined =
      hostOAuth === undefined
        ? undefined
        : {
            service: hostOAuth,
            windowAuthorityStore,
            ...(credentialResolver === undefined ? {} : { credentials: credentialResolver }),
            ...(options.allowedRendererHttpOrigin === undefined
              ? {}
              : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
            readInstance: (instanceId) => persistence.readProviderInstance(instanceId),
            bindDescriptor: async (instance, descriptorId, windowId) => {
              const authenticatedWindow = decodeWindowId(windowId);
              if (instance.driverKind === "openai-compatible") {
                await providerService.execute(authenticatedWindow, {
                  kind: "change-openai-compatible-configuration",
                  instanceId: instance.id,
                  expectedVersion: instance.version,
                  configuration: {
                    ...instance.configuration,
                    oauthDescriptorId: descriptorId,
                  },
                });
              } else if (instance.driverKind === "anthropic-compatible") {
                await providerService.execute(authenticatedWindow, {
                  kind: "change-anthropic-compatible-configuration",
                  instanceId: instance.id,
                  expectedVersion: instance.version,
                  configuration: {
                    ...instance.configuration,
                    oauthDescriptorId: descriptorId,
                  },
                });
              }
            },
          };
    const browserSignInRoutes =
      providerSignInDependencies === undefined
        ? async () => undefined
        : createProviderOAuthRouteHandler(providerSignInDependencies);
    // The host-local device-code sign-in shares the organization sign-in's
    // dependencies; it answers only the bridge-secret caller `octant provider
    // sign-in` is, and says so even when no broker is running.
    const deviceSignInRoutes = createProviderDeviceSignInRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      readProviderInstances: () => persistence.readProviderInstances(),
      signIn: providerSignInDependencies,
    });
    const providerOAuthRoutes = async (request: Request): Promise<Response | undefined> =>
      (await deviceSignInRoutes(request)) ?? (await browserSignInRoutes(request));
    const discoveryService = makeDiscoveryService({ hostId: LOCAL_HOST_ID });
    const createProviderFromDiscovery = async (
      candidate: DiscoveryCandidate,
      windowId: string,
      options: { readonly enabled: boolean },
    ) => {
      const { command } = createProviderFromDiscoveryCandidate(candidate, {
        enabled: options.enabled,
      });
      const result = await providerService.execute(windowId as never, command);
      if (result.kind !== "provider-created") {
        throw new Error("Provider discovery auto-register did not create a provider instance.");
      }
      return { instanceId: result.instance.id };
    };
    const discoveryRoutes = createDiscoveryRouteHandler({
      discoveryService,
      windowAuthorityStore,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      ...(options.desktopBridgeSecret === undefined
        ? {}
        : { desktopBridgeSecret: options.desktopBridgeSecret }),
      binaryReceipts: new LocalPluginImportReceiptStore(),
      readInstance: (instanceId) => persistence.readProviderInstance(instanceId),
      applyProviderCommand: (windowId, command) =>
        providerService.execute(decodeWindowId(windowId), command),
      listInstances: async () => persistence.readProviderInstances(),
      createFromDiscovery: createProviderFromDiscovery,
      readFirstRunOnboarding: () =>
        persistence.readShellSettings()?.settings.firstRunOnboarding ?? "pending",
      onConnect: async (command, windowId) => {
        const { command: providerCommand } = createProviderFromDiscoveryCandidate(command, {
          enabled: true,
        });
        const result = await providerService.execute(windowId as never, providerCommand);
        if (result.kind !== "provider-created") {
          throw new Error("Provider discovery connect did not create a provider instance.");
        }
        return { instanceId: result.instance.id };
      },
    });
    const chatDataDirectory = join(providerDataDirectory, "chat");
    const chatAttachmentStore = new ChatAttachmentStore(chatDataDirectory);
    const configuredDriverOptions: ConfiguredProviderDriverOptions = {
      openCodeProcess,
      codexProcess,
      acpProcess,
      acpHome,
      piProcess,
      piHome,
      ohMyPiProcess,
      ohMyPiHome,
      nativeHarnessTranscripts,
      nativeHarness: nativeHarnessEndpointHooks,
      claudeProcess,
      claudeSdk,
      claudeResumeIdentityPort: claudeResumeIdentityStore,
      isProjectConfinedPath,
      runtimeRegistry: providerRuntimeRegistry,
      permissionPersistence: () => persistence.readProviderDefaults().permissionPersistence,
      onRuntimeEvent: recordProviderRuntimeUsage,
      ...(credentialResolver === undefined ? {} : { credentialResolver }),
      ...(subscriptionOAuth === undefined ? {} : { subscriptionOAuth }),
      ...(directoryOAuth === undefined ? {} : { directoryOAuth }),
      localUsageHistorySourceForInstance: (instance) => {
        const claudeConfigDirectory =
          instance.driverKind === "claude"
            ? effectiveClaudeAccountConfigDirectory(instance, homedir())
            : undefined;
        return createLocalUsageHistorySourceForDriver({
          driverKind: instance.driverKind,
          home: homedir(),
          ...(claudeConfigDirectory === undefined ? {} : { claudeConfigDirectory }),
          ...(instance.driverKind === "codex" && instance.configuration.codexHome !== undefined
            ? { codexHome: instance.configuration.codexHome }
            : {}),
          checkpointStore: createLocalUsageHistoryCheckpointStore(
            join(persistence.dataDirectory, "local-usage-cache.sqlite3"),
          ),
        });
      },
      get claudeInstances() {
        return persistence.readProviderInstances();
      },
      get codexInstances() {
        return persistence.readProviderInstances();
      },
    };
    // Where a harness lead goes when its own model stays down. It builds
    // drivers from the options above, whose lead hook asks it in turn; both
    // only run once a turn is under way.
    const nativeHarnessLeadFallback = new NativeHarnessLeadFallbackService({
      router: nativeHarnessRouter,
      sessions: nativeHarnessSessions,
      hostId: String(LOCAL_HOST_ID),
      // Building the driver is what registers its endpoint, so a fallback onto an
      // instance no turn has used yet since boot still finds it.
      endpointFor: (providerInstanceId) => {
        const instance = persistence.readProviderInstance(providerInstanceId as never);
        if (instance === undefined || !instance.enabled) return undefined;
        try {
          makeConfiguredProviderDriver(instance, configuredDriverOptions);
        } catch {
          return undefined;
        }
        return nativeHarnessEndpoints.get(instance.id);
      },
    });
    const localUsageHistoryRoutes = createLocalUsageHistoryRouteHandler({
      windowAuthorityStore,
      ...(options.allowedRendererHttpOrigin === undefined
        ? {}
        : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
      // One file, two rebuildable caches beside each other: the checkpoint the
      // reader resumes from, and the last completed reading a surface paints
      // while it reads again.
      lastReadStore: createLocalUsageHistoryLastReadStore(
        join(persistence.dataDirectory, "local-usage-cache.sqlite3"),
      ),
      sources: () => {
        const seen = new Set<string>();
        const sources: ProviderLocalUsageHistorySource[] = [];
        for (const instance of persistence.readProviderInstances()) {
          if (!instance.enabled) continue;
          let driver: ProviderDriver;
          try {
            driver = makeConfiguredProviderDriver(instance, configuredDriverOptions);
          } catch {
            continue;
          }
          const source = driver.localUsageHistory;
          if (source === undefined) continue;
          const sourceKey = localUsageHistorySourceKey({
            driverKind: instance.driverKind,
            instanceId: instance.id,
            sourceKind: source.sourceKind,
          });
          if (seen.has(sourceKey)) continue;
          seen.add(sourceKey);
          sources.push(source);
        }
        return sources;
      },
      clock: () => new Date().toISOString(),
    });
    // The last reading of each instance, so the usage rings have something
    // to show before the first turn of a new run reports. Loading it asks no
    // provider anything.
    const providerUsageReadingStore = new ProviderUsageReadingStore(
      join(providerDataDirectory, "providers", "usage-readings.json"),
    );
    const restoredUsageReadings = yield* Effect.promise(() => providerUsageReadingStore.load());
    const providerUsageLimitsService = new ProviderUsageLimitsService({
      restoredEntries: restoredUsageReadings,
      persistEntries: (entries) => providerUsageReadingStore.save(entries),
      // Image profiles are jobs against a generation endpoint, not runtimes
      // with an account to meter; listing them would promise a report that
      // has no channel to arrive on.
      listInstances: () =>
        persistence
          .readProviderInstances()
          .filter((instance) => !isImageProfileDriverKind(instance.driverKind)),
      now: () => new Date().toISOString() as UtcTimestamp,
      unavailableReason: (instance) =>
        instance.driverKind === "claude" && instance.configuration.authentication === "api-key"
          ? "plan-limits-do-not-apply"
          : unavailableLimitsReason(
              instance.driverKind,
              providerRuntimeUsageLimitsStore.lastCompletedTurn(instance.id),
            ),
      observe: async (instance, signal, { onDemand }) => {
        if (
          instance.driverKind === "claude" &&
          instance.configuration.authentication === "api-key"
        ) {
          return { source: "provider-runtime", unavailableReason: "plan-limits-do-not-apply" };
        }
        let driver: ProviderDriver;
        try {
          driver = makeConfiguredProviderDriver(instance, {
            ...configuredDriverOptions,
          });
        } catch {
          return undefined;
        }
        const facts = driver.contextFacts;
        if (facts === undefined) return undefined;
        const outcome = await Effect.runPromise(
          Effect.scoped(
            Effect.either(
              facts.observeServiceLimits({
                instanceId: instance.id,
                ...(onDemand ? { onDemand: true } : {}),
              }),
            ),
          ),
          { signal },
        );
        if (outcome._tag === "Left") {
          if (outcome.left.category === "unsupported") {
            return { source: "provider-runtime", unavailableReason: "plan-limits-do-not-apply" };
          }
          if (outcome.left.category === "unavailable") return undefined;
          throw outcome.left;
        }
        const limits = outcome.right;
        const directory = claudePlanUsageStateDirectory(instance, homedir());
        if (directory !== undefined) {
          await providerAccountPlanUsageStore.replace({
            instanceId: instance.id,
            stateDirectory: directory,
            source: "process-refresh",
            observedAt: limits.updatedAt,
            available: true,
            ...(limits.rateLimitWindows === undefined ? {} : { windows: limits.rateLimitWindows }),
          });
        }
        return { source: "provider-runtime", limits };
      },
      runtimeLimits: (instanceId, observedAt) => {
        const live = providerRuntimeUsageLimitsStore.serviceLimits(instanceId, observedAt);
        if (live !== undefined) return live;
        const instance = persistence
          .readProviderInstances()
          .find((candidate) => String(candidate.id) === String(instanceId));
        if (instance === undefined) return undefined;
        const directory = claudePlanUsageStateDirectory(instance, homedir());
        return directory === undefined
          ? undefined
          : providerAccountPlanUsageStore.serviceLimits(instanceId, directory, observedAt);
      },
    });
    providerUsageLimitsServiceRef = providerUsageLimitsService;
    providerUsageLimitsService.start();
    void providerUsageLimitsService.refresh().catch(() => undefined);
    const providerUsageLimitsRoutes = createProviderUsageLimitsRouteHandler({
      service: providerUsageLimitsService,
      windowAuthorityStore,
    });
    // Image generation runs through a provider instance and its credentials.
    // Chat, Work, and Canvas all read its jobs, so it is built here, before
    // any of them.
    const generatedImageStore = new GeneratedImageStore(persistence.dataDirectory);
    yield* Effect.promise(() =>
      generatedImageStore.recover({
        isFinalizedAttachmentReferenced: (scopeId, attachmentId) =>
          persistence.imageJobProjection.isFinalizedAttachmentReferenced(scopeId, attachmentId),
      }),
    );
    const imageJobService = new ImageJobService({
      journal: persistence.journal,
      projection: persistence.imageJobProjection,
      attachments: generatedImageStore,
      readProviderInstance: (id) => persistence.readProviderInstance(id),
      readImageGenerationCustomSources: () =>
        (persistence.readShellSettings()?.settings ?? defaultShellSettings()).imageGeneration
          .customSources,
      credentialResolver:
        credentialResolver ??
        ({
          has: async () => false,
          resolve: async () => "",
        } as const),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    yield* Effect.promise(() => imageJobService.reconcileInterruptedJobs());
    return {
      agentPluginMcpSessionManager,
      chatAttachmentStore,
      chatDataDirectory,
      claudeResumeIdentityStore,
      codeThreadDrivers,
      configuredDriverOptions,
      credentialBroker,
      credentialResolver,
      discoveryRoutes,
      extensionActivationService,
      extensionApiService,
      extensionLifecycleService,
      extensionPackageStore,
      extensionRoutes,
      generatedImageStore,
      imageJobService,
      localUsageHistoryRoutes,
      managedCodeThreadCreation,
      managedWorktreeRefsList,
      managedWorktreeSourcePreview,
      nativeHarnessEndpoints,
      nativeHarnessLeadFallback,
      nativeHarnessTranscripts,
      probeProviderForThreads,
      providerDataDirectory,
      providerOAuthRoutes,
      providerRoutes,
      providerService,
      providerUsageLimitsRoutes,
      providerUsageLimitsService,
      refreshStandaloneSkills,
      resolveSelectedExtensions,
      pinnedExtensionIds,
      reviewedModelManifest,
      skillDiscoveryService,
    };
  });
}

export type ProvidersWiring = Effect.Effect.Success<ReturnType<typeof wireProviders>>;
