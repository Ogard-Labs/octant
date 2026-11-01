import { createHash } from "node:crypto";
import {
  MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH,
  type ExtensionPackageReviewComponent,
  type ExtensionPackageReviewDebugAdapter,
  type ExtensionPackageReviewLanguageServer,
  decodeExtensionPackageReviewDebugAdapter,
  decodeExtensionPackageReviewLanguageServer,
  ExtensionCommand,
  ExtensionCommandResult,
  ExtensionCatalogEntry,
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import {
  ExtensionInspectionError,
  inspectExtensionPackage,
  type InspectedExtensionPackage,
  type ResolvedExtensionPackage,
} from "./packageInspector";
import { AgentPluginIngestionError } from "./agentPluginIngestion";
import { CodexPluginIngestionError } from "./codexPluginIngestion";
import {
  ExtensionLifecycleServiceError,
  type ExtensionLifecycleService,
} from "./extensionLifecycleService";
import { MarketplaceFetchesDisabledError } from "./marketplaceHttps";
import type { ExtensionDebugAdapterDeclaration } from "@octant/contracts/extensions";
import {
  DebugAdapterPackageRefusedError,
  debugAdapterPackageRefusalMessage,
} from "./debugAdapterPackage";
import {
  LanguageServerPackageRefusedError,
  languageServerPackageRefusalMessage,
} from "./languageServerPackage";
import {
  OutsideProviderDriverRefusedError,
  outsideProviderDriverRefusalMessage,
} from "./outsideProviderDriverPackage";
import { StandaloneSkillService } from "./standaloneSkillService";
import {
  npmSourceRefusalCategory,
  npmSourceRefusalMessage,
  type NpmPackageSourcePort,
} from "./npmPackageSource";
import { compareNpmVersions } from "./npmVersionRange";

export interface ExtensionPackageResolverPort {
  resolve(
    command: Extract<ExtensionCommand, { readonly kind: "inspect-package" }>,
    signal?: AbortSignal,
  ): Promise<ResolvedExtensionPackage>;
  searchCatalog?(
    command: Extract<ExtensionCommand, { readonly kind: "search-catalog" }>,
    signal?: AbortSignal,
  ):
    | {
        readonly entries: ReadonlyArray<ExtensionCatalogEntry>;
        readonly nextCursor?: string;
      }
    | Promise<{
        readonly entries: ReadonlyArray<ExtensionCatalogEntry>;
        readonly nextCursor?: string;
      }>;
}

export interface ExtensionActivationServicePort {
  resolve(
    snapshot: ExtensionSnapshot,
    query: ExtensionEffectiveStateQuery,
  ): ExtensionEffectiveSnapshot;
}

export class ExtensionApiService {
  readonly #lifecycle: ExtensionLifecycleService;
  readonly #resolver: ExtensionPackageResolverPort;
  readonly #skills: StandaloneSkillService | undefined;
  readonly #activation: ExtensionActivationServicePort | undefined;
  readonly #npm: NpmPackageSourcePort | undefined;
  readonly #onStateChanged:
    | ((snapshot: ExtensionSnapshot, command: ExtensionCommand) => void | Promise<void>)
    | undefined;
  readonly #inspections = new Map<string, InspectedExtensionPackage>();
  readonly #userAddedMcpServers:
    | {
        owns(sourceRef: string): boolean;
        remove(sourceRef: string, extensionId: string): Promise<void>;
      }
    | undefined;

  constructor(options: {
    readonly lifecycle: ExtensionLifecycleService;
    readonly resolver: ExtensionPackageResolverPort;
    readonly skills?: StandaloneSkillService;
    readonly activation?: ExtensionActivationServicePort;
    /** Looks packages up on an npm registry; without it the npm commands are unavailable. */
    readonly npmSource?: NpmPackageSourcePort;
    /** Told which command changed the state, so its consequences can follow it. */
    readonly onStateChanged?: (
      snapshot: ExtensionSnapshot,
      command: ExtensionCommand,
    ) => void | Promise<void>;
    /** Removes the folder and secrets of a server the person added by hand, once its package is gone. */
    readonly userAddedMcpServers?: {
      owns(sourceRef: string): boolean;
      remove(sourceRef: string, extensionId: string): Promise<void>;
    };
  }) {
    this.#lifecycle = options.lifecycle;
    this.#resolver = options.resolver;
    this.#skills = options.skills;
    this.#activation = options.activation;
    this.#npm = options.npmSource;
    this.#onStateChanged = options.onStateChanged;
    this.#userAddedMcpServers = options.userAddedMcpServers;
  }

  snapshot(): ExtensionSnapshot {
    const snapshot = this.#lifecycle.snapshot();
    return this.#markAddedInSettings(this.#skills?.snapshot(snapshot) ?? snapshot);
  }

  /**
   * Marks each package the host wrote for a server the person added in
   * Settings, by the source reference its store of generated folders holds.
   * The mark is set here and nowhere else, and taken off any package the
   * store does not vouch for, so a plugin's slug or manifest cannot claim it.
   */
  #markAddedInSettings(snapshot: ExtensionSnapshot): ExtensionSnapshot {
    return {
      ...snapshot,
      packages: snapshot.packages.map(({ addedInSettings: _claimed, ...packageState }) =>
        "sourceRef" in packageState.source &&
        this.#userAddedMcpServers?.owns(packageState.source.sourceRef) === true
          ? { ...packageState, addedInSettings: true as const }
          : packageState,
      ),
    };
  }

  async execute(command: ExtensionCommand, signal?: AbortSignal): Promise<ExtensionCommandResult> {
    try {
      switch (command.kind) {
        case "search-catalog": {
          if (this.#resolver.searchCatalog === undefined) return unsupportedCommand();
          const result = await this.#resolver.searchCatalog(command, signal);
          return {
            kind: "catalog-search-results",
            entries: result.entries,
            ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
          };
        }
        case "inspect-package": {
          const inspection = await this.#inspect(command, signal);
          return {
            kind: "package-inspected",
            preview: previewFor(inspection),
          };
        }
        case "preview-package": {
          const inspection = await this.#inspect(
            {
              kind: "inspect-package",
              source: command.source,
            },
            signal,
          );
          return { kind: "package-preview", preview: previewFor(inspection) };
        }
        case "resolve-npm-package": {
          if (this.#npm === undefined) return unsupportedCommand();
          // An update looks in the registry its package was installed from,
          // not the one the npm settings name now, so it cannot fetch another
          // registry's package of the same name.
          const target =
            command.updateOf === undefined
              ? undefined
              : this.#lifecycle
                  .snapshot()
                  .packages.find((candidate) => candidate.extensionId === command.updateOf);
          if (command.updateOf !== undefined) {
            if (target?.npm === undefined) {
              return failure("invalid", "This package did not come from an npm registry.");
            }
            if (target.npm.packageName !== command.packageName.trim()) {
              return failure("invalid", "That is not the package this plugin came from.");
            }
          }
          const resolution = await this.#npm.resolve(
            {
              packageName: command.packageName,
              ...(command.range === undefined ? {} : { range: command.range }),
              ...(target?.npm === undefined ? {} : { registry: target.npm.registry }),
            },
            signal,
          );
          if (resolution.status === "refused") {
            return failure(
              npmSourceRefusalCategory(resolution.reason),
              npmSourceRefusalMessage(resolution),
            );
          }
          const inspection = this.#inspectResolved(resolution.resolved);
          if (
            command.updateOf !== undefined &&
            inspection.manifest.extensionId !== command.updateOf
          ) {
            return failure(
              "invalid",
              "That version is a different package from the one installed.",
            );
          }
          return { kind: "package-inspected", preview: previewFor(inspection) };
        }
        case "check-npm-update": {
          if (this.#npm === undefined) return unsupportedCommand();
          const installed = this.#lifecycle
            .snapshot()
            .packages.find((candidate) => candidate.extensionId === command.extensionId);
          if (installed?.npm === undefined) {
            return failure("invalid", "This package did not come from an npm registry.");
          }
          const latest = await this.#npm.latest(
            { packageName: installed.npm.packageName, registry: installed.npm.registry },
            signal,
          );
          if (latest.status === "refused") {
            return failure(
              npmSourceRefusalCategory(latest.reason),
              npmSourceRefusalMessage(latest),
            );
          }
          return {
            kind: "npm-update-checked",
            extensionId: command.extensionId,
            // The plugin's own version is whatever its author wrote; the npm
            // release it was installed from is what `latest` is compared with.
            installedVersion: installed.npm.version,
            ...(compareNpmVersions(latest.version, installed.npm.version) > 0
              ? { available: latest.version as never }
              : {}),
          };
        }
        case "install-package": {
          const inspection = this.#inspections.get(commandKey(command));
          if (inspection === undefined) return inspectionRequired();
          return await this.#stateUpdated(
            await this.#lifecycle.install(inspection, { trust: command.trust === true }),
            command,
          );
        }
        case "update-package": {
          const inspection = this.#inspections.get(commandKey(command));
          if (inspection === undefined) return inspectionRequired();
          return await this.#stateUpdated(await this.#lifecycle.update(inspection), command);
        }
        case "rollback-package":
          return await this.#stateUpdated(await this.#lifecycle.rollback(command), command);
        case "uninstall-package": {
          const source = this.#lifecycle
            .snapshot()
            .packages.find((candidate) => candidate.extensionId === command.extensionId)?.source;
          const snapshot = await this.#lifecycle.uninstall(command.extensionId);
          // The generated folder and its secrets go only once the package is
          // really gone; a waiting uninstall keeps them for the retry.
          if (
            source !== undefined &&
            "sourceRef" in source &&
            this.#userAddedMcpServers?.owns(source.sourceRef) === true &&
            !snapshot.packages.some((candidate) => candidate.extensionId === command.extensionId)
          ) {
            await this.#userAddedMcpServers?.remove(source.sourceRef, command.extensionId);
          }
          return await this.#stateUpdated(snapshot, command);
        }
        case "set-plugin-desired":
          return await this.#stateUpdated(await this.#lifecycle.setPluginDesired(command), command);
        case "set-source-trust":
          return await this.#stateUpdated(await this.#lifecycle.setSourceTrust(command), command);
        case "trust-new-publisher":
          return await this.#stateUpdated(
            await this.#lifecycle.trustNewPublisher(command),
            command,
          );
        case "forget-publisher":
          return await this.#stateUpdated(await this.#lifecycle.forgetPublisher(command), command);
        case "set-component-desired":
          return await this.#stateUpdated(
            await this.#lifecycle.setComponentDesired(command),
            command,
          );
        case "query-effective-state":
          if (this.#activation === undefined) return unsupportedCommand();
          return {
            kind: "extension-effective-state",
            snapshot: this.#activation.resolve(this.snapshot(), {
              scope: command.scope,
              ...(command.expectedCatalogEpoch === undefined
                ? {}
                : { expectedCatalogEpoch: command.expectedCatalogEpoch }),
            }),
          };
        case "search-skills":
        case "preview-skill":
        case "install-skill":
        case "update-skill":
        case "remove-skill":
        case "reconcile-skills":
        case "review-skill":
        case "trust-skill-source":
        case "set-skill-desired":
        case "select-skill-collision":
          if (this.#skills === undefined) return unavailableSkills();
          {
            const result = await this.#skills.execute(command, signal);
            return result.kind === "extension-state-updated"
              ? await this.#stateUpdated(result.snapshot, command)
              : result;
          }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return failure("interrupted", "Extension inspection was interrupted.");
      }
      if (error instanceof MarketplaceFetchesDisabledError) {
        return failure("blocked", error.message);
      }
      if (error instanceof DebugAdapterPackageRefusedError) {
        return failure("invalid", debugAdapterPackageRefusalMessage(error.reason));
      }
      if (error instanceof LanguageServerPackageRefusedError) {
        return failure("invalid", languageServerPackageRefusalMessage(error.reason));
      }
      if (error instanceof OutsideProviderDriverRefusedError) {
        return failure("invalid", outsideProviderDriverRefusalMessage(error.reason));
      }
      if (
        error instanceof ExtensionInspectionError ||
        error instanceof CodexPluginIngestionError ||
        error instanceof AgentPluginIngestionError
      ) {
        return failure("invalid", "Package inspection failed.");
      }
      if (error instanceof ExtensionLifecycleServiceError) {
        return failure(apiCategory(error.category), lifecycleMessage(error.category));
      }
      return failure("unavailable", "Package source is unavailable.");
    }
  }

  #remember(inspection: InspectedExtensionPackage): void {
    this.#inspections.set(commandKey(inspection.manifest), inspection);
    while (this.#inspections.size > 64) {
      const oldest = this.#inspections.keys().next().value;
      if (oldest === undefined) break;
      this.#inspections.delete(oldest);
    }
  }

  async #inspect(
    command: Extract<ExtensionCommand, { readonly kind: "inspect-package" }>,
    signal?: AbortSignal,
  ): Promise<InspectedExtensionPackage> {
    return this.#inspectResolved(await this.#resolver.resolve(command, signal));
  }

  #inspectResolved(resolved: ResolvedExtensionPackage): InspectedExtensionPackage {
    const inspection = inspectExtensionPackage({
      ...resolved,
      ...(resolved.expectedDigest === undefined ? {} : { expectedDigest: resolved.expectedDigest }),
    });
    this.#remember(inspection);
    return inspection;
  }

  async #stateUpdated(
    snapshot: ExtensionSnapshot,
    command: ExtensionCommand,
  ): Promise<ExtensionCommandResult> {
    if (this.#onStateChanged !== undefined) {
      await this.#onStateChanged(snapshot, command);
    }
    return { kind: "extension-state-updated", snapshot: this.#markAddedInSettings(snapshot) };
  }
}

