import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import {
  type PermissionPersistence,
  type ProviderFailure,
  type ProviderInstance,
  type ProviderInstanceId,
} from "@octant/contracts";
import {
  CODEX_ACCOUNT_PROFILE,
  defaultProviderAccountDirectory,
  effectiveClaudeAccountConfigDirectory,
  isAcpAgentInstance,
  isImageProfileDriverKind,
} from "@octant/domain";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { lastClaudeHostEnvironmentSnapshot } from "./claudeAccountDirectory";
import {
  claudeAccountNeedsOwnConfigDirectory,
  claudeAccountOverlapsPeerLaunchDirectory,
  codexAccountNeedsOwnHome,
  codexAccountOverlapsPeerHome,
  hostClaudeDirectoryOverlayIsRelative,
  hostCodexHomeOverlayIsRelative,
} from "./providerService";
import { codexAccountProcessEnvironment } from "./codexProcess";
import type { ClaudeAgentSdkPort } from "./claudeAgentSdkPort";
import { makeClaudeDriver, type ClaudeResumeIdentityPort } from "./claudeDriver";
import type { ClaudeProcessPort } from "./claudeProcess";
import { makeCodexDriver } from "./codexDriver";
import type { CodexProcessPort } from "./codexProcess";
import { makeAcpDriver } from "./acpDriver";
import type { AcpProcessPort } from "./acpProcess";
import { acpProviderProfiles, type AcpProviderKind } from "./acpProfiles";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import { makeDevinPlanUsageFacts } from "./devinPlanUsage";
import { makeOpenCodeDriver } from "./openCodeDriver";
import { makeOpenCodeGoUsageFacts } from "./openCodeGoUsage";
import type { OpenCodeProcessPort } from "./openCodeProcess";
import { makeOllamaDriver } from "./ollamaDriver";
import type { OllamaFetch } from "./ollamaEndpoint";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import type { NativeHarnessEndpointHooks } from "../harness/nativeHarnessEndpointRegistry";
import type { NativeHarnessTranscriptStore } from "../harness/nativeHarnessTranscriptStore";
import { makePiDriver } from "./piDriver";
import { makeOhMyPiDriver } from "./ohMyPiDriver";
import type { PiProcessPort } from "./piProcess";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export interface ProviderDriverFactoryOptions {
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly openCodeProcess: OpenCodeProcessPort;
  readonly codexProcess: CodexProcessPort;
  /** Shared runtime port for ACP-speaking agents, including the OpenCode 2 preview. */
  readonly acpProcess?: AcpProcessPort;
  readonly acpHome?: (kind: AcpProviderKind, instanceId: ProviderInstance["id"]) => string;
  readonly ohMyPiProcess?: import("./ohMyPiProcess").OhMyPiProcessPort;
  readonly ohMyPiHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly piProcess?: PiProcessPort;
  readonly piHome?: (instanceId: ProviderInstance["id"]) => string;
  readonly ollamaFetch?: OllamaFetch;
  /** Where Ollama's harness sessions keep their conversation, shared with the other harness drivers. */
  readonly nativeHarnessTranscripts?: NativeHarnessTranscriptStore;
  /** How Ollama's harness retries, where its lead falls back, and where its endpoint is registered. */
  readonly nativeHarness?: NativeHarnessEndpointHooks;
  readonly claudeProcess?: ClaudeProcessPort;
  readonly claudeSdk?: ClaudeAgentSdkPort;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly claudeResumeIdentityPort?: ClaudeResumeIdentityPort;
  readonly isProjectConfinedPath?: (projectRoot: string, absolutePath: string) => boolean;
  readonly permissionPersistence: () => PermissionPersistence;
  readonly claudeInstances?: ReadonlyArray<ProviderInstance>;
  /**
   * A Claude account's current artifact delivery switch, read from the
   * journal at each call. Absent leaves artifact delivery off.
   */
  readonly claudeArtifactDelivery?: (instanceId: ProviderInstanceId) => boolean;
  /** Host Claude env from the snapshot gate. Omit to use the last gated copy. */
  readonly claudeHostEnvironment?: NodeJS.ProcessEnv;
  readonly codexInstances?: ReadonlyArray<ProviderInstance>;
  readonly codexHostEnvironment?: NodeJS.ProcessEnv;
}

