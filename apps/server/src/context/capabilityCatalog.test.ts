import { describe, expect, it } from "vitest";
import type {
  ContextRoutingEligibility,
  KnownTokenMeasurement,
  ProviderInstanceId,
  TokenMeasurement,
} from "@octant/contracts";
import {
  deriveCatalogEpoch,
  selectCapabilities,
  type CapabilityCatalog,
  type CapabilityCatalogEntry,
  type CapabilitySelectionRequest,
} from "./capabilityCatalog";

const providerA = "00000000-0000-4000-8000-000000000005" as ProviderInstanceId;
const otherProvider = "00000000-0000-4000-8000-000000000006" as ProviderInstanceId;
const activeScope = {
  mode: { referenceId: "mode:code", revision: 1 },
  project: { referenceId: "project:one", revision: 1 },
  host: { referenceId: "host:local", revision: 1 },
  model: { referenceId: "model:one", revision: 1 },
} as const;

function known(
  tokens: number,
  accuracy: KnownTokenMeasurement["accuracy"] = "exact-tokenizer",
): TokenMeasurement {
  return { kind: "known", tokens, accuracy };
}

function unknown(): TokenMeasurement {
  return { kind: "unknown", accuracy: "unknown" };
}

function eligible(): ContextRoutingEligibility {
  return {
    providerInstanceId: providerA,
    status: "eligible",
    reason: "selected-provider",
  };
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
    providerEligibility: eligible(),
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

function makeCatalog(
  entries: ReadonlyArray<CapabilityCatalogEntry>,
  options: { readonly value?: number; readonly facts?: CapabilityCatalog["epoch"]["facts"] } = {},
): CapabilityCatalog {
  const derived = deriveCatalogEpoch({
    entries,
    activeFacts: { providerInstanceId: providerA, activeScope },
    invalidationFacts: [],
  });
  return {
    entries,
    epoch: {
      ...derived,
      value: options.value ?? derived.value,
      facts: options.facts ?? derived.facts,
    },
  };
}

describe("selectCapabilities", () => {
  it("excludes disabled, untrusted, policy-denied, provider-ineligible, and provider-mismatched components with zero cost", () => {
    const catalog = makeCatalog([
      baseEntry({
        id: "disabled",
        componentKind: "octant-tool",
        posture: "essential",
        enablement: "disabled",
      }),
      baseEntry({
        id: "untrusted",
        componentKind: "mcp-tool",
        trust: "untrusted",
      }),
      baseEntry({
        id: "denied",
        componentKind: "skill-instruction",
        policy: "denied",
      }),
      baseEntry({
        id: "ineligible",
        componentKind: "mcp-prompt",
        providerEligibility: {
          providerInstanceId: providerA,
          status: "ineligible",
          reason: "source-disabled",
        },
      }),
      baseEntry({
        id: "mismatch",
        componentKind: "plugin-instruction",
        providerEligibility: {
          providerInstanceId: otherProvider,
          status: "eligible",
          reason: "selected-provider",
        },
      }),
    ]);

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "supported",
      taskKeywords: [],
      explicitSelections: [],
    };

    const result = selectCapabilities(catalog, request);

    expect(result.selected).toHaveLength(0);
    expect(result.totalCost).toEqual({
      kind: "known",
      tokens: 0,
      accuracy: "exact-tokenizer",
    });
    expect(result.omitted.map((o) => o.id)).toEqual([
      "disabled",
      "untrusted",
      "denied",
      "ineligible",
      "mismatch",
    ]);
  });

  it("selects essential capabilities and a bounded task-specific bundle when native tool search is unsupported", () => {
    const essential = baseEntry({
      id: "essential-1",
      componentKind: "octant-tool",
      posture: "essential",
      selectionMode: "automatic",
      taskKeywords: ["file"],
      schemaCost: known(200),
    });
    const optRead = baseEntry({
      id: "opt-read",
      componentKind: "octant-tool",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["read", "file"],
      schemaCost: known(150),
    });
    const optSearch = baseEntry({
      id: "opt-search",
      componentKind: "mcp-tool",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["search"],
      schemaCost: known(120),
    });
    const optList = baseEntry({
      id: "opt-list",
      componentKind: "octant-tool",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["file", "list"],
      schemaCost: known(80),
    });

    const catalog = makeCatalog([optSearch, optList, essential, optRead], { value: 2 });

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: ["file"],
      explicitSelections: [],
      maxOptionalTaskSpecific: 2,
      maxTotalSelected: 10,
    };

    const result = selectCapabilities(catalog, request);

    expect(result.nativeToolSearch).toBe("unsupported");
    expect(result.selectionStrategy).toBe("task-specific-bundle");
    expect(result.selected.map((s) => s.id)).toEqual([essential.id, "opt-list", "opt-read"]);
    expect(result.totalCost).toEqual({
      kind: "known",
      tokens: 200 + 80 + 150,
      accuracy: "exact-tokenizer",
    });
    expect(
      result.omitted.some((o) => o.id === "opt-search" && o.reason === "no-task-relevance"),
    ).toBe(true);
  });

  it("honestly reports supported native tool search and defers non-explicit optional schemas", () => {
    const essential = baseEntry({
      id: "e1",
      componentKind: "octant-tool",
      posture: "essential",
      selectionMode: "automatic",
      taskKeywords: [],
    });
    const opt1 = baseEntry({
      id: "o1",
      componentKind: "mcp-tool",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["search"],
    });
    const opt2 = baseEntry({
      id: "o2",
      componentKind: "octant-tool",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["file"],
    });

    const catalog = makeCatalog([opt2, opt1, essential]);

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "supported",
      taskKeywords: ["file"],
      explicitSelections: [],
    };

    const result = selectCapabilities(catalog, request);

    expect(result.nativeToolSearch).toBe("supported");
    expect(result.selectionStrategy).toBe("native-search");
    expect(result.selected.map((s) => s.id)).toEqual([essential.id]);
    expect(result.loadedSchemaIds).toEqual([essential.id]);
    expect(result.omitted).toEqual([
      { id: opt2.id, reason: "native-search-deferred" },
      { id: opt1.id, reason: "native-search-deferred" },
    ]);
  });

  it("uses native search only for searchable tools and still selects bounded relevant instructions", () => {
    const pluginInstruction = baseEntry({
      id: "plugin-instruction",
      componentKind: "plugin-instruction",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["review"],
    });
    const skillInstruction = baseEntry({
      id: "skill-instruction",
      componentKind: "skill-instruction",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["review"],
    });
    const searchableTool = baseEntry({
      id: "searchable-tool",
      componentKind: "mcp-tool",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["review"],
    });

    const result = selectCapabilities(
      makeCatalog([searchableTool, skillInstruction, pluginInstruction]),
      {
        providerInstanceId: providerA,
        activeScope,
        nativeToolSearch: "supported",
        taskKeywords: ["review"],
        explicitSelections: [],
        maxOptionalTaskSpecific: 1,
      },
    );

    expect(result.selected.map((entry) => entry.id)).toEqual(["skill-instruction"]);
    expect(result.omitted).toContainEqual({
      id: "searchable-tool",
      reason: "native-search-deferred",
    });
    expect(result.omitted).toContainEqual({
      id: "plugin-instruction",
      reason: "optional-limit-reached",
    });
  });

  it("fails closed for unavailable and ambiguous mode, Project, or host eligibility", () => {
    const catalog = makeCatalog([
      baseEntry({ id: "unavailable", availability: "unavailable", posture: "essential" }),
      baseEntry({
        id: "mode-unknown",
        posture: "essential",
        scopeEligibility: {
          mode: { ...activeScope.mode, status: "unknown" },
          project: { ...activeScope.project, status: "eligible" },
          host: { ...activeScope.host, status: "eligible" },
          model: { ...activeScope.model, status: "eligible" },
        },
      }),
      baseEntry({
        id: "project-ineligible",
        posture: "essential",
        scopeEligibility: {
          mode: { ...activeScope.mode, status: "eligible" },
          project: { ...activeScope.project, status: "ineligible" },
          host: { ...activeScope.host, status: "eligible" },
          model: { ...activeScope.model, status: "eligible" },
        },
      }),
      baseEntry({
        id: "host-unknown",
        posture: "essential",
        scopeEligibility: {
          mode: { ...activeScope.mode, status: "eligible" },
          project: { ...activeScope.project, status: "eligible" },
          host: { ...activeScope.host, status: "unknown" },
          model: { ...activeScope.model, status: "eligible" },
        },
      }),
    ]);

    const result = selectCapabilities(catalog, {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    });

    expect(result.selected).toEqual([]);
    expect(result.totalCost).toEqual({
      kind: "known",
      tokens: 0,
      accuracy: "exact-tokenizer",
    });
    expect(result.omitted).toEqual([
      { id: "unavailable", reason: "unavailable" },
      { id: "mode-unknown", reason: "mode-ambiguous" },
      { id: "project-ineligible", reason: "project-ineligible" },
      { id: "host-unknown", reason: "host-ambiguous" },
    ]);
  });

  it("fails closed when catalog scope identities or revisions do not match the active turn", () => {
    const requestScope = {
      mode: { referenceId: "mode:code", revision: 4 },
      project: { referenceId: "project:one", revision: 8 },
      host: { referenceId: "host:local", revision: 3 },
      model: { referenceId: "model:one", revision: 2 },
    } as const;
    const entry = baseEntry({
      id: "stale-scope",
      posture: "essential",
      selectionMode: "automatic",
      scopeEligibility: {
        mode: { referenceId: "mode:chat", revision: 4, status: "eligible" },
        project: { referenceId: "project:one", revision: 8, status: "eligible" },
        host: { referenceId: "host:local", revision: 3, status: "eligible" },
        model: { referenceId: "model:one", revision: 2, status: "eligible" },
      },
    } as unknown as Partial<CapabilityCatalogEntry>);

    const result = selectCapabilities(
      {
        entries: [entry],
        epoch: deriveCatalogEpoch({
          entries: [entry],
          activeFacts: { providerInstanceId: providerA, activeScope: requestScope },
          invalidationFacts: [],
        }),
      },
      {
        providerInstanceId: providerA,
        nativeToolSearch: "unsupported",
        taskKeywords: [],
        explicitSelections: [],
        activeScope: requestScope,
      } as unknown as CapabilitySelectionRequest,
    );

    expect(result.selected).toEqual([]);
    expect(result.omitted).toContainEqual({ id: "stale-scope", reason: "mode-scope-mismatch" });
  });

  it("blocks empty or invalid scope identities even when catalog and request match", () => {
    const invalidScope = {
      ...activeScope,
      project: { referenceId: "", revision: -1 },
    } as const;
    const entry = baseEntry({
      id: "invalid-scope",
      scopeEligibility: {
        mode: { ...invalidScope.mode, status: "eligible" },
        project: { ...invalidScope.project, status: "eligible" },
        host: { ...invalidScope.host, status: "eligible" },
        model: { ...invalidScope.model, status: "eligible" },
      },
    });
    const catalog: CapabilityCatalog = {
      entries: [entry],
      epoch: deriveCatalogEpoch({
        entries: [entry],
        activeFacts: { providerInstanceId: providerA, activeScope: invalidScope },
        invalidationFacts: [],
      }),
    };

    const result = selectCapabilities(catalog, {
      providerInstanceId: providerA,
      activeScope: invalidScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReasons).toContain("invalid-active-scope:project");
  });

  it("requires explicit selection for MCP prompts, resources, and .agents/ skill instructions", () => {
    const prompt = baseEntry({
      id: "prompt-1",
      componentKind: "mcp-prompt",
      selectionMode: "explicit",
      posture: "optional",
      taskKeywords: [],
    });
    const resource = baseEntry({
      id: "resource-1",
      componentKind: "mcp-resource",
      selectionMode: "explicit",
      posture: "optional",
      taskKeywords: [],
    });
    const skill = baseEntry({
      id: "skill-1",
      componentKind: "skill-instruction",
      selectionMode: "explicit",
      source: {
        kind: "agents-skills-directory",
        referenceId: ".agents/skills/my-skill/SKILL.md",
        packageId: "my-skill",
        componentId: "instructions",
      },
      posture: "optional",
      taskKeywords: [],
    });

    const catalog = makeCatalog([prompt, resource, skill]);

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: ["prompt-1", "skill-1"],
    };

    const result = selectCapabilities(catalog, request);

    expect(result.selected.map((s) => s.id)).toEqual(["skill-1", "prompt-1"]);
    expect(
      result.omitted.some(
        (o) => o.id === "resource-1" && o.reason === "explicit-selection-required",
      ),
    ).toBe(true);
  });

  it("orders selected capabilities deterministically by posture, component kind, and stable id", () => {
    const entries = [
      baseEntry({
        id: "z-optional-octant",
        componentKind: "octant-tool",
        posture: "optional",
        selectionMode: "task-specific",
        taskKeywords: ["x"],
      }),
      baseEntry({
        id: "a-optional-mcp",
        componentKind: "mcp-tool",
        posture: "optional",
        selectionMode: "task-specific",
        taskKeywords: ["x"],
      }),
      baseEntry({
        id: "b-essential-octant",
        componentKind: "octant-tool",
        posture: "essential",
        selectionMode: "automatic",
        taskKeywords: [],
      }),
      baseEntry({
        id: "y-optional-skill",
        componentKind: "skill-instruction",
        posture: "optional",
        selectionMode: "task-specific",
        taskKeywords: ["x"],
      }),
    ];

    const catalog = makeCatalog(entries);

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: ["x"],
      explicitSelections: [],
    };

    const result = selectCapabilities(catalog, request);

    expect(result.selected.map((s) => s.id)).toEqual([
      "b-essential-octant",
      "z-optional-octant",
      "a-optional-mcp",
      "y-optional-skill",
    ]);
  });

  it("aggregates schema cost as unknown when any selected capability has unknown cost", () => {
    const essential = baseEntry({
      id: "e1",
      posture: "essential",
      selectionMode: "automatic",
      schemaCost: known(100),
    });
    const optUnknown = baseEntry({
      id: "o1",
      posture: "optional",
      selectionMode: "task-specific",
      taskKeywords: ["x"],
      schemaCost: unknown(),
    });

    const catalog = makeCatalog([optUnknown, essential]);

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: ["x"],
      explicitSelections: [],
    };

    const result = selectCapabilities(catalog, request);

    expect(result.totalCost).toEqual({ kind: "unknown", accuracy: "unknown" });
  });

  it("carries catalog epoch and invalidation facts through selection", () => {
    const fact = { kind: "tools/list-changed" } as const;
    const entry = baseEntry({
      id: "e1",
      posture: "essential",
      selectionMode: "automatic",
      epoch: 3,
      invalidationFacts: [fact],
    });

    const catalog = makeCatalog([entry], {
      value: 5,
      facts: [
        { kind: "provider-changed", providerInstanceId: otherProvider },
        { kind: "trust-changed", sourceId: "skill-a" },
      ],
    });

    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "supported",
      taskKeywords: [],
      explicitSelections: [],
    };

    const result = selectCapabilities(catalog, request);

    expect(result.epoch.value).toBe(5);
    expect(result.epoch.facts).toEqual([
      { kind: "provider-changed", providerInstanceId: otherProvider },
      { kind: "trust-changed", sourceId: "skill-a" },
    ]);
    expect(result.selected[0]?.epoch).toBe(3);
    expect(result.selected[0]?.invalidationFacts).toEqual([fact]);
  });

  it("blocks a catalog whose entries changed without deriving the next epoch", () => {
    const entry = baseEntry({ id: "epoch-guard", posture: "essential" });
    const catalog = makeCatalog([entry]);
    const staleCatalog: CapabilityCatalog = {
      epoch: catalog.epoch,
      entries: [{ ...entry, trust: "untrusted" }],
    };

    const result = selectCapabilities(staleCatalog, {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReasons).toEqual(["stale-catalog-epoch"]);
  });

  it("blocks epoch active facts that do not describe the selection request", () => {
    const entry = baseEntry({ id: "epoch-active-facts-guard", posture: "essential" });
    const catalog = makeCatalog([entry]);
    const inconsistentCatalog: CapabilityCatalog = {
      entries: catalog.entries,
      epoch: {
        ...catalog.epoch,
        activeFacts: {
          ...catalog.epoch.activeFacts,
          activeScope: {
            ...catalog.epoch.activeFacts.activeScope,
            model: { referenceId: "model:other", revision: 2 },
          },
        },
      },
    };

    const result = selectCapabilities(inconsistentCatalog, {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReasons).toEqual(["stale-catalog-epoch"]);
  });

  it("blocks non-finite or above-ceiling selection limits instead of loading an unbounded catalog", () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      baseEntry({
        id: `optional-${index}`,
        taskKeywords: ["context"],
      }),
    );

    const result = selectCapabilities(makeCatalog(entries), {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: ["context"],
      explicitSelections: [],
      maxOptionalTaskSpecific: Number.POSITIVE_INFINITY,
      maxTotalSelected: Number.POSITIVE_INFINITY,
    });

    expect(result.status).toBe("blocked");
    expect(result.selected).toEqual([]);
    expect(result.blockedReasons).toContain("invalid-selection-limit");
  });

  it("blocks when the essential bundle exceeds its bounded limit", () => {
    const entries = ["essential-a", "essential-b"].map((id) =>
      baseEntry({ id, posture: "essential", selectionMode: "automatic" }),
    );

    const result = selectCapabilities(makeCatalog(entries), {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
      maxEssential: 1,
    });

    expect(result.status).toBe("blocked");
    expect(result.selected).toEqual([]);
    expect(result.blockedReasons).toContain("essential-bundle-overflow");
  });

  it("blocks instead of silently dropping eligible explicit selections at the total limit", () => {
    const entries = ["prompt-a", "prompt-b"].map((id) =>
      baseEntry({
        id,
        componentKind: "mcp-prompt",
        posture: "optional",
        selectionMode: "explicit",
      }),
    );

    const result = selectCapabilities(makeCatalog(entries), {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: entries.map((entry) => entry.id),
      maxTotalSelected: 1,
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReasons).toEqual(["explicit-selection-overflow"]);
  });

  it("blocks duplicate ids and contradictory source/component attribution", () => {
    const duplicate = baseEntry({ id: "duplicate" });
    const result = selectCapabilities(
      makeCatalog([
        duplicate,
        duplicate,
        baseEntry({
          id: "contradictory",
          source: { kind: "octant-tool", referenceId: "tool-1", componentId: "tool-1" },
          componentKind: "plugin-instruction",
        }),
      ]),
      {
        providerInstanceId: providerA,
        activeScope,
        nativeToolSearch: "unsupported",
        taskKeywords: [],
        explicitSelections: [],
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.blockedReasons).toEqual([
      "duplicate-capability-id:duplicate",
      "invalid-source-component:contradictory",
    ]);
  });

  it("blocks entries without auditable source and component identities", () => {
    const entry = baseEntry({
      id: "missing-component-identity",
      source: {
        kind: "octant-tool",
        referenceId: "tool-source",
      } as unknown as CapabilityCatalogEntry["source"],
    });
    const catalog = makeCatalog([entry]);

    const result = selectCapabilities(catalog, {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReasons).toEqual(["invalid-source-identity:missing-component-identity"]);
  });

  it("uses locale-independent code-point ordering", () => {
    const result = selectCapabilities(
      makeCatalog([
        baseEntry({ id: "a-entry", posture: "essential", selectionMode: "automatic" }),
        baseEntry({ id: "Z-entry", posture: "essential", selectionMode: "automatic" }),
      ]),
      {
        providerInstanceId: providerA,
        activeScope,
        nativeToolSearch: "unsupported",
        taskKeywords: [],
        explicitSelections: [],
      },
    );

    expect(result.selected.map((entry) => entry.id)).toEqual(["Z-entry", "a-entry"]);

    const unicodeResult = selectCapabilities(
      makeCatalog([
        baseEntry({ id: "\u{10000}-entry", posture: "essential", selectionMode: "automatic" }),
        baseEntry({ id: "\uE000-entry", posture: "essential", selectionMode: "automatic" }),
      ]),
      {
        providerInstanceId: providerA,
        activeScope,
        nativeToolSearch: "unsupported",
        taskKeywords: [],
        explicitSelections: [],
      },
    );
    expect(unicodeResult.selected.map((entry) => entry.id)).toEqual([
      "\uE000-entry",
      "\u{10000}-entry",
    ]);
  });

  it("blocks malformed runtime catalog values without throwing or undercounting", () => {
    const negativeCost = baseEntry({
      id: "negative-cost",
      schemaCost: {
        kind: "known",
        tokens: -10,
        accuracy: "exact-tokenizer",
      } as TokenMeasurement,
    });
    const invalidPosture = baseEntry({
      id: "invalid-posture",
      posture: "required" as CapabilityCatalogEntry["posture"],
    });
    const invalidSource = baseEntry({
      id: "invalid-source",
      source: {
        kind: "remote-marketplace",
        referenceId: "source",
        componentId: "component",
      } as unknown as CapabilityCatalogEntry["source"],
    });
    const malformedFactCatalog = makeCatalog([baseEntry({ id: "invalid-fact" })]);
    const catalog = {
      entries: [negativeCost, invalidPosture, invalidSource],
      epoch: {
        ...malformedFactCatalog.epoch,
        facts: [{ kind: "surprise-invalid" }],
      },
    } as unknown as CapabilityCatalog;
    const request: CapabilitySelectionRequest = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    };

    let result: ReturnType<typeof selectCapabilities> | undefined;
    expect(() => {
      result = selectCapabilities(catalog, request);
    }).not.toThrow();
    expect(result?.status).toBe("blocked");
    expect(result?.blockedReasons).toEqual(
      expect.arrayContaining([
        "invalid-schema-cost:negative-cost",
        "invalid-posture:invalid-posture",
        "invalid-source-kind:invalid-source",
        "invalid-epoch-fact:0",
      ]),
    );
  });

  it("blocks malformed runtime request enums and arrays without throwing", () => {
    const catalog = makeCatalog([baseEntry({ id: "valid-entry" })]);
    const request = {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "surprise-search",
      taskKeywords: [42],
      explicitSelections: [null],
    } as unknown as CapabilitySelectionRequest;

    let result: ReturnType<typeof selectCapabilities> | undefined;
    expect(() => {
      result = selectCapabilities(catalog, request);
    }).not.toThrow();
    expect(result?.status).toBe("blocked");
    expect(result?.blockedReasons).toEqual(
      expect.arrayContaining([
        "invalid-native-tool-search",
        "invalid-task-keyword:0",
        "invalid-explicit-selection:0",
      ]),
    );
  });

  it("blocks checked schema-cost addition when selected totals exceed safe integers", () => {
    const entries = ["cost-a", "cost-b"].map((id) =>
      baseEntry({
        id,
        posture: "essential",
        selectionMode: "automatic",
        schemaCost: known(Number.MAX_SAFE_INTEGER),
      }),
    );
    const result = selectCapabilities(makeCatalog(entries), {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReasons).toEqual(["schema-cost-overflow"]);
    expect(result.totalCost).toEqual({
      kind: "known",
      tokens: 0,
      accuracy: "exact-tokenizer",
    });
  });

  it("allows essential posture only for Octant-owned Octant tools", () => {
    const entries = [
      baseEntry({ id: "mcp-essential", componentKind: "mcp-tool", posture: "essential" }),
      baseEntry({
        id: "plugin-essential",
        componentKind: "plugin-instruction",
        posture: "essential",
      }),
      baseEntry({
        id: "skill-essential",
        componentKind: "skill-instruction",
        posture: "essential",
      }),
    ];
    const result = selectCapabilities(makeCatalog(entries), {
      providerInstanceId: providerA,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedReasons).toEqual([
      "invalid-essential-posture:mcp-essential",
      "invalid-essential-posture:plugin-essential",
      "invalid-essential-posture:skill-essential",
    ]);
  });
});

describe("deriveCatalogEpoch", () => {
  it("keeps a stable fingerprint/value and increments deterministically for active fact changes", () => {
    const entry = baseEntry({ id: "epoch-entry" });
    const first = deriveCatalogEpoch({
      entries: [entry],
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [],
    });
    const unchanged = deriveCatalogEpoch({
      previous: first,
      entries: [entry],
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [],
    });
    const modelChanged = deriveCatalogEpoch({
      previous: unchanged,
      entries: [entry],
      activeFacts: {
        providerInstanceId: providerA,
        activeScope: {
          ...activeScope,
          model: { referenceId: "model:two", revision: 2 },
        },
      },
      invalidationFacts: [],
    });

    expect(first.value).toBe(1);
    expect(unchanged).toEqual(first);
    expect(modelChanged.value).toBe(2);
    expect(modelChanged.fingerprint).not.toBe(first.fingerprint);
    expect(modelChanged.facts).toContainEqual({ kind: "model-changed", modelId: "model:two" });
  });

  it("fingerprints entry facts independent of catalog input order and records source invalidation", () => {
    const firstEntry = baseEntry({ id: "a-entry" });
    const secondEntry = baseEntry({ id: "b-entry" });
    const initial = deriveCatalogEpoch({
      entries: [secondEntry, firstEntry],
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [],
    });
    const reordered = deriveCatalogEpoch({
      previous: initial,
      entries: [firstEntry, secondEntry],
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [],
    });
    const disabled = deriveCatalogEpoch({
      previous: reordered,
      entries: [firstEntry, { ...secondEntry, enablement: "disabled" }],
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [{ kind: "enablement-changed", sourceId: "b-entry" }],
    });

    expect(reordered).toEqual(initial);
    expect(disabled.value).toBe(2);
    expect(disabled.facts).toEqual([{ kind: "enablement-changed", sourceId: "b-entry" }]);
  });

  it("advances for each explicit invalidation even when the catalog fingerprint is unchanged", () => {
    const entry = baseEntry({ id: "stable-entry" });
    const initial = deriveCatalogEpoch({
      entries: [entry],
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [],
    });
    const toolsChanged = deriveCatalogEpoch({
      previous: initial,
      entries: [entry],
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [{ kind: "tools/list-changed" }],
    });
    const refreshed = deriveCatalogEpoch({
      previous: toolsChanged,
      entries: [entry],
      activeFacts: { providerInstanceId: providerA, activeScope },
      invalidationFacts: [{ kind: "explicit-refresh" }],
    });

    expect(toolsChanged.value).toBe(initial.value + 1);
    expect(toolsChanged.fingerprint).toBe(initial.fingerprint);
    expect(toolsChanged.facts).toEqual([{ kind: "tools/list-changed" }]);
    expect(refreshed.value).toBe(toolsChanged.value + 1);
    expect(refreshed.facts).toEqual([{ kind: "explicit-refresh" }]);
  });
});