export const UNAVAILABLE_EXTENSION_PACKAGE_RESOLVER: ExtensionPackageResolverPort = {
  resolve: async () => {
    throw new Error("Extension package source resolution is unavailable.");
  },
};

function commandKey(value: {
  readonly extensionId: string;
  readonly packageId: string;
  readonly version: string;
  readonly digest: string;
}): string {
  return `${value.extensionId}:${value.packageId}:${value.version}:${value.digest}`;
}

function failure(
  category:
    | "invalid"
    | "unauthorized"
    | "blocked"
    | "stale"
    | "unavailable"
    | "interrupted"
    | "waiting"
    | "failed",
  message: string,
): ExtensionCommandResult {
  return { kind: "extension-command-failed", failure: { category, message } };
}

function inspectionRequired(): ExtensionCommandResult {
  return failure("stale", "Package inspection is required.");
}

function previewFor(inspection: InspectedExtensionPackage) {
  const manifest = inspection.manifest;
  return {
    entry: {
      extensionId: manifest.extensionId,
      packageId: manifest.packageId,
      slug: manifest.slug,
      displayName: manifest.displayName,
      version: manifest.version,
      digest: manifest.digest,
      source: manifest.source,
    },
    review: {
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      provenance: manifest.provenance,
      license: manifest.license,
      compatibility: manifest.compatibility,
      declaredCapabilities: manifest.declaredCapabilities,
      components: manifest.components.map((component) => {
        const instructions =
          component.kind === "skill-instructions"
            ? previewComponentInstructions(inspection, component.id)
            : undefined;
        const languageServer =
          component.languageServer === undefined
            ? undefined
            : previewLanguageServer(inspection, component.id, component.languageServer);
        const debugAdapter =
          component.debugAdapter === undefined
            ? undefined
            : previewDebugAdapter(inspection, component.id, component.debugAdapter);
        return {
          id: component.id,
          kind: component.kind,
          displayName: component.displayName,
          declaredCapabilities: component.declaredCapabilities,
          ...(instructions === undefined ? {} : { instructions }),
          ...(languageServer === undefined ? {} : { languageServer }),
          ...(debugAdapter === undefined ? {} : { debugAdapter }),
        } satisfies ExtensionPackageReviewComponent;
      }),
    },
    diagnostics: inspection.diagnostics ?? [],
  };
}