export class ProviderDriverConfigurationError extends Error {
  override readonly name = "ProviderDriverConfigurationError";
  readonly failure: ProviderFailure;

  constructor(message = "Provider driver configuration is invalid.") {
    super(message);
    this.failure = {
      category: "invalid-configuration",
      message,
    };
  }
}

export function makeProviderDriver(
  instance: ProviderInstance,
  options: ProviderDriverFactoryOptions,
): ProviderDriver {
  if (isImageProfileDriverKind(instance.driverKind)) {
    throw new ProviderDriverConfigurationError();
  }
  if (isAcpAgentInstance(instance)) {
    if (options.acpProcess === undefined || options.acpHome === undefined) {
      throw new ProviderDriverConfigurationError();
    }
    const configuration = instance.configuration;
    const profile = acpProviderProfiles[instance.driverKind];
    const driver = makeAcpDriver({
      profile,
      instanceId: instance.id,
      binaryPath: configuration.binaryPath,
      managedHome: options.acpHome(instance.driverKind, instance.id),
      process: options.acpProcess,
      runtimeRegistry: options.runtimeRegistry,
      ...(configuration.authentication === undefined
        ? {}
        : { authentication: configuration.authentication }),
      ...(options.credentialResolver === undefined
        ? {}
        : { credentialResolver: options.credentialResolver }),
    });
    const credential = profile.process.hostAuthentication;
    return instance.driverKind === "devin" && credential?.kind === "credential-file"
      ? {
          ...driver,
          contextFacts: makeDevinPlanUsageFacts({
            instanceId: instance.id,
            credentialPath: credential.defaultPath,
          }),
        }
      : driver;
  }
  switch (instance.driverKind) {
    case "opencode":
      // Route selection follows the version the process attests, not the
      // binary's file name. A released 2.x install and a 1.x install can
      // share the name `opencode`.
      return {
        ...makeOpenCodeDriver({
          instanceId: instance.id,
          binaryPath: instance.configuration.binaryPath,
          process: options.openCodeProcess,
          runtimeRegistry: options.runtimeRegistry,
          permissionPersistence: options.permissionPersistence,
        }),
        // Plan windows come from the account behind the CLI's own sign-in,
        // not from the runtime, so both OpenCode lines report them alike.
        contextFacts: makeOpenCodeGoUsageFacts({
          instanceId: instance.id,
          dataDirectory: join(
            process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
            "opencode",
          ),
        }),
      };
    case "codex": {
      if (options.codexInstances === undefined) {
        throw new ProviderDriverConfigurationError();
      }
      if (codexAccountNeedsOwnHome(options.codexInstances, instance)) {
        throw new ProviderDriverConfigurationError(
          "This Codex account needs its own home directory.",
        );
      }
      const hostEnvironment = options.codexHostEnvironment ?? process.env;
      const inheritsHostOverlay = instance.configuration.codexHome === undefined;
      if (inheritsHostOverlay && hostCodexHomeOverlayIsRelative(hostEnvironment)) {
        throw new ProviderDriverConfigurationError(
          "Codex host home must be an absolute directory.",
        );
      }
      if (
        codexAccountOverlapsPeerHome(options.codexInstances, instance, homedir(), hostEnvironment)
      ) {
        throw new ProviderDriverConfigurationError(
          "Another Codex account already uses that home directory.",
        );
      }
      const codexHome =
        instance.configuration.codexHome ??
        hostDirectoryOrDefault(hostEnvironment.CODEX_HOME) ??
        defaultProviderAccountDirectory(CODEX_ACCOUNT_PROFILE, homedir());
      return makeCodexDriver({
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        process: options.codexProcess,
        runtimeRegistry: options.runtimeRegistry,
        permissionPersistence: options.permissionPersistence,
        environment: codexAccountProcessEnvironment({
          binaryPath: instance.configuration.binaryPath,
          hostEnvironment,
          codexHome,
          ...(inheritsHostOverlay ? { inheritHostAuth: true } : {}),
        }),
        ...(options.credentialResolver === undefined
          ? {}
          : { credentialResolver: options.credentialResolver }),
      });
    }
    case "claude":
      if (
        options.claudeProcess === undefined ||
        options.claudeSdk === undefined ||
        options.claudeResumeIdentityPort === undefined ||
        options.isProjectConfinedPath === undefined
      ) {
        throw new ProviderDriverConfigurationError();
      }
      // A missing snapshot would skip the secondary-account guard and let a
      // replayed directory-less instance launch against the default login.
      if (options.claudeInstances === undefined) {
        throw new ProviderDriverConfigurationError();
      }
      if (claudeAccountNeedsOwnConfigDirectory(options.claudeInstances, instance)) {
        throw new ProviderDriverConfigurationError(
          "This Claude account needs its own config directory.",
        );
      }
      const hostEnvironment = options.claudeHostEnvironment ?? lastClaudeHostEnvironmentSnapshot();
      // Isolated and directory-less API-key launches overwrite both
      // directory variables with absolute paths. Only the implicit
      // directory-less subscription account inherits the host overlay.
      const inheritsHostOverlay =
        instance.configuration.authentication === "subscription" &&
        instance.configuration.configDirectory === undefined;
      if (inheritsHostOverlay && hostClaudeDirectoryOverlayIsRelative(hostEnvironment)) {
        throw new ProviderDriverConfigurationError(
          "Claude host config directories must be absolute.",
        );
      }
      if (
        claudeAccountOverlapsPeerLaunchDirectory(
          options.claudeInstances,
          instance,
          homedir(),
          hostEnvironment,
        )
      ) {
        throw new ProviderDriverConfigurationError(
          "Another Claude account already uses that config directory.",
        );
      }
      // An API-key account stored before accounts carried a directory has
      // none on record. Resolving its leaf here gives the probe, the launch
      // and resume lookup one folder; the probe otherwise refused such an
      // account as "requires an assigned account directory".
      const configDirectory = effectiveClaudeAccountConfigDirectory(instance, homedir());
      const readArtifactDelivery = options.claudeArtifactDelivery;
      return makeClaudeDriver({
        ...(readArtifactDelivery === undefined
          ? {}
          : { artifactDelivery: () => readArtifactDelivery(instance.id) }),
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        authentication: instance.configuration.authentication,
        ...(configDirectory === undefined ? {} : { configDirectory }),
        process: options.claudeProcess,
        sdk: options.claudeSdk,
        runtimeRegistry: options.runtimeRegistry,
        resumeIdentityPort: options.claudeResumeIdentityPort,
        permissionPersistence: options.permissionPersistence,
        isProjectConfinedPath: options.isProjectConfinedPath,
        ...(options.credentialResolver === undefined
          ? {}
          : { credentialResolver: options.credentialResolver }),
      });
    case "pi":
      if (options.piProcess === undefined || options.piHome === undefined) {
        throw new ProviderDriverConfigurationError();
      }
      return makePiDriver({
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        piHome: options.piHome(instance.id),
        process: options.piProcess,
        runtimeRegistry: options.runtimeRegistry,
      });
    case "oh-my-pi":
      if (options.ohMyPiProcess === undefined || options.ohMyPiHome === undefined) {
        throw new ProviderDriverConfigurationError();
      }
      return makeOhMyPiDriver({
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        managedHome: options.ohMyPiHome(instance.id),
        supportedVersion: instance.configuration.supportedVersion,
        process: options.ohMyPiProcess,
        runtimeRegistry: options.runtimeRegistry,
      });
    case "ollama":
      // Ollama supplies only its endpoint through the provider-sdk harness
      // endpoint port; the host runs its sessions on the harness loop.
      return runOnNativeHarness(
        makeOllamaDriver({
          instanceId: instance.id,
          configuration: instance.configuration,
          runtimeRegistry: options.runtimeRegistry,
          ...(options.ollamaFetch === undefined ? {} : { fetch: options.ollamaFetch }),
        }),
        {
          instanceId: instance.id,
          runtimeRegistry: options.runtimeRegistry,
          ...(options.nativeHarnessTranscripts === undefined
            ? {}
            : { transcripts: options.nativeHarnessTranscripts }),
          ...(options.nativeHarness === undefined ? {} : { harness: options.nativeHarness }),
        },
      );
    default:
      throw new ProviderDriverConfigurationError();
  }
}

function hostDirectoryOrDefault(directory: string | undefined): string | undefined {
  const trimmed = directory?.trim();
  if (trimmed === undefined || trimmed.length === 0 || !isAbsolute(trimmed)) return undefined;
  return trimmed;
}
