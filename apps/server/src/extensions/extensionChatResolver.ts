import { createHash } from "node:crypto";
import type {
  ChatThread,
  ProviderContextBlock,
  ProviderToolDefinition,
  WindowId,
} from "@octant/contracts";
import type {
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import type {
  ExtensionComponent,
  ExtensionEffectiveState,
  ExtensionProviderFamily,
  SourceQualifiedSkillId,
} from "@octant/contracts/extensions";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  filterSkillCatalogForScope,
  sourceQualifiedSkillId,
  type ExtensionAddressingCatalog,
} from "@octant/plugin-host";
import type { ChatExtensionSelectionContextResolver } from "../chat/chatService";
import { ChatServiceError } from "../chat/chatService";
import type { AppManagedToolSet } from "../chat/chatTurnRunner";
import {
  deriveCatalogEpoch,
  type CapabilityActiveScope,
  type CapabilityCatalog,
  type CapabilityCatalogEntry,
  type CapabilityComponentKind,
  type CapabilitySelectionRequest,
} from "../context/capabilityCatalog";
import type { ExtensionPackageStore } from "./extensionPackageStore";
import { composeSelectedExtensionCapabilities } from "./extensionAddressingService";

export interface ExtensionMaterialLoaderPort {
  load(input: {
    readonly entry: CapabilityCatalogEntry;
    readonly effectiveSnapshot: ExtensionEffectiveSnapshot;
  }): Promise<{
    readonly context?: ProviderContextBlock;
    readonly tools: ReadonlyArray<ProviderToolDefinition>;
  }>;
}