function previewComponentInstructions(
  inspection: InspectedExtensionPackage,
  componentId: string,
): string {
  const reference = inspection.contentReferences[componentId];
  const file =
    reference === undefined
      ? undefined
      : inspection.files.find((candidate) => candidate.path === reference);
  if (file === undefined) throw new Error("Skill instructions are unavailable for review.");
  let instructions: string;
  try {
    instructions = new TextDecoder("utf-8", { fatal: true }).decode(file.content).trim();
  } catch {
    throw new Error("Skill instructions are unavailable for review.");
  }
  if (instructions === "" || instructions.length > MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH) {
    throw new Error("Skill instructions are unavailable for review.");
  }
  return instructions;
}

/**
 * What a person reviews before trusting a language server: the binary the host
 * would start, by its path in the package, and that file's own digest, so it
 * can be checked against the digest its author publishes.
 */
function previewLanguageServer(
  inspection: InspectedExtensionPackage,
  componentId: string,
  declaration: Pick<ExtensionPackageReviewLanguageServer, "languages" | "launchClass">,
): ExtensionPackageReviewLanguageServer {
  const binary = inspection.entryPoints[componentId];
  const file =
    binary === undefined
      ? undefined
      : inspection.files.find((candidate) => candidate.path === binary);
  if (binary === undefined || file === undefined) {
    throw new Error("Language server binary is unavailable for review.");
  }
  return decodeExtensionPackageReviewLanguageServer({
    languages: declaration.languages,
    launchClass: declaration.launchClass,
    binary,
    binaryDigest: `sha256:${createHash("sha256").update(file.content).digest("hex")}`,
  });
}

