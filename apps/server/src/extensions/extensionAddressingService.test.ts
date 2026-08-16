import type { ProviderInstanceId } from "@octant/contracts";
import {
  resolveDraftExtensionReference,
  type ExtensionAddressingCatalog,
} from "@octant/extensions";
import { describe, expect, it, vi } from "vitest";
import {
  deriveCatalogEpoch,
  type CapabilityActiveScope,
  type CapabilityCatalog,
  type CapabilityCatalogEntry,
  type CapabilitySelectionRequest,
} from "../context/capabilityCatalog";
import { composeSelectedExtensionCapabilities } from "./extensionAddressingService";

const providerInstanceId = "10000000-0000-4000-8000-000000000001" as ProviderInstanceId;
const otherProviderInstanceId = "10000000-0000-4000-8000-000000000002" as ProviderInstanceId;
const extensionId = "20000000-0000-4000-8000-000000000001";
const otherExtensionId = "20000000-0000-4000-8000-000000000002";
const packageId = "21000000-0000-4000-8000-000000000001";
const otherPackageId = "21000000-0000-4000-8000-000000000002";
const digest = `sha256:${"a".repeat(64)}`;
const catalogEpoch = `sha256:${"c".repeat(64)}`;
const otherCatalogEpoch = `sha256:${"d".repeat(64)}`;
const instructionCapabilityId = "30000000-0000-4000-8000-000000000001";
const toolCapabilityId = "30000000-0000-4000-8000-000000000002";
const unselectedCapabilityId = "30000000-0000-4000-8000-000000000003";
const skillCapabilityId = "30000000-0000-4000-8000-000000000004";
const skillId = `agents-skills-directory:project~skills:review:${digest}`;

const activeScope: CapabilityActiveScope = {
  mode: { referenceId: "mode:chat", revision: 1 },
  project: { referenceId: "project:alpha", revision: 1 },
  host: { referenceId: "host:local", revision: 1 },
  model: { referenceId: "model:gpt-compatible", revision: 1 },
};

