import type {
  ExtensionBlockReason,
  ExtensionCatalogEpoch,
  ExtensionComponentId,
  ExtensionContentDigest,
  ExtensionEffectiveState,
  ExtensionPackageId,
  ExtensionPackageVersion,
  ExtensionSelection,
  ExtensionSlug,
  SourceQualifiedSkillId,
} from "@octant/contracts/extensions";
import { decodeExtensionSelection } from "@octant/contracts/extensions";
import type { ToolExtensionId } from "@octant/contracts/tool-actions";
import { parseComposerReference } from "./composer";

export interface AddressableExtensionComponent {
  readonly componentId: ExtensionComponentId;
  readonly label: string;
  readonly effectiveState: ExtensionEffectiveState;
  readonly capabilityIds?: ReadonlyArray<string>;
}

export interface AddressablePlugin {
  readonly extensionId: ToolExtensionId;
  readonly packageId: ExtensionPackageId;
  readonly slug: ExtensionSlug;
  readonly packageVersion: ExtensionPackageVersion;
  readonly packageDigest: ExtensionContentDigest;
  readonly primaryComponentId?: ExtensionComponentId;
  readonly components: ReadonlyArray<AddressableExtensionComponent>;
}

export interface AddressableSkill {
  readonly skillId: SourceQualifiedSkillId;
  readonly name: string;
  readonly label: string;
  readonly packageVersion?: ExtensionPackageVersion;
  readonly packageDigest: ExtensionContentDigest;
  readonly effectiveState: ExtensionEffectiveState;
  readonly capabilityIds?: ReadonlyArray<string>;
}

export interface ExtensionAddressingCatalog {
  readonly epoch: ExtensionCatalogEpoch;
  readonly plugins: ReadonlyArray<AddressablePlugin>;
  readonly skills: ReadonlyArray<AddressableSkill>;
}

export type ExtensionSelectionPhase = "send" | "resume" | "replay" | "provider-handoff";

export type ExtensionAddressingBlockReason =
  | ExtensionBlockReason
  | "not-found"
  | "component-required"
  | "stale-catalog-epoch"
  | "package-changed";

export type ExtensionDraftResolution =
  | { readonly kind: "plain-text"; readonly text: string }
  | {
      readonly kind: "ambiguous";
      readonly candidates: ReadonlyArray<string>;
    }
  | { readonly kind: "blocked"; readonly reason: ExtensionAddressingBlockReason }
  | {
      readonly kind: "selected";
      readonly label: string;
      readonly selection: ExtensionSelection;
    };

export type ExtensionSelectionRevalidation =
  | {
      readonly kind: "selected";
      readonly phase: ExtensionSelectionPhase;
      readonly selection: ExtensionSelection;
    }
  | {
      readonly kind: "blocked";
      readonly phase: ExtensionSelectionPhase;
      readonly reason: ExtensionAddressingBlockReason;
    };

export function resolveDraftExtensionReference(
  input: string,
  catalog: ExtensionAddressingCatalog,
  originReference: string,
): ExtensionDraftResolution {
  const parsed = parseComposerReference(input);
  if (parsed.kind === "plain-text") return parsed;
  if (parsed.kind === "plugin") {
    const candidates = catalog.plugins
      .filter((plugin) => plugin.slug === parsed.pluginSlug)
      .sort((left, right) => String(left.extensionId).localeCompare(String(right.extensionId)));
    if (candidates.length === 0) return { kind: "blocked", reason: "not-found" };
    if (candidates.length > 1) {
      return {
        kind: "ambiguous",
        candidates: candidates.map((candidate) => String(candidate.extensionId)),
      };
    }
    return resolvePlugin(
      candidates[0]!,
      parsed.componentId as ExtensionComponentId | undefined,
      catalog,
      originReference,
    );
  }
  return resolveSkill(parsed.skillName, catalog, originReference);
}

export function resolveStructuredPluginReference(
  reference: {
    readonly extensionId: ToolExtensionId;
    readonly componentId?: ExtensionComponentId;
  },
  catalog: ExtensionAddressingCatalog,
  originReference: string,
): ExtensionDraftResolution {
  const plugin = catalog.plugins.find(
    (candidate) => candidate.extensionId === reference.extensionId,
  );
  return plugin === undefined
    ? { kind: "blocked", reason: "not-found" }
    : resolvePlugin(plugin, reference.componentId, catalog, originReference);
}