/**
 * What a person reviews before trusting a debug adapter: the binary the host
 * would start and that file's own digest, as for a language server, with the
 * runtimes it labels, the `launch` body it sends, and whether it takes a
 * debug port.
 */
function previewDebugAdapter(
  inspection: InspectedExtensionPackage,
  componentId: string,
  declaration: ExtensionDebugAdapterDeclaration,
): ExtensionPackageReviewDebugAdapter {
  const binary = inspection.entryPoints[componentId];
  const file =
    binary === undefined
      ? undefined
      : inspection.files.find((candidate) => candidate.path === binary);
  if (binary === undefined || file === undefined) {
    throw new Error("Debug adapter binary is unavailable for review.");
  }
  return decodeExtensionPackageReviewDebugAdapter({
    runtimes: declaration.runtimes,
    launchArguments: declaration.launchArguments,
    importTypes: declaration.importTypes,
    debugPorts: declaration.debugPorts,
    ...(declaration.childSessions === undefined
      ? {}
      : { childSessions: declaration.childSessions }),
    ...(declaration.childAnnouncement === undefined
      ? {}
      : { childAnnouncement: declaration.childAnnouncement }),
    binary,
    binaryDigest: `sha256:${createHash("sha256").update(file.content).digest("hex")}`,
  });
}

function unsupportedCommand(): ExtensionCommandResult {
  return failure("blocked", "Extension command is not available in this phase.");
}

function unavailableSkills(): ExtensionCommandResult {
  return failure("unavailable", "Standalone skill sources are unavailable.");
}

function lifecycleMessage(category: ExtensionLifecycleServiceError["category"]): string {
  if (category === "invalid") return "Extension lifecycle target is invalid.";
  if (category === "conflict") return "Extension lifecycle state changed; retry.";
  if (category === "interrupted") return "Extension lifecycle operation was interrupted.";
  if (category === "waiting") return "Extension lifecycle cleanup is waiting.";
  if (category === "failed") return "Extension lifecycle operation failed.";
  return "Extension lifecycle is unavailable.";
}

function apiCategory(
  category: ExtensionLifecycleServiceError["category"],
): "invalid" | "stale" | "unavailable" | "interrupted" | "waiting" | "failed" {
  return category === "conflict" ? "stale" : category;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}
