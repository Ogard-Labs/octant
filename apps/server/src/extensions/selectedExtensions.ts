import { resolveDraftExtensionReference, revalidateExtensionSelection } from "@octant/plugin-host";
import type {
  ExtensionSnapshot,
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
} from "@octant/contracts/extension-rpc";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  buildCatalogs,
  type ExtensionSelectionSubject,
  type ExtensionMaterialLoaderPort,
  type ExtensionToolExecutionPort,
  type ExtensionToolThread,
} from "./extensionChatResolver";
import { composeSelectedExtensionCapabilities } from "./extensionAddressingService";
import type {
  CodeThread,
  ProjectId,
  ProviderContextBlock,
  ProviderToolDefinition,
  WindowId,
  WorkThread,
} from "@octant/contracts";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { ExtensionAddressingCatalog } from "@octant/plugin-host";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";

export type SelectedExtensionResolver = (input: {
  readonly mode: "work" | "code";
  readonly thread: WorkThread | CodeThread;
  readonly selections: ReadonlyArray<ExtensionSelection>;
  /**
   * The plugins pinned to the thread's Project. Each is offered as if named
   * this turn, once; a pin whose package is not in the Project's current
   * catalog, or not fully effective there, is skipped rather than refused.
   */
  readonly pinnedExtensionIds?: ReadonlyArray<string>;
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
 * person's approval in the turn's window unless a remembered approval of that
 * tool in the thread's Project covers it.
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
  return async ({ mode, thread, selections, pinnedExtensionIds, windowId }) => {
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
      // A pin is resolved here, against the same catalog the turn's own
      // selections are checked against, so it carries the package identity
      // and epoch a selection needs (observed: a pin built from the id alone
      // was refused as stale on every turn).
      const pinned = pinnedSelections(
        pinnedExtensionIds ?? [],
        scopedSelections,
        catalogs.addressing,
        String(thread.projectId),
      );
      scopedSelections = [...scopedSelections, ...pinned];
      if (scopedSelections.length === 0) return { kind: "resolved", context: [] };
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
      if (composed.providerContext.some((block) => block.kind !== "skill-instructions")) {
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
        thread: {
          id: String(thread.id),
          projectId: String(thread.projectId),
          // A Code turn's thread carries the posture that turn runs under.
          planTurn: "executionPolicy" in thread && thread.executionPolicy === "plan",
        },
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
  readonly thread: ExtensionToolThread;
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

function pinnedSelections(
  pinnedExtensionIds: ReadonlyArray<string>,
  explicit: ReadonlyArray<ExtensionSelection>,
  catalog: ExtensionAddressingCatalog,
  projectId: string,
): ReadonlyArray<ExtensionSelection> {
  const named = new Set(
    explicit.flatMap((selection) =>
      selection.kind === "plugin" ? [String(selection.extensionId)] : [],
    ),
  );
  // A pin means the whole plugin, so it becomes one selection per component,
  // the way a person naming each would; a plugin the person named this turn
  // keeps exactly the components they chose.
  return pinnedExtensionIds.flatMap((extensionId) => {
    if (named.has(extensionId)) return [];
    const plugin = catalog.plugins.find((entry) => String(entry.extensionId) === extensionId);
    if (
      plugin === undefined ||
      plugin.components.length === 0 ||
      plugin.components.some((component) => component.effectiveState.kind !== "effective")
    ) {
      return [];
    }
    return plugin.components.map((component) => ({
      kind: "plugin" as const,
      extensionId: plugin.extensionId,
      packageId: plugin.packageId,
      componentId: component.componentId,
      packageVersion: plugin.packageVersion,
      packageDigest: plugin.packageDigest,
      catalogEpoch: catalog.epoch,
      origin: { kind: "turn" as const, reference: `pin:${projectId}` },
    }));
  });
}

/** A refusal the reader returns instead of throwing; its message is for the model. */
interface EffectiveSkillRefusal {
  readonly status: "refused";
  readonly reason: string;
  readonly message: string;
}

export interface EffectiveSkillReader {
  readonly list: () => Promise<
    | {
        readonly status: "listed";
        readonly skills: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
      }
    | EffectiveSkillRefusal
  >;
  readonly load: (
    name: string,
  ) => Promise<
    | { readonly status: "loaded"; readonly name: string; readonly instructions: string }
    | EffectiveSkillRefusal
  >;
}

/**
 * The skills effective for one thread, read on demand. It resolves the same
 * catalog a turn's selections are checked against and loads a skill as a `$`
 * selection of it would, through the activation ladder, so a skill that is
 * not effective for this thread is refused rather than loaded. It connects no
 * MCP session and changes no install, trust, enablement, or activation.
 */
export function createEffectiveSkillReader(options: {
  readonly snapshot: () => Promise<ExtensionSnapshot>;
  readonly resolveEffectiveState: (
    snapshot: ExtensionSnapshot,
    query: ExtensionEffectiveStateQuery,
  ) => ExtensionEffectiveSnapshot;
  readonly providerFamily: (
    providerInstanceId: ExtensionSelectionSubject["providerInstanceId"],
  ) => ExtensionProviderFamily | undefined;
  readonly materialLoader: ExtensionMaterialLoaderPort;
}): (
  subject: ExtensionSelectionSubject & {
    readonly threadId: string;
    readonly projectId: ProjectId | null;
  },
) => EffectiveSkillReader {
  return (subject) => {
    const unavailable: EffectiveSkillRefusal = {
      status: "refused",
      reason: "skills-unavailable",
      message: "Octant could not read this thread's skills.",
    };
    const resolve = async () => {
      const providerFamily = options.providerFamily(subject.providerInstanceId);
      if (providerFamily === undefined) return undefined;
      const snapshot = await options.snapshot();
      const effectiveSnapshot = options.resolveEffectiveState(snapshot, {
        scope: {
          hostId: LOCAL_HOST_ID,
          mode: subject.mode,
          projectId: subject.projectId,
          threadId: subject.threadId,
          providerFamily,
        },
      });
      return {
        snapshot,
        effectiveSnapshot,
        catalogs: buildCatalogs(snapshot, effectiveSnapshot, subject),
      };
    };
    return {
      list: async () => {
        try {
          const resolved = await resolve();
          if (resolved === undefined) return unavailable;
          const effective = resolved.catalogs.addressing.skills.filter(
            (skill) => skill.effectiveState.kind === "effective",
          );
          return {
            status: "listed",
            skills: effective.map((skill) => {
              const description = resolved.snapshot.skills?.find(
                (record) => String(record.skill.qualifiedId) === String(skill.skillId),
              )?.description;
              // Two effective skills sharing a name are told apart by the
              // qualified id, which `load` also accepts.
              const shared = effective.filter((other) => other.name === skill.name).length > 1;
              return {
                name: shared ? String(skill.skillId) : skill.name,
                ...(description === undefined ? {} : { description }),
              };
            }),
          };
        } catch {
          return unavailable;
        }
      },
      load: async (name) => {
        try {
          const resolved = await resolve();
          if (resolved === undefined) return unavailable;
          const { snapshot, effectiveSnapshot, catalogs } = resolved;
          const reference = resolveDraftExtensionReference(
            `$${name}`,
            catalogs.addressing,
            "harness-skill-tool",
          );
          if (reference.kind === "ambiguous") {
            return {
              status: "refused",
              reason: "skill-ambiguous",
              message: `More than one skill is named ${name}: ${reference.candidates.join(", ")}. Load one of them by that name.`,
            };
          }
          if (reference.kind !== "selected") {
            const reason = reference.kind === "blocked" ? reference.reason : "not-found";
            return reason === "not-found"
              ? {
                  status: "refused",
                  reason: "skill-not-found",
                  message: `No skill named ${name} is active for this thread. Call skill with operation list to see the ones that are.`,
                }
              : {
                  status: "refused",
                  reason: "skill-not-effective",
                  message: `${name} is not active for this thread (${reason}). Loading never turns a skill on; the person decides that in Settings.`,
                };
          }
          const composed = await composeSelectedExtensionCapabilities({
            phase: "provider-handoff",
            selections: [reference.selection],
            addressingCatalog: catalogs.addressing,
            authoritativeCatalogEpoch: effectiveSnapshot.catalogEpoch,
            capabilityCatalog: catalogs.capabilities,
            capabilityRequest: catalogs.request,
            loadMaterial: (entry) =>
              options.materialLoader.load({ entry, effectiveSnapshot, snapshot }),
          });
          const block =
            composed.status === "blocked"
              ? undefined
              : composed.providerContext.find(
                  (candidate) => candidate.kind === "skill-instructions",
                );
          if (block === undefined) {
            return {
              status: "refused",
              reason: "skill-not-effective",
              message: `${name} is not active for this thread. Loading never turns a skill on; the person decides that in Settings.`,
            };
          }
          return { status: "loaded", name, instructions: block.text };
        } catch {
          return unavailable;
        }
      },
    };
  };
}