export interface ExtensionToolExecutionPort {
  availability(input: {
    readonly thread: ChatThread;
    readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  }): "available" | "unavailable" | "waiting";
  execute(input: {
    readonly windowId?: WindowId;
    readonly thread: ChatThread;
    readonly name: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly result: unknown; readonly isError?: boolean }>;
}

export const UNAVAILABLE_EXTENSION_TOOL_EXECUTION: ExtensionToolExecutionPort = {
  availability: () => "unavailable",
  execute: async () => ({ result: { error: "extension-tool-unavailable" }, isError: true }),
};

export function createStoredExtensionMaterialLoader(
  store: Pick<ExtensionPackageStore, "readVerifiedComponentText">,
  options: {
    readonly mcpToolsForComponent?: (input: {
      readonly packageId: string;
      readonly componentId: string;
      readonly scope: ExtensionEffectiveSnapshot["scope"];
    }) => ReadonlyArray<ProviderToolDefinition>;
  } = {},
): ExtensionMaterialLoaderPort {
  return {
    async load({ entry, effectiveSnapshot }) {
      const source = entry.source;
      if (source.kind !== "plugin-package") {
        throw new Error("Extension material source is unavailable.");
      }
      const packageState = effectiveSnapshot.packages.find(
        (candidate) => String(candidate.packageId) === source.packageId,
      );
      if (packageState === undefined) throw new Error("Extension package is unavailable.");
      const componentState = packageState.components.find(
        (candidate) => candidate.component.id === source.componentId,
      );
      if (componentState === undefined) {
        throw new Error("Extension component material is unavailable.");
      }
      if (componentState.component.kind === "mcp-server") {
        const tools =
          options.mcpToolsForComponent?.({
            packageId: source.packageId,
            componentId: source.componentId,
            scope: effectiveSnapshot.scope,
          }) ?? [];
        if (tools.length === 0) {
          throw new Error("Selected MCP component exposes no provider-compatible tools.");
        }
        return { tools };
      }
      if (componentState.component.kind !== "skill-instructions") {
        throw new Error("Extension component material is unavailable.");
      }
      const text = await store.readVerifiedComponentText(
        {
          extensionId: packageState.extensionId,
          packageId: packageState.packageId,
          version: packageState.version,
          digest: packageState.digest,
        },
        source.componentId,
      );
      return { context: { kind: "instructions", text }, tools: [] };
    },
  };
}

export function createExtensionChatResolver(options: {
  readonly snapshot: () => ExtensionSnapshot;
  readonly resolveEffectiveState: (
    snapshot: ExtensionSnapshot,
    query: ExtensionEffectiveStateQuery,
  ) => ExtensionEffectiveSnapshot;
  readonly reconcileEffectiveState?: (
    snapshot: ExtensionEffectiveSnapshot,
  ) => Promise<ExtensionEffectiveSnapshot | void>;
  readonly providerFamily: (thread: ChatThread) => ExtensionProviderFamily;
  readonly materialLoader: ExtensionMaterialLoaderPort;
  readonly toolExecution: ExtensionToolExecutionPort;
}): ChatExtensionSelectionContextResolver {
  return async ({ phase, thread, selections, windowId }) => {
    const snapshot = options.snapshot();
    const scope: ExtensionEffectiveStateQuery["scope"] = {
      hostId: LOCAL_HOST_ID,
      mode: "chat",
      projectId: thread.projectId ?? null,
      threadId: thread.id,
      providerFamily: options.providerFamily(thread),
    };
    let effectiveSnapshot = options.resolveEffectiveState(snapshot, { scope });
    const reconciled = await options.reconcileEffectiveState?.(effectiveSnapshot);
    if (reconciled !== undefined) effectiveSnapshot = reconciled;
    const catalogs = buildCatalogs(snapshot, effectiveSnapshot, thread);
    const composed = await composeSelectedExtensionCapabilities({
      phase,
      selections,
      addressingCatalog: catalogs.addressing,
      authoritativeCatalogEpoch: effectiveSnapshot.catalogEpoch,
      capabilityCatalog: catalogs.capabilities,
      capabilityRequest: catalogs.request,
      loadMaterial: (entry) => options.materialLoader.load({ entry, effectiveSnapshot }),
    });
    if (composed.status === "blocked") {
      throw new ChatServiceError({
        category: "unavailable",
        message: `Selected extension is unavailable (${composed.reasons.join(", ")}).`,
      });
    }
    const toolSet = extensionToolSet(options.toolExecution, thread, composed.tools, windowId);
    return {
      selections,
      entries: composed.contextBindings,
      ...(toolSet === undefined ? {} : { toolSet }),
    };
  };
}

function extensionToolSet(
  execution: ExtensionToolExecutionPort,
  thread: ChatThread,
  definitions: ReadonlyArray<ProviderToolDefinition>,
  windowId?: WindowId,
): AppManagedToolSet | undefined {
  if (definitions.length === 0) return undefined;
  const availability = execution.availability({ thread, definitions });
  if (availability !== "available") {
    throw new ChatServiceError({
      category: availability,
      message: "Selected extension tools are not available for execution.",
    });
  }
  const selectedNames = new Set(definitions.map((definition) => definition.name));
  return {
    definitions,
    execute: (input) =>
      selectedNames.has(input.name)
        ? execution.execute({ thread, ...input, ...(windowId === undefined ? {} : { windowId }) })
        : Promise.resolve({
            result: { error: "extension-tool-not-selected" },
            isError: true,
          }),
  };
}

function buildCatalogs(
  snapshot: ExtensionSnapshot,
  effectiveSnapshot: ExtensionEffectiveSnapshot,
  thread: ChatThread,
): {
  readonly addressing: ExtensionAddressingCatalog;
  readonly capabilities: CapabilityCatalog;
  readonly request: CapabilitySelectionRequest;
} {
  const activeScope: CapabilityActiveScope = {
    mode: { referenceId: "mode:chat", revision: 1 },
    project: {
      referenceId: thread.projectId === undefined ? "project:none" : `project:${thread.projectId}`,
      revision: Number(thread.version),
    },
    host: { referenceId: `host:${LOCAL_HOST_ID}`, revision: 1 },
    model: { referenceId: `model:${thread.modelId}`, revision: 1 },
  };
  const entries: CapabilityCatalogEntry[] = [];
  const plugins = effectiveSnapshot.packages.flatMap((packageState) => {
    if (packageState.slug === undefined) return [];
    return [
      {
        extensionId: packageState.extensionId,
        packageId: packageState.packageId,
        slug: packageState.slug,
        packageVersion: packageState.version,
        packageDigest: packageState.digest,
        ...(packageState.components.length === 1
          ? { primaryComponentId: packageState.components[0]!.component.id }
          : {}),
        components: packageState.components.map((componentState) => {
          const componentKind = capabilityKind(componentState.component);
          const capabilityIds =
            componentKind === undefined
              ? []
              : [
                  addCapability(entries, {
                    id: contextEntryId(
                      `plugin:${packageState.packageId}:${componentState.component.id}`,
                    ),
                    referenceId: `extension:${packageState.extensionId}:${packageState.packageId}`,
                    packageId: String(packageState.packageId),
                    component: componentState.component,
                    componentKind,
                    label: componentState.component.displayName,
                    providerInstanceId: thread.providerInstanceId,
                    activeScope,
                  }),
                ];
          return {
            componentId: componentState.component.id,
            label: componentState.component.displayName,
            effectiveState: componentState.effectiveState,
            capabilityIds,
          };
        }),
      },
    ];
  });
  const installedSkills = new Map<
    SourceQualifiedSkillId,
    {
      readonly packageState: ExtensionEffectiveSnapshot["packages"][number];
      readonly component: ExtensionEffectiveSnapshot["packages"][number]["components"][number];
    }
  >();
  for (const packageState of effectiveSnapshot.packages) {
    for (const component of packageState.components) {
      if (component.component.kind !== "skill-instructions") continue;
      installedSkills.set(
        sourceQualifiedSkillId(packageState.source, component.component.id, packageState.digest),
        { packageState, component },
      );
    }
  }
  const scopedSkills = filterSkillCatalogForScope(
    { skills: snapshot.skills ?? [], collisions: snapshot.collisions },
    {
      mode: "chat",
      projectId: thread.projectId === undefined ? null : String(thread.projectId),
      threadRef: String(thread.id),
    },
  ).skills;
  const skills = scopedSkills.map((skill) => {
    const installed = installedSkills.get(skill.skill.qualifiedId);
    const effectiveState: ExtensionEffectiveState =
      installed?.component.effectiveState ?? skill.effectiveState;
    const capabilityIds =
      installed === undefined
        ? []
        : [
            addCapability(entries, {
              id: contextEntryId(`skill:${skill.skill.qualifiedId}`),
              referenceId: String(skill.skill.qualifiedId),
              packageId: String(installed.packageState.packageId),
              component: installed.component.component,
              componentKind: "plugin-instruction",
              label: skill.displayName,
              providerInstanceId: thread.providerInstanceId,
              activeScope,
            }),
          ];
    return {
      skillId: skill.skill.qualifiedId,
      name: skill.skill.name,
      label: skill.displayName,
      ...(skill.version === undefined ? {} : { packageVersion: skill.version }),
      packageDigest: skill.skill.digest,
      effectiveState,
      capabilityIds,
    };
  });
  const capabilities: CapabilityCatalog = {
    entries,
    epoch: deriveCatalogEpoch({
      entries,
      activeFacts: { providerInstanceId: thread.providerInstanceId, activeScope },
      invalidationFacts: [],
    }),
  };
  return {
    addressing: { epoch: effectiveSnapshot.catalogEpoch, plugins, skills },
    capabilities,
    request: {
      providerInstanceId: thread.providerInstanceId,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    },
  };
}

function capabilityKind(component: ExtensionComponent): CapabilityComponentKind | undefined {
  switch (component.kind) {
    case "skill-instructions":
      return "plugin-instruction";
    case "mcp-server":
      return "mcp-tool";
    case "mcp-tool":
    case "mcp-prompt":
    case "mcp-resource":
      return component.kind;
    default:
      return undefined;
  }
}

function addCapability(
  entries: CapabilityCatalogEntry[],
  input: {
    readonly id: string;
    readonly referenceId: string;
    readonly packageId: string;
    readonly component: ExtensionComponent;
    readonly componentKind: CapabilityComponentKind;
    readonly label: string;
    readonly providerInstanceId: ChatThread["providerInstanceId"];
    readonly activeScope: CapabilityActiveScope;
  },
): string {
  entries.push({
    id: input.id,
    source: {
      kind: "plugin-package",
      referenceId: input.referenceId,
      packageId: input.packageId,
      componentId: input.component.id,
    },
    componentKind: input.componentKind,
    label: input.label,
    schemaCost: { kind: "known", tokens: 16, accuracy: "exact-tokenizer" },
    availability: "available",
    trust: "trusted",
    enablement: "enabled",
    policy: "allowed",
    providerEligibility: {
      providerInstanceId: input.providerInstanceId,
      status: "eligible",
      reason: "selected-provider",
    },
    scopeEligibility: {
      mode: { ...input.activeScope.mode, status: "eligible" },
      project: { ...input.activeScope.project, status: "eligible" },
      host: { ...input.activeScope.host, status: "eligible" },
      model: { ...input.activeScope.model, status: "eligible" },
    },
    posture: "optional",
    selectionMode: "explicit",
    taskKeywords: [],
    epoch: 1,
    invalidationFacts: [],
  });
  return input.id;
}

function contextEntryId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}
