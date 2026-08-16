import {
  MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH,
  type ExtensionCommand,
  type ExtensionCommandResult,
  type ExtensionSnapshot,
  type SkillMarketplaceEntry,
} from "@octant/contracts/extension-rpc";
import type { ExtensionPackageManifest, StandaloneSkillRecord } from "@octant/contracts/extensions";
import { buildSkillCatalog, sourceQualifiedSkillId, bundledSkillRecords } from "@octant/extensions";
import type { ExtensionLifecycleService } from "./extensionLifecycleService";
import {
  inspectExtensionPackage,
  type InspectedExtensionPackage,
  type ResolvedExtensionPackage,
} from "./packageInspector";
import type { SkillDiscoveryService } from "./skillDiscoveryService";

export interface SkillMarketplacePort {
  search(
    query: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly entries: ReadonlyArray<SkillMarketplaceEntry>;
    readonly nextCursor?: string;
  }>;
  resolve(
    source: Extract<ExtensionCommand, { readonly kind: "preview-skill" }>["source"],
    signal?: AbortSignal,
  ): Promise<ResolvedExtensionPackage>;
}

type SkillCommand = Extract<
  ExtensionCommand,
  {
    readonly kind:
      | "search-skills"
      | "preview-skill"
      | "install-skill"
      | "update-skill"
      | "remove-skill"
      | "reconcile-skills";
  }
>;

export class StandaloneSkillService {
  readonly #discovery: Pick<SkillDiscoveryService, "snapshot" | "reconcile"> &
    Partial<Pick<SkillDiscoveryService, "startWatching">>;
  readonly #marketplace: SkillMarketplacePort | undefined;
  readonly #lifecycle: Pick<
    ExtensionLifecycleService,
    "snapshot" | "install" | "update" | "uninstall"
  >;
  readonly #inspections = new Map<string, InspectedExtensionPackage>();

  constructor(options: {
    readonly discovery: Pick<SkillDiscoveryService, "snapshot" | "reconcile"> &
      Partial<Pick<SkillDiscoveryService, "startWatching">>;
    readonly marketplace?: SkillMarketplacePort;
    readonly lifecycle: Pick<
      ExtensionLifecycleService,
      "snapshot" | "install" | "update" | "uninstall"
    >;
  }) {
    this.#discovery = options.discovery;
    this.#marketplace = options.marketplace;
    this.#lifecycle = options.lifecycle;
  }

