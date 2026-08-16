import type { ContextEntry, ProviderContextBlock, ProviderToolDefinition } from "@octant/contracts";
import {
  MAX_PROVIDER_CONTEXT_BLOCKS,
  MAX_PROVIDER_TOOLS,
  decodeProviderContextBlock,
  decodeProviderToolDefinition,
} from "@octant/contracts";
import type { ExtensionCatalogEpoch, ExtensionSelection } from "@octant/contracts/extensions";
import {
  revalidateExtensionSelection,
  type ExtensionAddressingCatalog,
  type ExtensionSelectionPhase,
} from "@octant/plugin-host";
import type {
  CapabilityCatalog,
  CapabilityCatalogEntry,
  CapabilitySelectionRequest,
} from "../context/capabilityCatalog";
import { selectCapabilities } from "../context/capabilityCatalog";
import { composeCapabilityContextEntries } from "../context/capabilityComposition";

export interface ComposeSelectedExtensionCapabilitiesInput {
  readonly phase: ExtensionSelectionPhase;
  readonly selections: ReadonlyArray<ExtensionSelection>;
  readonly addressingCatalog: ExtensionAddressingCatalog;
  readonly authoritativeCatalogEpoch: ExtensionCatalogEpoch;
  readonly capabilityCatalog: CapabilityCatalog;
  readonly capabilityRequest: CapabilitySelectionRequest;
  readonly loadMaterial: (entry: CapabilityCatalogEntry) => Promise<{
    readonly context?: ProviderContextBlock;
    readonly tools: ReadonlyArray<ProviderToolDefinition>;
  }>;
}

export type ComposedExtensionCapabilities =
  | {
      readonly status: "selected";
      readonly contextEntries: ReadonlyArray<ContextEntry>;
      readonly providerContext: ReadonlyArray<ProviderContextBlock>;
      readonly contextBindings: ReadonlyArray<{
        readonly contextEntry: ContextEntry;
        readonly providerContext?: ProviderContextBlock;
      }>;
      readonly tools: ReadonlyArray<ProviderToolDefinition>;
    }
  | {
      readonly status: "blocked";
      readonly reasons: ReadonlyArray<string>;
      readonly contextEntries: readonly [];
      readonly providerContext: readonly [];
      readonly tools: readonly [];
    };

