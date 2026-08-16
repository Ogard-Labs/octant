import { describe, expect, it } from "vitest";
import type { ContextEntryId, KnownTokenMeasurement, ProviderInstanceId } from "@octant/contracts";
import { decodeContextEntry } from "@octant/contracts";
import type {
  CapabilityCatalog,
  CapabilityCatalogEntry,
  CapabilitySelectionRequest,
} from "./capabilityCatalog";
import { deriveCatalogEpoch, selectCapabilities } from "./capabilityCatalog";
import {
  composeCapabilityContextEntries,
  composeLargeResultReference,
} from "./capabilityComposition";

const providerA = "00000000-0000-4000-8000-000000000005" as ProviderInstanceId;
const activeScope = {
  mode: { referenceId: "mode:code", revision: 1 },
  project: { referenceId: "project:one", revision: 1 },
  host: { referenceId: "host:local", revision: 1 },
  model: { referenceId: "model:one", revision: 1 },
} as const;

function known(
  tokens: number,
  accuracy: KnownTokenMeasurement["accuracy"] = "exact-tokenizer",
): KnownTokenMeasurement {
  return { kind: "known", tokens, accuracy };
}

function baseEntry(overrides: Partial<CapabilityCatalogEntry> = {}): CapabilityCatalogEntry {
  const componentKind = overrides.componentKind ?? "octant-tool";
  const source =
    overrides.source ??
    (componentKind === "octant-tool"
      ? { kind: "octant-tool" as const, referenceId: "tool-1", componentId: "tool-1" }
      : componentKind.startsWith("mcp-")
        ? { kind: "mcp-server" as const, referenceId: "mcp-1", componentId: "component-1" }
        : componentKind === "skill-instruction"
          ? {
              kind: "skill-package" as const,
              referenceId: "skill-1",
              packageId: "skill-package-1",
              componentId: "skill-component-1",
            }
          : {
              kind: "plugin-package" as const,
              referenceId: "plugin-1",
              packageId: "plugin-package-1",
              componentId: "plugin-component-1",
            });
  return {
    id: "00000000-0000-4000-8000-000000000010",
    source,
    componentKind,
    label: "Test capability",
    schemaCost: known(100),
    availability: "available",
    trust: "trusted",
    enablement: "enabled",
    policy: "allowed",
    providerEligibility: {
      providerInstanceId: providerA,
      status: "eligible",
      reason: "selected-provider",
    },
    scopeEligibility: {
      mode: { ...activeScope.mode, status: "eligible" },
      project: { ...activeScope.project, status: "eligible" },
      host: { ...activeScope.host, status: "eligible" },
      model: { ...activeScope.model, status: "eligible" },
    },
    posture: "optional",
    selectionMode: "task-specific",
    taskKeywords: [],
    epoch: 1,
    invalidationFacts: [{ kind: "explicit-refresh" }],
    ...overrides,
  };
}

function makeCatalog(entries: ReadonlyArray<CapabilityCatalogEntry>): CapabilityCatalog {
  return {
    entries,
    epoch: deriveCatalogEpoch({
      entries,
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [],
    }),
  };
}