  async reconcile(): Promise<ExtensionSnapshot> {
    await this.#discovery.reconcile();
    await this.#discovery.startWatching?.();
    return this.snapshot(this.#lifecycle.snapshot());
  }

  snapshot(base: ExtensionSnapshot): ExtensionSnapshot {
    const installed = base.packages.flatMap((pkg) =>
      pkg.components
        .filter(({ component }) => component.kind === "skill-instructions")
        .map(({ component, activation, effectiveState }) =>
          installedSkill(pkg, component, activation, effectiveState),
        ),
    );
    const discovered = this.#discovery
      .snapshot()
      .skills.filter(
        (skill) =>
          !installed.some((candidate) => candidate.skill.qualifiedId === skill.skill.qualifiedId),
      );
    const bundled = bundledSkillRecords().filter(
      (skill) =>
        !installed.some((candidate) => candidate.skill.qualifiedId === skill.skill.qualifiedId) &&
        !discovered.some((candidate) => candidate.skill.qualifiedId === skill.skill.qualifiedId),
    );
    const catalog = buildSkillCatalog([...discovered, ...bundled, ...installed]);
    return {
      ...base,
      skills: catalog.skills,
      collisions: [...base.collisions, ...catalog.collisions],
    };
  }

  async execute(command: SkillCommand, signal?: AbortSignal): Promise<ExtensionCommandResult> {
    switch (command.kind) {
      case "search-skills": {
        if (this.#marketplace === undefined) throw new Error("Skill marketplace is unavailable.");
        const result = await this.#marketplace.search(command.query, command.cursor, signal);
        return {
          kind: "skill-search-results",
          entries: [...result.entries],
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        };
      }
      case "preview-skill": {
        const inspection = await this.#inspect(command.source, signal);
        return {
          kind: "skill-package-preview",
          preview: {
            entry: skillMarketplaceEntry(inspection.manifest),
            extensionId: inspection.manifest.extensionId,
            packageId: inspection.manifest.packageId,
            license: inspection.manifest.license,
            ...previewSkillInstructions(inspection),
            diagnostics: [],
          },
        };
      }
      case "install-skill":
        return this.#change(command, "install");
      case "update-skill":
        return this.#change(command, "update");
      case "remove-skill":
        return {
          kind: "extension-state-updated",
          snapshot: this.snapshot(await this.#lifecycle.uninstall(command.extensionId)),
        };
      case "reconcile-skills":
        return { kind: "extension-state-updated", snapshot: await this.reconcile() };
    }
  }

  async #inspect(
    source: Extract<ExtensionCommand, { readonly kind: "preview-skill" }>["source"],
    signal?: AbortSignal,
  ) {
    if (this.#marketplace === undefined) throw new Error("Skill marketplace is unavailable.");
    const resolved = await this.#marketplace.resolve(source, signal);
    const inspection = inspectExtensionPackage(resolved);
    if (
      !inspection.manifest.components.some((component) => component.kind === "skill-instructions")
    ) {
      throw new Error("Skill package is invalid.");
    }
    this.#inspections.set(targetKey(inspection.manifest), inspection);
    while (this.#inspections.size > 64) {
      const oldest = this.#inspections.keys().next().value;
      if (oldest === undefined) break;
      this.#inspections.delete(oldest);
    }
    return inspection;
  }

  async #change(
    command: Extract<ExtensionCommand, { readonly kind: "install-skill" | "update-skill" }>,
    operation: "install" | "update",
  ): Promise<ExtensionCommandResult> {
    const inspection = this.#inspections.get(targetKey(command));
    if (inspection === undefined) {
      return {
        kind: "extension-command-failed",
        failure: { category: "stale", message: "Skill preview is required." },
      };
    }
    const snapshot =
      operation === "install"
        ? await this.#lifecycle.install(inspection)
        : await this.#lifecycle.update(inspection);
    return { kind: "extension-state-updated", snapshot: this.snapshot(snapshot) };
  }
}

function installedSkill(
  pkg: ExtensionSnapshot["packages"][number],
  component: ExtensionPackageManifest["components"][number],
  activation: ExtensionSnapshot["packages"][number]["activation"],
  effectiveState: ExtensionSnapshot["packages"][number]["components"][number]["effectiveState"],
): StandaloneSkillRecord {
  const skillId = sourceQualifiedSkillId(pkg.source, component.id, pkg.digest);
  return {
    skill: {
      qualifiedId: skillId,
      name: component.skillName ?? component.id,
      sourceKind: pkg.source.kind,
      digest: pkg.digest,
      available: true,
    },
    source: pkg.source,
    version: pkg.version,
    displayName: component.displayName,
    ...(component.description === undefined ? {} : { description: component.description }),
    provenance: { reviewed: activation.trusted },
    contentBytes: 0,
    reviewed: activation.trusted,
    desiredEnabled: activation.componentDesired,
    effectiveState,
  };
}

function skillMarketplaceEntry(manifest: ExtensionPackageManifest): SkillMarketplaceEntry {
  const component = manifest.components.find(
    (candidate) => candidate.kind === "skill-instructions",
  );
  if (component === undefined) throw new Error("Skill package is invalid.");
  return {
    skill: {
      qualifiedId: sourceQualifiedSkillId(manifest.source, component.id, manifest.digest),
      name: component.skillName ?? component.id,
      sourceKind: manifest.source.kind,
      digest: manifest.digest,
      available: true,
    },
    source: manifest.source,
    version: manifest.version,
    displayName: component.displayName,
    ...(component.description === undefined ? {} : { description: component.description }),
    provenance: manifest.provenance,
  };
}

function previewSkillInstructions(inspection: InspectedExtensionPackage): {
  readonly instructions?: string;
} {
  const component = inspection.manifest.components.find(
    (candidate) => candidate.kind === "skill-instructions",
  );
  if (component === undefined) throw new Error("Skill package is invalid.");
  const referencedPath = inspection.contentReferences[component.id];
  const file =
    referencedPath === undefined
      ? inspection.files.find(
          (candidate) => candidate.path === "SKILL.md" || candidate.path.endsWith("/SKILL.md"),
        )
      : inspection.files.find((candidate) => candidate.path === referencedPath);
  if (file === undefined) throw new Error("Skill instructions are unavailable for review.");
  let instructions: string;
  try {
    instructions = new TextDecoder("utf-8", { fatal: true }).decode(file.content).trim();
  } catch {
    throw new Error("Skill instructions are unavailable for review.");
  }
  if (instructions === "") return {};
  if (instructions.length > MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH) {
    throw new Error("Skill instructions exceed the preview limit.");
  }
  return { instructions };
}

function targetKey(value: {
  readonly extensionId: string;
  readonly packageId: string;
  readonly version: string;
  readonly digest: string;
}): string {
  return `${value.extensionId}:${value.packageId}:${value.version}:${value.digest}`;
}
