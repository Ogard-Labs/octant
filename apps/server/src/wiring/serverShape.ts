import type { DesktopComputerUsePort } from "../computerUse/desktopComputerUsePort";
import type { ProviderInstance } from "@octant/contracts";
import { Data, Effect } from "effect";
import type { CodeOperationRuntime } from "../code/codeOperationRuntime";
import type { TerminalLauncher } from "../code/terminalService";
import type { FileHelperProcessTransport } from "../code/fileHelperProcessTransport";
import type { ManagedWorktreeRepositoryPort } from "../code/managedWorktreeService";
import type { CodeRouteService } from "../codeRoutes";
import type {
  ComputerUseNativeAdapter,
  ComputerUseRuntime,
} from "../computerUse/computerUseRuntime";
import { GitEnvironmentPort } from "../gitEnvironmentPort";
import { GhAuthenticationPort } from "../github/ghAuthenticationPort";
import type { IntegrationSecretVault } from "../integration/integrationCredentialVault";
import {
  type PersistenceService,
  PersistenceStartupFailed,
  type VerifiedStoreBackupReceipt,
} from "../persistence/persistenceService";
import type { AgentRunProcessSupervisorPort } from "../agentRun/agentRunOrchestrationService";
import type { ClaudeAgentSdkPort } from "../providers/claudeAgentSdkPort";
import type { ClaudeProcessPort } from "../providers/claudeProcess";
import { ClaudeResumeIdentityStore } from "../providers/claudeResumeIdentityStore";
import type { CodexProcessPort } from "../providers/codexProcess";
import type { AcpProcessPort } from "../providers/acpProcess";
import type { AcpProviderKind } from "../providers/acpProfiles";
import type { OpenCodeProcessPort } from "../providers/openCodeProcess";
import type { OhMyPiProcessPort } from "../providers/ohMyPiProcess";
import type { PiProcessPort } from "../providers/piProcess";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { LatencyStatsProjection } from "../latencyStatsProjection";
import type { ExtensionPackageResolverPort } from "../extensions/extensionApiService";
import type { ExtensionActivationPolicyPort } from "../extensions/extensionActivationService";
import type { ExtensionSupervisorPort } from "../extensions/extensionLifecycleService";
import type { ExtensionToolExecutionPort } from "../extensions/extensionChatResolver";
import type { SkillDiscoveryRootProvider } from "../extensions/skillDiscoveryService";
import type { SkillMarketplacePort } from "../extensions/standaloneSkillService";
import type { CodexPluginPackageResolverOptions } from "../extensions/codexPluginResolver";
import { AgentPluginMcpSessionManager } from "../extensions/agentPluginMcpSessionManager";
import { LocalPluginFolderRegistry } from "../extensions/localPluginFolderRegistry";
import type { BrowserRuntimePort } from "../browser/browserRuntimePort";
import type {
  PrivateListener,
  PrivateListenerConfig,
  PrivateListenerFailureCode,
  PrivateListenerNamedTls,
  PrivateListenerTls,
} from "../privateListener";
import type { RemoteGatewayServices } from "../remote/remoteGateway";
import type { HostControlServicePolicyPort } from "../hostControlRoutes";
import type { HostRuntimeDiagnostics, HostRuntimeServiceMode } from "@octant/host-runtime";

export interface OctantServer {
  readonly url: URL;
  readonly remoteListener?: PrivateListener;
  readonly remoteListenerError?: PrivateListenerFailureCode;
  readonly diagnostics?: () => HostRuntimeDiagnostics;
  /**
   * Owner-mediated online backup: a verified snapshot created through the
   * live owner connection, confined to the data directory. Second processes
   * never open the live store; they route here over the control socket.
   */
  readonly backup?: (label?: string) => VerifiedStoreBackupReceipt;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

/**
 * Listener trust class carried into the request boundary. The loopback
 * listener preserves all existing local behavior; the remote (private)
 * listener is separately classified and subject to remote admission.
 */
export type RemoteListenerTrust = "loopback" | "remote";

/**
 * Coarse source class derived from the accepted socket peer address. It is
 * never read from request headers. `unknown` covers missing, public, or
 * otherwise unclassifiable peer identity and rejects remote API traffic.
 */
export type RemoteSourceClass = "loopback" | "lan-private" | "tailscale" | "unknown";

/**
 * Immutable, non-header request facts derived from the accepted socket. The
 * `sourceKey` is an HMAC of the normalized peer address over a process-scoped
 * salt; the raw address and salt are never exposed or persisted. The type name
 * `RequestTransportFacts` avoids collision with the contracts
 * `RemoteRequestFactsV1` wire type.
 */
export interface RequestTransportFacts {
  readonly listenerTrust: RemoteListenerTrust;
  readonly sourceClass: RemoteSourceClass;
  readonly sourceKey: string;
}

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
  readonly maxRequestBodySize: number;
  /** Defaults to `loopback`; the private listener passes `remote`. */
  readonly listenerTrust?: RemoteListenerTrust;
  readonly fetch: (request: Request, facts?: RequestTransportFacts) => Response | Promise<Response>;
  readonly tls?: PrivateListenerTls;
  /** Served beside `tls` to clients that ask for this name by SNI; also accepted as a Host. */
  readonly tailnetTls?: PrivateListenerNamedTls;
}

export const MAX_REQUEST_BODY_SIZE = 1_048_576;

export const MAX_JSON_REQUEST_BODY_SIZE = MAX_REQUEST_BODY_SIZE;

export type Serve = (options: ServeOptions) => OctantServer | Promise<OctantServer>;