export async function composeSelectedExtensionCapabilities(
  input: ComposeSelectedExtensionCapabilitiesInput,
): Promise<ComposedExtensionCapabilities> {
  if (input.addressingCatalog.epoch !== input.authoritativeCatalogEpoch) {
    return blocked(["authoritative-catalog-epoch-mismatch"]);
  }
  const reasons: Array<string> = [];
  const capabilityBindings: Array<{
    readonly capabilityId: string;
    readonly selection: ExtensionSelection;
  }> = [];
  for (const selection of input.selections) {
    const result = revalidateExtensionSelection(selection, input.addressingCatalog, input.phase);
    if (result.kind === "blocked") {
      reasons.push(result.reason);
      continue;
    }
    capabilityBindings.push(
      ...selectionCapabilityIds(selection, input.addressingCatalog).map((capabilityId) => ({
        capabilityId,
        selection,
      })),
    );
  }
  if (reasons.length > 0) return blocked(reasons);
  if (input.selections.length > 0 && capabilityBindings.length === 0) {
    return blocked(["capability-not-projected"]);
  }
  const capabilityIds = capabilityBindings.map(({ capabilityId }) => capabilityId);
  const explicitSelections = [...new Set(capabilityIds)];
  if (explicitSelections.length !== capabilityIds.length) {
    return blocked(["duplicate-capability-selection"]);
  }

  const selected = selectCapabilities(input.capabilityCatalog, {
    ...input.capabilityRequest,
    explicitSelections,
  });
  if (selected.status === "blocked") return blocked(selected.blockedReasons);
  const selectedById = new Map(selected.selected.map((entry) => [entry.id, entry]));
  const missing = explicitSelections.filter((id) => !selectedById.has(id));
  if (missing.length > 0) {
    return blocked(
      missing.map((id) => {
        const omitted = selected.omitted.find((entry) => entry.id === id);
        return `capability-blocked:${id}:${omitted?.reason ?? "not-selected"}`;
      }),
    );
  }
  const extensionEntries = explicitSelections.map((id) => selectedById.get(id)!);
  const provenanceMismatches = extensionEntries.filter((entry) => {
    const binding = capabilityBindings.find(({ capabilityId }) => capabilityId === entry.id)!;
    return !matchesSelectionProvenance(binding.selection, entry);
  });
  if (provenanceMismatches.length > 0) {
    return blocked(
      provenanceMismatches.map((entry) => `capability-provenance-mismatch:${entry.id}`),
    );
  }
  const extensionSelection = {
    ...selected,
    selected: extensionEntries,
    loadedSchemaIds: explicitSelections,
    explicitlySelectedIds: explicitSelections,
  };
  let contextEntries: ReadonlyArray<ContextEntry>;
  try {
    contextEntries = composeCapabilityContextEntries(extensionSelection, {
      redactedPreview: true,
    });
  } catch {
    return blocked(["extension-context-invalid"]);
  }

  try {
    const materials = await Promise.all(extensionEntries.map((entry) => input.loadMaterial(entry)));
    if (materials.length !== contextEntries.length) {
      return blocked(["extension-context-association-invalid"]);
    }
    const contextBindings = contextEntries.map((contextEntry, index) => {
      const context = materials[index]!.context;
      return {
        contextEntry,
        ...(context === undefined ? {} : { providerContext: decodeProviderContextBlock(context) }),
      };
    });
    const providerContext = contextBindings.flatMap((binding) =>
      binding.providerContext === undefined ? [] : [binding.providerContext],
    );
    const tools = materials
      .flatMap((material) => material.tools)
      .map((tool) => decodeProviderToolDefinition(tool));
    if (providerContext.length > MAX_PROVIDER_CONTEXT_BLOCKS) {
      return blocked(["extension-context-overflow"]);
    }
    if (tools.length > MAX_PROVIDER_TOOLS) return blocked(["extension-tool-overflow"]);
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      return blocked(["extension-tool-name-collision"]);
    }
    return { status: "selected", contextEntries, providerContext, contextBindings, tools };
  } catch {
    return blocked(["extension-material-unavailable"]);
  }
}

function matchesSelectionProvenance(
  selection: ExtensionSelection,
  entry: CapabilityCatalogEntry,
): boolean {
  if (selection.kind === "plugin") {
    return (
      entry.source.kind === "plugin-package" &&
      entry.source.referenceId ===
        `extension:${String(selection.extensionId)}:${String(selection.packageId)}` &&
      entry.source.packageId === String(selection.packageId) &&
      entry.source.componentId === selection.componentId
    );
  }
  return (
    (entry.source.kind === "skill-package" ||
      entry.source.kind === "agents-skills-directory" ||
      entry.source.kind === "plugin-package") &&
    entry.source.referenceId === selection.skillId
  );
}

function selectionCapabilityIds(
  selection: ExtensionSelection,
  catalog: ExtensionAddressingCatalog,
): ReadonlyArray<string> {
  if (selection.kind === "plugin") {
    const component = catalog.plugins
      .find((plugin) => plugin.extensionId === selection.extensionId)
      ?.components.find((candidate) => candidate.componentId === selection.componentId);
    return component?.capabilityIds ?? [];
  }
  return (
    catalog.skills.find((candidate) => candidate.skillId === selection.skillId)?.capabilityIds ?? []
  );
}

function blocked(reasons: ReadonlyArray<string>): ComposedExtensionCapabilities {
  return {
    status: "blocked",
    reasons: [...new Set(reasons)],
    contextEntries: [],
    providerContext: [],
    tools: [],
  };
}