describe("composeCapabilityContextEntries", () => {
  it("produces valid ContextEntry objects for selected capabilities", () => {
    const essential = baseEntry({
      id: "00000000-0000-4000-8000-000000000020",
      componentKind: "octant-tool",
      posture: "essential",
      selectionMode: "automatic",
      schemaCost: known(100),
    });
    const mcpTool = baseEntry({
      id: "00000000-0000-4000-8000-000000000021",
      componentKind: "mcp-tool",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["x"],
      schemaCost: known(120),
    });
    const skill = baseEntry({
      source: {
        kind: "skill-package",
        referenceId: "skill-1",
        packageId: "skill-package-1",
        componentId: "instructions",
      },
      id: "00000000-0000-4000-8000-000000000022",
      componentKind: "skill-instruction",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["x"],
      schemaCost: known(140),
    });

    const catalog = makeCatalog([skill, mcpTool, essential]);

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: ["x"],
      explicitSelections: [],
    };

    const selection = selectCapabilities(catalog, request);
    const entries = composeCapabilityContextEntries(selection, {});

    for (const entry of entries) {
      expect(() => decodeContextEntry(entry)).not.toThrow();
    }

    expect(entries.map((e) => e.source.kind)).toEqual(["tool", "mcp", "skill"]);
    expect(entries.map((e) => e.category)).toEqual([
      "octant-tools",
      "mcp",
      "extension-instructions",
    ]);
    expect(entries.map((e) => e.posture)).toEqual(["required", "removable", "compressible"]);
  });

  it("does not embed raw .agents/ skill content and uses redacted previews", () => {
    const skill = baseEntry({
      id: "00000000-0000-4000-8000-000000000030",
      componentKind: "skill-instruction",
      source: {
        kind: "agents-skills-directory",
        referenceId: ".agents/skills/my-skill/SKILL.md",
        packageId: "my-skill",
        componentId: "instructions",
      },
      selectionMode: "explicit",
      posture: "optional",
      schemaCost: known(250),
    });

    const catalog = makeCatalog([skill]);

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [skill.id],
    };

    const selection = selectCapabilities(catalog, request);
    const entries = composeCapabilityContextEntries(selection, {});
    const contextEntry = entries[0];

    expect(contextEntry).toBeDefined();
    if (contextEntry === undefined) throw new Error("Context entry missing");
    expect(contextEntry.source.kind).toBe("skill");
    expect(contextEntry.source.referenceId).toBe(".agents/skills/my-skill/SKILL.md");
    expect(contextEntry.preview.redacted).toBe(true);
    expect("content" in contextEntry).toBe(false);
    expect(contextEntry.includedSize).toBe(250);
    expect(contextEntry.originalSize).toBe(250);
    expect(contextEntry.tokens).toEqual({
      kind: "known",
      tokens: 250,
      accuracy: "exact-tokenizer",
    });
  });

  it("marks explicitly selected optional components as required context entries", () => {
    const prompt = baseEntry({
      id: "00000000-0000-4000-8000-000000000031",
      componentKind: "mcp-prompt",
      selectionMode: "explicit",
      posture: "optional",
      schemaCost: known(80),
    });

    const catalog = makeCatalog([prompt]);

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [prompt.id],
    };

    const selection = selectCapabilities(catalog, request);
    const entries = composeCapabilityContextEntries(selection, {});

    expect(entries[0]?.posture).toBe("required");
  });
});

describe("composeLargeResultReference", () => {
  it("produces a referenced ContextEntry with bounded included size and no raw content", () => {
    const entry = composeLargeResultReference({
      resultId: "00000000-0000-4000-8000-000000000040" as ContextEntryId,
      canonicalReference: {
        kind: "artifact",
        referenceId: "artifact-123",
        locality: "local",
      },
      label: "Large tool result",
      resultSize: 5000,
      metadataSize: 64,
      metadataTokens: known(24),
      providerInstanceId: providerA,
      category: "tool-results",
      turn: 1,
    });

    expect(() => decodeContextEntry(entry)).not.toThrow();
    expect(entry.state).toBe("referenced");
    expect(entry.source).toEqual({ kind: "artifact", referenceId: "artifact-123" });
    expect(entry.originalSize).toBe(5000);
    expect(entry.includedSize).toBe(64);
    expect(entry.tokens).toEqual({
      kind: "known",
      tokens: 24,
      accuracy: "exact-tokenizer",
    });
    expect("content" in entry).toBe(false);
  });

  it("rejects path-like references and metadata above the hard token ceiling", () => {
    const base = {
      resultId: "00000000-0000-4000-8000-000000000041" as ContextEntryId,
      label: "Large tool result",
      resultSize: 5000,
      metadataSize: 64,
      metadataTokens: known(24),
      providerInstanceId: providerA,
      category: "tool-results" as const,
    };

    expect(() =>
      composeLargeResultReference({
        ...base,
        canonicalReference: {
          kind: "file",
          referenceId: "/Users/example/private.txt",
          locality: "local",
        },
      }),
    ).toThrow("canonical local reference");

    expect(() =>
      composeLargeResultReference({
        ...base,
        canonicalReference: {
          kind: "artifact",
          referenceId: "artifact-remote",
          locality: "remote",
        },
      } as unknown as Parameters<typeof composeLargeResultReference>[0]),
    ).toThrow("canonical local reference");

    expect(() =>
      composeLargeResultReference({
        ...base,
        canonicalReference: {
          kind: "artifact",
          referenceId: "artifact-124",
          locality: "local",
        },
        metadataTokens: known(257),
      }),
    ).toThrow("metadata token ceiling");
  });
});
