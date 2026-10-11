import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import {
  type PermissionPersistence,
  type ProviderFailure,
  type ProviderInstance,
} from "@octant/contracts";
import {
  CODEX_ACCOUNT_PROFILE,
  defaultProviderAccountDirectory,
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
import { makeOpenCodeDriver } from "./openCodeDriver";
import type { OpenCodeProcessPort } from "./openCodeProcess";
import { makeOllamaDriver } from "./ollamaDriver";
import type { OllamaFetch } from "./ollamaEndpoint";
import type { OllamaHistoryStore } from "./ollamaHistoryStore";
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
  readonly ollamaHistoryStore?: OllamaHistoryStore;
  readonly claudeProcess?: ClaudeProcessPort;
  readonly claudeSdk?: ClaudeAgentSdkPort;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly claudeResumeIdentityPort?: ClaudeResumeIdentityPort;
  readonly isProjectConfinedPath?: (projectRoot: string, absolutePath: string) => boolean;
  readonly permissionPersistence: () => PermissionPersistence;
  readonly claudeInstances?: ReadonlyArray<ProviderInstance>;
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
  switch (instance.driverKind) {
    case "opencode":
      // Route selection follows the version the process attests, not the
      // binary's file name. A released 2.x install and a 1.x install can
      // share the name `opencode`.
      return makeOpenCodeDriver({
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        process: options.openCodeProcess,
        runtimeRegistry: options.runtimeRegistry,
        permissionPersistence: options.permissionPersistence,
      });
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
      return makeClaudeDriver({
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        authentication: instance.configuration.authentication,
        ...(instance.configuration.configDirectory === undefined
          ? {}
          : { configDirectory: instance.configuration.configDirectory }),
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
    case "kilo":
    case "devin":
    case "mistral-vibe":
    case "kimi-code":
    case "grok":
    case "goose":
    case "glm":
    case "gemini":
    case "copilot":
    case "cline":
    case "qwen":
    case "fx": {
      if (options.acpProcess === undefined || options.acpHome === undefined) {
        throw new ProviderDriverConfigurationError();
      }
      const configuration = instance.configuration;
      return makeAcpDriver({
        profile: acpProviderProfiles[instance.driverKind],
        instanceId: instance.id,
        binaryPath: configuration.binaryPath,
        managedHome: options.acpHome(instance.driverKind, instance.id),
        process: options.acpProcess,
        runtimeRegistry: options.runtimeRegistry,
        ...(configuration.kind === "mistral-vibe-acp" ||
        configuration.kind === "grok-acp" ||
        configuration.kind === "glm-acp" ||
        configuration.kind === "gemini-acp" ||
        configuration.kind === "cline-acp" ||
        configuration.kind === "qwen-acp" ||
        configuration.kind === "fx-acp"
          ? { authentication: configuration.authentication }
          : {}),
        ...(options.credentialResolver === undefined
          ? {}
          : { credentialResolver: options.credentialResolver }),
      });
    }
    case "ollama":
      return makeOllamaDriver({
        instanceId: instance.id,
        configuration: instance.configuration,
        runtimeRegistry: options.runtimeRegistry,
        ...(options.ollamaFetch === undefined ? {} : { fetch: options.ollamaFetch }),
        ...(options.ollamaHistoryStore === undefined
          ? {}
          : { historyStore: options.ollamaHistoryStore }),
      });
    default:
      throw new ProviderDriverConfigurationError();
  }
}

function hostDirectoryOrDefault(directory: string | undefined): string | undefined {
  const trimmed = directory?.trim();
  if (trimmed === undefined || trimmed.length === 0 || !isAbsolute(trimmed)) return undefined;
  return trimmed;
}
