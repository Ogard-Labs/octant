import {
  type PermissionPersistence,
  type ProviderFailure,
  type ProviderInstance,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
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
  /** Shared runtime port for ACP-speaking agents (Kilo, Devin, Mistral Vibe, Kimi Code). */
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
}

export class ProviderDriverConfigurationError extends Error {
  override readonly name = "ProviderDriverConfigurationError";
  readonly failure: ProviderFailure = {
    category: "invalid-configuration",
    message: "Provider driver configuration is invalid.",
  };

  constructor() {
    super("Provider driver configuration is invalid.");
  }
}

export function makeProviderDriver(
  instance: ProviderInstance,
  options: ProviderDriverFactoryOptions,
): ProviderDriver {
  switch (instance.driverKind) {
    case "opencode":
      return makeOpenCodeDriver({
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        process: options.openCodeProcess,
        runtimeRegistry: options.runtimeRegistry,
        permissionPersistence: options.permissionPersistence,
      });
    case "codex":
      return makeCodexDriver({
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        process: options.codexProcess,
        runtimeRegistry: options.runtimeRegistry,
        permissionPersistence: options.permissionPersistence,
      });
    case "claude":
      if (
        options.claudeProcess === undefined ||
        options.claudeSdk === undefined ||
        options.claudeResumeIdentityPort === undefined ||
        options.isProjectConfinedPath === undefined
      ) {
        throw new ProviderDriverConfigurationError();
      }
      return makeClaudeDriver({
        instanceId: instance.id,
        binaryPath: instance.configuration.binaryPath,
        authentication: instance.configuration.authentication,
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
    case "kimi-code": {
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
        ...(configuration.kind === "mistral-vibe-acp"
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