export function resolveStructuredSkillReference(
  skillId: SourceQualifiedSkillId,
  catalog: ExtensionAddressingCatalog,
  originReference: string,
): ExtensionDraftResolution {
  return resolveSkill(skillId, catalog, originReference);
}

export function revalidateExtensionSelection(
  selection: ExtensionSelection,
  catalog: ExtensionAddressingCatalog,
  phase: ExtensionSelectionPhase,
): ExtensionSelectionRevalidation {
  if (selection.catalogEpoch !== catalog.epoch) {
    return { kind: "blocked", phase, reason: "stale-catalog-epoch" };
  }
  if (selection.kind === "plugin") {
    const plugin = catalog.plugins.find(
      (candidate) => candidate.extensionId === selection.extensionId,
    );
    if (plugin === undefined) return { kind: "blocked", phase, reason: "not-found" };
    if (
      plugin.packageId !== selection.packageId ||
      plugin.packageVersion !== selection.packageVersion ||
      plugin.packageDigest !== selection.packageDigest
    ) {
      return { kind: "blocked", phase, reason: "package-changed" };
    }
    if (selection.componentId === undefined) {
      return { kind: "blocked", phase, reason: "component-required" };
    }
    const component = plugin.components.find(
      (candidate) => candidate.componentId === selection.componentId,
    );
    if (component === undefined) return { kind: "blocked", phase, reason: "not-found" };
    if (component.effectiveState.kind === "blocked") {
      return { kind: "blocked", phase, reason: component.effectiveState.reason };
    }
    return { kind: "selected", phase, selection };
  }
  const skill = catalog.skills.find((candidate) => candidate.skillId === selection.skillId);
  if (skill === undefined) return { kind: "blocked", phase, reason: "not-found" };
  if (
    skill.packageVersion !== selection.packageVersion ||
    skill.packageDigest !== selection.packageDigest
  ) {
    return { kind: "blocked", phase, reason: "package-changed" };
  }
  if (skill.effectiveState.kind === "blocked") {
    return { kind: "blocked", phase, reason: skill.effectiveState.reason };
  }
  return { kind: "selected", phase, selection };
}

function resolvePlugin(
  plugin: AddressablePlugin,
  requestedComponentId: ExtensionComponentId | undefined,
  catalog: ExtensionAddressingCatalog,
  originReference: string,
): ExtensionDraftResolution {
  const componentId =
    requestedComponentId ??
    plugin.primaryComponentId ??
    (plugin.components.length === 1 ? plugin.components[0]!.componentId : undefined);
  if (componentId === undefined) return { kind: "blocked", reason: "component-required" };
  const component = plugin.components.find((candidate) => candidate.componentId === componentId);
  if (component === undefined) return { kind: "blocked", reason: "not-found" };
  if (component.effectiveState.kind === "blocked") {
    return { kind: "blocked", reason: component.effectiveState.reason };
  }
  return {
    kind: "selected",
    label: component.label,
    selection: decodeExtensionSelection({
      kind: "plugin",
      extensionId: plugin.extensionId,
      packageId: plugin.packageId,
      componentId,
      packageVersion: plugin.packageVersion,
      packageDigest: plugin.packageDigest,
      catalogEpoch: catalog.epoch,
      origin: { kind: "draft", reference: originReference },
    }),
  };
}

function resolveSkill(
  query: string,
  catalog: ExtensionAddressingCatalog,
  originReference: string,
): ExtensionDraftResolution {
  const exact = catalog.skills.find((candidate) => candidate.skillId === query);
  const candidates =
    exact === undefined ? catalog.skills.filter((skill) => skill.name === query) : [exact];
  if (candidates.length === 0) return { kind: "blocked", reason: "not-found" };
  if (candidates.length > 1) {
    return {
      kind: "ambiguous",
      candidates: candidates.map((candidate) => String(candidate.skillId)).sort(),
    };
  }
  const skill = candidates[0]!;
  if (skill.effectiveState.kind === "blocked") {
    return { kind: "blocked", reason: skill.effectiveState.reason };
  }
  return {
    kind: "selected",
    label: skill.label,
    selection: decodeExtensionSelection({
      kind: "skill",
      skillId: skill.skillId,
      ...(skill.packageVersion === undefined ? {} : { packageVersion: skill.packageVersion }),
      packageDigest: skill.packageDigest,
      catalogEpoch: catalog.epoch,
      origin: { kind: "draft", reference: originReference },
    }),
  };
}