function entry(input: {
  readonly id: string;
  readonly componentId: string;
  readonly kind: "plugin-instruction" | "mcp-tool";
}): CapabilityCatalogEntry {
  return {
    id: input.id,
    source: {
      kind: "plugin-package",
      referenceId: `extension:${extensionId}:${packageId}`,
      packageId,
      componentId: input.componentId,
    },
    componentKind: input.kind,
    label: input.componentId,
    schemaCost: { kind: "known", tokens: 12, accuracy: "exact-tokenizer" },
    availability: "available",
    trust: "trusted",
    enablement: "enabled",
    policy: "allowed",
    providerEligibility: {
      providerInstanceId,
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
    selectionMode: "explicit",
    taskKeywords: [],
    epoch: 1,
    invalidationFacts: [],
  };
}

function fixture() {
  const skillEntry: CapabilityCatalogEntry = {
    ...entry({
      id: skillCapabilityId,
      componentId: "review",
      kind: "plugin-instruction",
    }),
    source: {
      kind: "agents-skills-directory",
      referenceId: skillId,
      packageId: "project~skills",
      componentId: "review",
    },
    componentKind: "skill-instruction",
  };
  const entries = [
    entry({ id: instructionCapabilityId, componentId: "instructions", kind: "plugin-instruction" }),
    entry({ id: toolCapabilityId, componentId: "server", kind: "mcp-tool" }),
    entry({ id: unselectedCapabilityId, componentId: "unused", kind: "plugin-instruction" }),
    skillEntry,
  ];
  const capabilityCatalog: CapabilityCatalog = {
    entries,
    epoch: deriveCatalogEpoch({
      entries,
      activeFacts: { providerInstanceId, activeScope },
      invalidationFacts: [],
    }),
  };
  const addressingCatalog: ExtensionAddressingCatalog = {
    epoch: catalogEpoch as never,
    plugins: [
      {
        extensionId: extensionId as never,
        packageId: packageId as never,
        slug: "build-tools" as never,
        packageVersion: "1.2.3" as never,
        packageDigest: digest as never,
        primaryComponentId: "instructions" as never,
        components: [
          {
            componentId: "instructions" as never,
            label: "Build guidance",
            effectiveState: { kind: "effective" },
            capabilityIds: [instructionCapabilityId],
          },
          {
            componentId: "server" as never,
            label: "Build server",
            effectiveState: { kind: "effective" },
            capabilityIds: [toolCapabilityId],
          },
          {
            componentId: "unused" as never,
            label: "Unused guidance",
            effectiveState: { kind: "effective" },
            capabilityIds: [unselectedCapabilityId],
          },
        ],
      },
    ],
    skills: [
      {
        skillId: skillId as never,
        name: "review",
        label: "Project review",
        packageDigest: digest as never,
        effectiveState: { kind: "effective" },
        capabilityIds: [skillCapabilityId],
      },
    ],
  };
  const capabilityRequest: CapabilitySelectionRequest = {
    providerInstanceId,
    activeScope,
    nativeToolSearch: "unsupported",
    taskKeywords: [],
    explicitSelections: [],
  };
  return {
    addressingCatalog,
    authoritativeCatalogEpoch: catalogEpoch as never,
    capabilityCatalog,
    capabilityRequest,
  };
}

function replaceCapability(
  fixtureValue: ReturnType<typeof fixture>,
  replacement: CapabilityCatalogEntry,
): CapabilityCatalog {
  const entries = fixtureValue.capabilityCatalog.entries.map((candidate) =>
    candidate.id === replacement.id ? replacement : candidate,
  );
  return {
    entries,
    epoch: deriveCatalogEpoch({
      entries,
      activeFacts: { providerInstanceId, activeScope },
      invalidationFacts: [],
    }),
  };
}

function selected(reference: string, addressingCatalog: ExtensionAddressingCatalog) {
  const result = resolveDraftExtensionReference(reference, addressingCatalog, "draft-1");
  if (result.kind !== "selected") throw new Error(`Expected ${reference} to resolve`);
  return result.selection;
}

describe("extension zero-context composition", () => {
  it("loads prompt material only for the selected effective component on a non-Codex provider", async () => {
    const f = fixture();
    const loadMaterial = vi.fn(async (capability: CapabilityCatalogEntry) =>
      capability.id === instructionCapabilityId
        ? {
            context: {
              kind: "instructions" as const,
              text: "Use the selected build guidance.",
            },
            tools: [],
          }
        : { tools: [] },
    );

    const result = await composeSelectedExtensionCapabilities({
      phase: "send",
      selections: [selected("@build-tools", f.addressingCatalog)],
      ...f,
      loadMaterial,
    });

    expect(result).toMatchObject({
      status: "selected",
      providerContext: [{ kind: "instructions", text: "Use the selected build guidance." }],
      tools: [],
    });
    expect(result.contextEntries.map((contextEntry) => String(contextEntry.id))).toEqual([
      instructionCapabilityId,
    ]);
    expect(loadMaterial).toHaveBeenCalledTimes(1);
    expect(loadMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ id: instructionCapabilityId }),
    );
  });

  it("projects only the explicitly selected plugin MCP schema and never loads unselected material", async () => {
    const f = fixture();
    const loadMaterial = vi.fn(async (capability: CapabilityCatalogEntry) => ({
      tools:
        capability.id === toolCapabilityId
          ? [{ name: "build_project", inputSchema: { type: "object", properties: {} } }]
          : [],
    }));

    const result = await composeSelectedExtensionCapabilities({
      phase: "provider-handoff",
      selections: [selected("@build-tools/server", f.addressingCatalog)],
      ...f,
      loadMaterial,
    });

    expect(result.status).toBe("selected");
    expect(result.tools).toEqual([
      { name: "build_project", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(loadMaterial).toHaveBeenCalledTimes(1);
    expect(loadMaterial).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: unselectedCapabilityId }),
    );
  });

  it("fails closed before material loading when policy, epoch, or provider handoff changes", async () => {
    const f = fixture();
    const selection = selected("@build-tools", f.addressingCatalog);
    const loadMaterial = vi.fn();
    const changedCatalog: ExtensionAddressingCatalog = {
      ...f.addressingCatalog,
      epoch: otherCatalogEpoch as never,
    };
    const changedRequest: CapabilitySelectionRequest = {
      ...f.capabilityRequest,
      providerInstanceId: otherProviderInstanceId,
    };

    const result = await composeSelectedExtensionCapabilities({
      phase: "provider-handoff",
      selections: [selection],
      addressingCatalog: changedCatalog,
      authoritativeCatalogEpoch: otherCatalogEpoch as never,
      capabilityCatalog: f.capabilityCatalog,
      capabilityRequest: changedRequest,
      loadMaterial,
    });

    expect(result).toEqual({
      status: "blocked",
      reasons: ["stale-catalog-epoch"],
      contextEntries: [],
      providerContext: [],
      tools: [],
    });
    expect(loadMaterial).not.toHaveBeenCalled();
  });

  it("fails closed before material loading when addressing and authoritative epochs differ", async () => {
    const f = fixture();
    const loadMaterial = vi.fn();
    const result = await composeSelectedExtensionCapabilities({
      phase: "send",
      selections: [selected("@build-tools", f.addressingCatalog)],
      ...f,
      authoritativeCatalogEpoch: otherCatalogEpoch as never,
      loadMaterial,
    });

    expect(result).toEqual({
      status: "blocked",
      reasons: ["authoritative-catalog-epoch-mismatch"],
      contextEntries: [],
      providerContext: [],
      tools: [],
    });
    expect(loadMaterial).not.toHaveBeenCalled();
  });

  it("rejects cross-extension, core, and wrong skill-source capability mappings before loading", async () => {
    const f = fixture();
    const instructionEntry = f.capabilityCatalog.entries.find(
      (candidate) => candidate.id === instructionCapabilityId,
    )!;
    const toolEntry = f.capabilityCatalog.entries.find(
      (candidate) => candidate.id === toolCapabilityId,
    )!;
    const skillEntry = f.capabilityCatalog.entries.find(
      (candidate) => candidate.id === skillCapabilityId,
    )!;
    const attacks = [
      {
        reference: "@build-tools",
        capabilityId: instructionCapabilityId,
        replacement: {
          ...instructionEntry,
          source: {
            ...instructionEntry.source,
            kind: "plugin-package" as const,
            packageId: otherPackageId,
            referenceId: `extension:${otherExtensionId}:${otherPackageId}`,
          },
        },
      },
      {
        reference: "@build-tools",
        capabilityId: instructionCapabilityId,
        replacement: {
          ...instructionEntry,
          source: {
            ...instructionEntry.source,
            referenceId: `extension:${otherExtensionId}:${packageId}`,
          },
        },
      },
      {
        reference: "@build-tools/server",
        capabilityId: toolCapabilityId,
        replacement: {
          ...toolEntry,
          source: {
            kind: "octant-tool" as const,
            referenceId: "octant:core",
            componentId: "server",
          },
          componentKind: "octant-tool" as const,
        },
      },
      {
        reference: `$${skillId}`,
        capabilityId: skillCapabilityId,
        replacement: {
          ...skillEntry,
          source: {
            ...skillEntry.source,
            kind: "agents-skills-directory" as const,
            referenceId: `agents-skills-directory:global~skills:review:${digest}`,
            packageId: "global~skills",
          },
        },
      },
    ];

    for (const attack of attacks) {
      const loadMaterial = vi.fn();
      const result = await composeSelectedExtensionCapabilities({
        phase: "send",
        selections: [selected(attack.reference, f.addressingCatalog)],
        addressingCatalog: f.addressingCatalog,
        authoritativeCatalogEpoch: f.authoritativeCatalogEpoch,
        capabilityCatalog: replaceCapability(f, attack.replacement),
        capabilityRequest: f.capabilityRequest,
        loadMaterial,
      });

      expect(result).toEqual({
        status: "blocked",
        reasons: [`capability-provenance-mismatch:${attack.capabilityId}`],
        contextEntries: [],
        providerContext: [],
        tools: [],
      });
      expect(loadMaterial).not.toHaveBeenCalled();
    }
  });
});
