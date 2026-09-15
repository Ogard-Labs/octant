import { revalidateExtensionSelection } from "@octant/plugin-host";
import type {
  ExtensionSnapshot,
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
} from "@octant/contracts/extension-rpc";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { buildCatalogs, type ExtensionMaterialLoaderPort } from "./extensionChatResolver";
import { composeSelectedExtensionCapabilities } from "./extensionAddressingService";
import type { CodeThread, WorkThread, ProviderContextBlock } from "@octant/contracts";
import type { ExtensionSelection } from "@octant/contracts/extensions";

export type SelectedSkillContextResolver = (input: {
  readonly mode: "work" | "code";
  readonly thread: WorkThread | CodeThread;
  readonly selections: ReadonlyArray<ExtensionSelection>;
}) => Promise<
  | { readonly kind: "resolved"; readonly context: ReadonlyArray<ProviderContextBlock> }
  | { readonly kind: "unavailable"; readonly message: string }
>;

/** Prompt-only selections use the same catalog and activation checks as Chat. */
export function createSelectedSkillContextResolver(options: {
  readonly snapshot: () => Promise<ExtensionSnapshot>;
  readonly resolveEffectiveState: (
    snapshot: ExtensionSnapshot,
    query: ExtensionEffectiveStateQuery,
  ) => ExtensionEffectiveSnapshot;
  readonly providerFamily: (thread: WorkThread | CodeThread) => ExtensionProviderFamily | undefined;
  readonly materialLoader: ExtensionMaterialLoaderPort;
}): SelectedSkillContextResolver {
  return async ({ mode, thread, selections }) => {
    const unavailable = (message: string) => ({ kind: "unavailable" as const, message });
    try {
      if (selections.some((selection) => selection.kind !== "skill")) {
        return unavailable("Only selected skill instructions are supported in this context.");
      }
      const providerFamily = options.providerFamily(thread);
      if (providerFamily === undefined)
        return unavailable("Selected skill provider is unavailable.");
      const snapshot = await options.snapshot();
      const effectiveSnapshot = options.resolveEffectiveState(snapshot, {
        scope: {
          hostId: LOCAL_HOST_ID,
          mode,
          projectId: thread.projectId,
          threadId: String(thread.id),
          providerFamily,
        },
      });
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
            return unavailable(`Selected skill is unavailable (${result.reason}).`);
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
        return unavailable(`Selected skill is unavailable (${composed.reasons.join(", ")}).`);
      if (
        composed.tools.length > 0 ||
        composed.providerContext.length !== selections.length ||
        composed.providerContext.some((block) => block.kind !== "instructions")
      ) {
        return unavailable("Selected skill instructions are unavailable.");
      }
      return { kind: "resolved", context: composed.providerContext };
    } catch {
      return unavailable("Selected skill context could not be verified.");
    }
  };
}
