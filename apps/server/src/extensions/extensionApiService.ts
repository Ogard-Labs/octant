import {
  MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH,
  type ExtensionPackageReviewComponent,
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
import { StandaloneSkillService } from "./standaloneSkillService";

export interface ExtensionPackageResolverPort {
  resolve(
    command: Extract<ExtensionCommand, { readonly kind: "inspect-package" }>,
    signal?: AbortSignal,
  ): Promise<ResolvedExtensionPackage>;
  searchCatalog?(command: Extract<ExtensionCommand, { readonly kind: "search-catalog" }>): {
    readonly entries: ReadonlyArray<ExtensionCatalogEntry>;
    readonly nextCursor?: string;
  };
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
  readonly #onStateChanged: ((snapshot: ExtensionSnapshot) => void | Promise<void>) | undefined;
  readonly #inspections = new Map<string, InspectedExtensionPackage>();

  constructor(options: {
    readonly lifecycle: ExtensionLifecycleService;
    readonly resolver: ExtensionPackageResolverPort;
    readonly skills?: StandaloneSkillService;
    readonly activation?: ExtensionActivationServicePort;
    readonly onStateChanged?: (snapshot: ExtensionSnapshot) => void | Promise<void>;
  }) {
    this.#lifecycle = options.lifecycle;
    this.#resolver = options.resolver;
    this.#skills = options.skills;
    this.#activation = options.activation;
    this.#onStateChanged = options.onStateChanged;
  }

  snapshot(): ExtensionSnapshot {
    const snapshot = this.#lifecycle.snapshot();
    return this.#skills?.snapshot(snapshot) ?? snapshot;
  }

  async execute(command: ExtensionCommand, signal?: AbortSignal): Promise<ExtensionCommandResult> {
    try {
      switch (command.kind) {
        case "search-catalog": {
          if (this.#resolver.searchCatalog === undefined) return unsupportedCommand();
          const result = this.#resolver.searchCatalog(command);
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
        case "install-package": {
          const inspection = this.#inspections.get(commandKey(command));
          if (inspection === undefined) return inspectionRequired();
          return await this.#stateUpdated(await this.#lifecycle.install(inspection));
        }
        case "update-package": {
          const inspection = this.#inspections.get(commandKey(command));
          if (inspection === undefined) return inspectionRequired();
          return await this.#stateUpdated(await this.#lifecycle.update(inspection));
        }
        case "rollback-package":
          return await this.#stateUpdated(await this.#lifecycle.rollback(command));
        case "uninstall-package":
          return await this.#stateUpdated(await this.#lifecycle.uninstall(command.extensionId));
        case "set-plugin-desired":
          return await this.#stateUpdated(await this.#lifecycle.setPluginDesired(command));
        case "set-source-trust":
          return await this.#stateUpdated(await this.#lifecycle.setSourceTrust(command));
        case "set-component-desired":
          return await this.#stateUpdated(await this.#lifecycle.setComponentDesired(command));
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
          if (this.#skills === undefined) return unavailableSkills();
          {
            const result = await this.#skills.execute(command, signal);
            return result.kind === "extension-state-updated"
              ? await this.#stateUpdated(result.snapshot)
              : result;
          }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return failure("interrupted", "Extension inspection was interrupted.");
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
    const resolved = await this.#resolver.resolve(command, signal);
    const inspection = inspectExtensionPackage({
      ...resolved,
      ...(resolved.expectedDigest === undefined ? {} : { expectedDigest: resolved.expectedDigest }),
    });
    this.#remember(inspection);
    return inspection;
  }

  async #stateUpdated(snapshot: ExtensionSnapshot): Promise<ExtensionCommandResult> {
    if (this.#onStateChanged !== undefined) {
      await this.#onStateChanged(snapshot);
    }
    return { kind: "extension-state-updated", snapshot };
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
        return {
          id: component.id,
          kind: component.kind,
          displayName: component.displayName,
          declaredCapabilities: component.declaredCapabilities,
          ...(instructions === undefined ? {} : { instructions }),
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
