import { revalidateExtensionSelection } from "@octant/plugin-host";
import type {
  ExtensionSnapshot,
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
} from "@octant/contracts/extension-rpc";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  buildCatalogs,
  type ExtensionMaterialLoaderPort,
  type ExtensionToolExecutionPort,
} from "./extensionChatResolver";
import { composeSelectedExtensionCapabilities } from "./extensionAddressingService";
import type {
  CodeThread,
  ProviderContextBlock,
  ProviderToolDefinition,
  WindowId,
  WorkThread,
} from "@octant/contracts";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";

export type SelectedExtensionResolver = (input: {
  readonly mode: "work" | "code";
  readonly thread: WorkThread | CodeThread;
  readonly selections: ReadonlyArray<ExtensionSelection>;
  /** The window a person answers this turn's tool approvals in. */
  readonly windowId: WindowId;
}) => Promise<
  | {
      readonly kind: "resolved";
      readonly context: ReadonlyArray<ProviderContextBlock>;
      /** The selected MCP servers' tools; absent when no selection offers any. */
      readonly tools?: AppManagedToolSet;
    }
  | { readonly kind: "unavailable"; readonly message: string }
>;

/**
 * Selected skills and MCP servers for a Work or Code turn, through the same
 * catalog and activation checks as Chat. An MCP server's tools run in Octant's
 * supervised session for this thread's scope, and every call waits for a
 * person's approval in the turn's window.
 */
export function createSelectedExtensionResolver(options: {
  readonly snapshot: () => Promise<ExtensionSnapshot>;
  readonly resolveEffectiveState: (
    snapshot: ExtensionSnapshot,
    query: ExtensionEffectiveStateQuery,
  ) => ExtensionEffectiveSnapshot;
  readonly providerFamily: (thread: WorkThread | CodeThread) => ExtensionProviderFamily | undefined;
  /** Connects the scope's MCP sessions and reports which stayed effective. */
  readonly reconcileEffectiveState?: (
    snapshot: ExtensionEffectiveSnapshot,
  ) => Promise<ExtensionEffectiveSnapshot | void>;
  readonly materialLoader: ExtensionMaterialLoaderPort;
  /** Absent on a host that runs no MCP sessions; a selected server is then refused. */
  readonly toolExecution?: ExtensionToolExecutionPort;
  /**
   * Whether the thread's provider and model carry Octant's tools at all. A
   * selected server's tools are refused rather than dropped from a turn that
   * could never call them.
   */
  readonly carriesAppManagedTools?: (thread: WorkThread | CodeThread) => boolean;
}): SelectedExtensionResolver {
  return async ({ mode, thread, selections, windowId }) => {
    const unavailable = (message: string) => ({ kind: "unavailable" as const, message });
    try {
      const providerFamily = options.providerFamily(thread);
      if (providerFamily === undefined)
        return unavailable("Selected extension provider is unavailable.");
      const snapshot = await options.snapshot();
      let effectiveSnapshot = options.resolveEffectiveState(snapshot, {
        scope: {
          hostId: LOCAL_HOST_ID,
          mode,
          projectId: thread.projectId,
          threadId: String(thread.id),
          providerFamily,
        },
      });
      const reconciled = await options.reconcileEffectiveState?.(effectiveSnapshot);
      if (reconciled !== undefined) effectiveSnapshot = reconciled;
      const catalogs = buildCatalogs(snapshot, effectiveSnapshot, {
        mode,
        threadId: String(thread.id),
        projectId: String(thread.projectId),
        threadVersion: Number(thread.version),
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
      });
      // A new-task draft is selected before its thread exists. Validate that
      // original Project/mode/provider catalog first, then the actual thread;
      // arbitrary stale epochs still refuse and no activation is carried over.
      let scopedSelections = selections;
      if (
        selections.some((selection) => selection.catalogEpoch !== effectiveSnapshot.catalogEpoch)
      ) {
        const draftEffective = options.resolveEffectiveState(snapshot, {
          scope: { ...effectiveSnapshot.scope, threadId: null },
        });
        const draftCatalogs = buildCatalogs(snapshot, draftEffective, {
          mode,
          threadId: null,
          projectId: String(thread.projectId),
          threadVersion: 0,
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
        });
        const rebound: Array<ExtensionSelection> = [];
        for (const selection of selections) {
          if (selection.catalogEpoch === effectiveSnapshot.catalogEpoch) {
            rebound.push(selection);
            continue;
          }
          const result = revalidateExtensionSelection(
            selection,
            draftCatalogs.addressing,
            "provider-handoff",
          );
          if (result.kind === "blocked")
            return unavailable(`Selected extension is unavailable (${result.reason}).`);
          rebound.push({ ...selection, catalogEpoch: effectiveSnapshot.catalogEpoch });
        }
        scopedSelections = rebound;
      }
      const composed = await composeSelectedExtensionCapabilities({
        phase: "provider-handoff",
        selections: scopedSelections,
        addressingCatalog: catalogs.addressing,
        authoritativeCatalogEpoch: effectiveSnapshot.catalogEpoch,
        capabilityCatalog: catalogs.capabilities,
        capabilityRequest: catalogs.request,
        loadMaterial: (entry) =>
          options.materialLoader.load({ entry, effectiveSnapshot, snapshot }),
      });
      if (composed.status === "blocked")
        return unavailable(`Selected extension is unavailable (${composed.reasons.join(", ")}).`);
      if (composed.providerContext.some((block) => block.kind !== "instructions")) {
        return unavailable("Selected skill instructions are unavailable.");
      }
      if (composed.tools.length === 0) {
        return { kind: "resolved", context: composed.providerContext };
      }
      if (options.carriesAppManagedTools?.(thread) !== true) {
        return unavailable(
          "This provider cannot carry the selected extension's tools. Choose a model that supports Octant's tools, or remove the selection.",
        );
      }
      const tools = selectedToolSet({
        execution: options.toolExecution,
        thread: { id: String(thread.id), projectId: String(thread.projectId) },
        definitions: composed.tools,
        windowId,
      });
      if (tools === undefined) {
        return unavailable("Selected extension tools are not available for execution.");
      }
      return { kind: "resolved", context: composed.providerContext, tools };
    } catch {
      return unavailable("Selected extension could not be verified.");
    }
  };
}

/**
 * Only the tools this turn selected answer; any other name the provider calls
 * is refused rather than reaching another session in the same scope.
 */
function selectedToolSet(input: {
  readonly execution: ExtensionToolExecutionPort | undefined;
  readonly thread: { readonly id: string; readonly projectId: string };
  readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  readonly windowId: WindowId;
}): AppManagedToolSet | undefined {
  const { execution, thread, definitions, windowId } = input;
  if (execution?.availability({ thread, definitions }) !== "available") return undefined;
  const selectedNames = new Set(definitions.map((definition) => definition.name));
  return {
    definitions,
    execute: (call) =>
      selectedNames.has(call.name)
        ? execution.execute({ thread, windowId, ...call })
        : Promise.resolve({ result: { error: "extension-tool-not-selected" }, isError: true }),
  };
}
