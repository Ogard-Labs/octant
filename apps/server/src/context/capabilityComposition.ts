import { decodeContextEntry } from "@octant/contracts";
import type {
  ContextEntry,
  ContextEntryCategory,
  ContextEntryId,
  ContextEntryPosture,
  ContextSourceRef,
  KnownTokenMeasurement,
  ProviderInstanceId,
  TokenMeasurement,
} from "@octant/contracts";
import type {
  CapabilityCatalogEntry,
  CapabilityComponentKind,
  CapabilitySelection,
  CapabilitySource,
} from "./capabilityCatalog";
import { assertExternalContentNotInInstructionSection } from "./externalContentFraming";

export interface CapabilityCompositionOptions {
  readonly turn?: number;
  readonly redactedPreview?: boolean;
  readonly entryIdFromCapability?: ((entry: CapabilityCatalogEntry) => ContextEntryId) | undefined;
}

export function composeCapabilityContextEntries(
  selection: CapabilitySelection,
  options: CapabilityCompositionOptions,
): ReadonlyArray<ContextEntry> {
  const turn = options.turn ?? 1;
  const redacted = options.redactedPreview ?? true;
  const explicitSet = new Set(selection.explicitlySelectedIds);

  return selection.selected
    .map((entry, index) =>
      toContextEntry(entry, {
        turn,
        redacted,
        priority: index,
        explicit: explicitSet.has(entry.id),
        entryIdFromCapability: options.entryIdFromCapability,
      }),
    )
    .map((entry) => decodeContextEntry(entry));
}

export interface LargeResultReferenceOptions {
  readonly resultId: ContextEntryId;
  readonly canonicalReference: {
    readonly kind: "artifact" | "file";
    readonly referenceId: string;
    readonly locality: "local";
  };
  readonly label: string;
  readonly resultSize: number;
  readonly metadataSize: number;
  readonly metadataTokens: KnownTokenMeasurement;
  readonly providerInstanceId: ProviderInstanceId;
  readonly category: "tool-results" | "subagent-results";
  readonly turn?: number;
  /** When provided, provenance must not target instruction/system sections. */
  readonly contentOrigin?: "tool-result" | "external-content";
}

export const MAX_LARGE_RESULT_REFERENCE_METADATA_TOKENS = 256;
const canonicalLocalReferenceId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function composeLargeResultReference(options: LargeResultReferenceOptions): ContextEntry {
  const turn = options.turn ?? 1;
  if (options.contentOrigin !== undefined) {
    assertExternalContentNotInInstructionSection({
      origin: options.contentOrigin,
      section: options.category,
    });
  }
  if (
    options.canonicalReference.locality !== "local" ||
    (options.canonicalReference.kind !== "artifact" &&
      options.canonicalReference.kind !== "file") ||
    !canonicalLocalReferenceId.test(options.canonicalReference.referenceId)
  ) {
    throw new Error("Large results require an opaque canonical local reference");
  }
  if (
    !Number.isSafeInteger(options.resultSize) ||
    options.resultSize < 0 ||
    !Number.isSafeInteger(options.metadataSize) ||
    options.metadataSize < 0 ||
    options.metadataSize > options.resultSize
  ) {
    throw new Error("Large-result sizes must be safe non-negative integers");
  }
  if (
    !Number.isSafeInteger(options.metadataTokens.tokens) ||
    options.metadataTokens.tokens < 0 ||
    options.metadataTokens.tokens > MAX_LARGE_RESULT_REFERENCE_METADATA_TOKENS
  ) {
    throw new Error("Large-result metadata token ceiling exceeded");
  }

  const entry: ContextEntry = {
    id: options.resultId,
    source: {
      kind: options.canonicalReference.kind,
      referenceId: options.canonicalReference.referenceId,
    },
    category: options.category,
    label: options.label,
    eligibility: {
      providerInstanceId: options.providerInstanceId,
      status: "eligible",
      reason: "selected-provider",
    },
    posture: "removable",
    retention: "active",
    priority: 0,
    originalSize: options.resultSize,
    includedSize: options.metadataSize,
    tokens: options.metadataTokens,
    state: "referenced",
    introducedAtTurn: turn,
    lastUsedAtTurn: turn,
    reuseCount: 0,
    preview: {
      redacted: true,
      label: options.label,
    },
  };

  return decodeContextEntry(entry);
}

interface ContextEntryTemplateOptions {
  readonly turn: number;
  readonly redacted: boolean;
  readonly priority: number;
  readonly explicit: boolean;
  readonly entryIdFromCapability?: ((entry: CapabilityCatalogEntry) => ContextEntryId) | undefined;
}

function toContextEntry(
  entry: CapabilityCatalogEntry,
  options: ContextEntryTemplateOptions,
): ContextEntry {
  const size = toSize(entry.schemaCost);
  const contextEntry: ContextEntry = {
    id: options.entryIdFromCapability
      ? options.entryIdFromCapability(entry)
      : (entry.id as ContextEntryId),
    source: {
      kind: toContextSourceKind(entry.source.kind, entry.componentKind),
      referenceId: entry.source.referenceId,
    },
    category: toContextEntryCategory(entry.componentKind),
    label: entry.label,
    eligibility: entry.providerEligibility,
    posture: toContextEntryPosture(entry, options.explicit),
    retention: "active",
    priority: options.priority,
    originalSize: size.originalSize,
    includedSize: size.includedSize,
    tokens: entry.schemaCost,
    state: "included",
    introducedAtTurn: options.turn,
    lastUsedAtTurn: options.turn,
    reuseCount: 0,
    preview: {
      redacted: options.redacted,
      label: entry.label,
    },
  };

  return contextEntry;
}

function toContextSourceKind(
  sourceKind: CapabilitySource["kind"],
  componentKind: CapabilityComponentKind,
): ContextSourceRef["kind"] {
  if (
    componentKind === "mcp-tool" ||
    componentKind === "mcp-prompt" ||
    componentKind === "mcp-resource"
  ) {
    return "mcp";
  }
  switch (sourceKind) {
    case "octant-tool":
      return "tool";
    case "mcp-server":
      return "mcp";
    case "skill-package":
    case "agents-skills-directory":
      return "skill";
    case "plugin-package":
      return "plugin";
  }
}

function toContextEntryCategory(componentKind: CapabilityComponentKind): ContextEntryCategory {
  switch (componentKind) {
    case "octant-tool":
      return "octant-tools";
    case "mcp-tool":
    case "mcp-prompt":
    case "mcp-resource":
      return "mcp";
    case "skill-instruction":
    case "plugin-instruction":
      return "extension-instructions";
  }
}

function toContextEntryPosture(
  entry: CapabilityCatalogEntry,
  explicit: boolean,
): ContextEntryPosture {
  if (entry.posture === "essential" || explicit) return "required";
  switch (entry.componentKind) {
    case "skill-instruction":
    case "plugin-instruction":
    case "mcp-prompt":
    case "mcp-resource":
      return "compressible";
    default:
      return "removable";
  }
}

function toSize(schemaCost: TokenMeasurement): {
  readonly originalSize: number;
  readonly includedSize: number;
} {
  if (schemaCost.kind === "known") {
    return { originalSize: schemaCost.tokens, includedSize: schemaCost.tokens };
  }
  return { originalSize: 0, includedSize: 0 };
}