export class ServerStartupFailed extends Data.TaggedError("ServerStartupFailed")<{
  readonly category: "server-unavailable";
  readonly message: string;
}> {}

export interface StartOctantServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly instanceId?: string;
  readonly hostId?: string;
  readonly controlEndpoint?: string;
  readonly serviceMode?: Exclude<HostRuntimeServiceMode, "maintenance">;
  readonly version?: string;
  /**
   * Honest platform capability names observed at startup (for example
   * `platform:service-manager`). Unavailable native tools are never listed,
   * so the diagnostics report fails closed by construction.
   */
  readonly platformCapabilities?: ReadonlyArray<string>;
  readonly desktopBridgeSecret?: string;
  /**
   * HTTP origin the local renderer may present. `null` is packaged
   * (`file://` only). Omitted keeps loopback-any-port for tests.
   */
  readonly allowedRendererHttpOrigin?: string | null;
  /**
   * Host control wiring for the shared web Settings host card. The
   * service policy port persists the automatic-startup policy and
   * `requestOwnerStop` requests the same graceful owner drain the control
   * socket uses. Production owners always inject both. Omitting them is a
   * test seam: the web surface then reports the exact unavailable state
   * instead of pretending a store is wired.
   */
  readonly hostControl?: {
    readonly servicePolicy?: HostControlServicePolicyPort;
    readonly requestOwnerStop?: () => void;
    /** The newest host service log lines, for the support bundle. */
    readonly readServiceLog?: () => Promise<
      ReadonlyArray<{
        readonly timestamp: string;
        readonly level: string;
        readonly event: string;
        readonly message: string;
      }>
    >;
  };
  readonly credentialBrokerToken?: string;
  readonly credentialBrokerUrl?: string;
  readonly integrationSecretVault?: IntegrationSecretVault;
  readonly linearOAuthClientId?: string;
  readonly linearOAuthRedirectUri?: string;
  readonly packagedProviderSmokeControl?: true;
  readonly acquirePersistence?: Effect.Effect<PersistenceService, PersistenceStartupFailed>;
  readonly serve?: Serve;
  readonly providerRuntimeRegistry?: ProviderRuntimeRegistry;
  /** Optional until a host has a real provider-managed child execution port. */
  readonly agentRunProcessSupervisor?: AgentRunProcessSupervisorPort;
  readonly openCodeProcess?: OpenCodeProcessPort;
  readonly codexProcess?: CodexProcessPort;
  readonly acpProcess?: AcpProcessPort;
  readonly acpHome?: (kind: AcpProviderKind, instanceId: ProviderInstance["id"]) => string;
  readonly piProcess?: PiProcessPort;
  readonly piHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly ohMyPiProcess?: OhMyPiProcessPort;
  readonly ohMyPiHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly claudeProcess?: ClaudeProcessPort;
  readonly claudeSdk?: ClaudeAgentSdkPort;
  readonly claudeResumeIdentityStore?: ClaudeResumeIdentityStore;
  readonly isProjectConfinedPath?: (projectRoot: string, absolutePath: string) => boolean;
  readonly gitEnvironmentPort?: Pick<GitEnvironmentPort, "observe" | "close">;
  readonly codeService?: CodeRouteService;
  readonly codeOperationRuntime?: CodeOperationRuntime;
  readonly computerUseRuntime?: ComputerUseRuntime;
  readonly computerUseDesktop?: DesktopComputerUsePort;
  readonly computerUseAdapter?: ComputerUseNativeAdapter;
  readonly githubAuthenticationPort?: GhAuthenticationPort;
  readonly ghExecutable?: string;
  readonly codeFileHelperPath?: string;
  /** The packaged desktop's `octant` for a terminal with a Browser grant. */
  readonly terminalLauncher?: TerminalLauncher;
  readonly createCodeFileHelperTransport?: (path: string) => FileHelperProcessTransport;
  readonly codeRepositoryPort?: ManagedWorktreeRepositoryPort;
  readonly webAssetsPath?: string;
  readonly browserRuntime?: BrowserRuntimePort;
  readonly extensionPackageResolver?: ExtensionPackageResolverPort;
  readonly extensionActivationPolicy?: ExtensionActivationPolicyPort;
  readonly extensionCatalogStatus?: () => "available" | "offline";
  readonly codexPluginPackageSources?: CodexPluginPackageResolverOptions;
  readonly extensionSupervisor?: ExtensionSupervisorPort;
  readonly extensionToolExecution?: ExtensionToolExecutionPort;
  readonly extensionSkillRoots?: SkillDiscoveryRootProvider;
  readonly localPluginFolderRegistry?: LocalPluginFolderRegistry;
  readonly agentPluginMcpSessionManager?: AgentPluginMcpSessionManager;
  readonly skillMarketplace?: SkillMarketplacePort;
  readonly remoteListener?: {
    readonly config: PrivateListenerConfig;
    /**
     * Typed gateway services that compose the remote fetch handler. The
     * server constructs the gateway internally — callers cannot inject an
     * arbitrary remote fetch that bypasses route/auth policy. This is the
     * test/smoke injection seam; the packaged server composes an equivalent
     * production service graph from its own persistence graph and host
     * identity when this is absent, so the packaged host controls always drive
     * a real lifecycle controller.
     */
    readonly services: Omit<RemoteGatewayServices, "config" | "serve">;
  };
  readonly remoteServe?: Serve;
}

/** What the composition root resolves before any wiring module runs. */
export interface ServerStart {
  readonly options: StartOctantServerOptions;
  readonly persistence: PersistenceService;
  readonly serve: Serve;
  readonly version: string;
  readonly startedAt: number;
  readonly latencyStats: LatencyStatsProjection;
}
