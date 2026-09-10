import { useComputerUseEnabled } from "../computerUse/ComputerUseMention";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import { browserUseSelection } from "@octant/plugin-host/browser-use";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ChatThread } from "@octant/contracts/chat";
import type { OctantMode } from "@octant/contracts/modes";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type {
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import type { ExtensionProviderFamily, SourceQualifiedSkillId } from "@octant/contracts/extensions";
import { ExtensionActivationScope as ExtensionActivationScopeSchema } from "@octant/contracts/extensions";
// Subpath imports: the package index re-exports the skill loader and with it
// the YAML parser, which every window paid for in its first bundle.
import {
  resolveDraftExtensionReference,
  type ExtensionAddressingCatalog,
} from "@octant/plugin-host/addressing";
import { buildSkillCatalog, filterSkillCatalogForScope } from "@octant/plugin-host/skills";
import { parseComposerReference } from "@octant/plugin-host/composer";
import { sourceQualifiedSkillId } from "@octant/plugin-host/model";
import { useCallback, useRef, useState } from "react";
import { Schema } from "effect";
import type { ComposerExtensionSelection } from "../composer/composerExtensionSelection";

type DraftSelectionClient = Pick<ExtensionClient, "snapshot" | "effectiveState">;
const NO_RECEIPTS: ReadonlyArray<ComposerExtensionSelection> = [];

export function useExtensionDraftSelections(options: {
  readonly client?: DraftSelectionClient;
  readonly providerFamily?: ExtensionProviderFamily;
  readonly thread?: ChatThread;
  readonly mode?: OctantMode;
  readonly projectId?: string | null;
  readonly threadId?: string | null;
}) {
  const computerEnabled = useComputerUseEnabled();
  const mode = options.mode ?? "chat";
  const projectId = options.thread?.projectId ?? options.projectId ?? null;
  const threadId = options.thread?.id ?? options.threadId ?? null;
  const scopeKey = JSON.stringify([mode, options.providerFamily, projectId, threadId]);
  const generations = useRef(new Map<string, number>());
  const activeScope = useRef({ key: scopeKey, client: options.client });
  if (activeScope.current.key !== scopeKey || activeScope.current.client !== options.client) {
    const previous = activeScope.current.key;
    generations.current.set(previous, (generations.current.get(previous) ?? 0) + 1);
    activeScope.current = { key: scopeKey, client: options.client };
  }
  const [state, setState] = useState<{
    readonly client: DraftSelectionClient | undefined;
    readonly byScope: ReadonlyMap<string, ReadonlyArray<ComposerExtensionSelection>>;
  }>(() => ({ client: options.client, byScope: new Map() }));
  const receipts =
    state.client === options.client ? (state.byScope.get(scopeKey) ?? NO_RECEIPTS) : NO_RECEIPTS;

  // A refused send may restore after the user has opened another Project.
  // Keep that receipt with its original draft, never over the current one.
  const updateReceipts = useCallback(
    (
      update: (
        current: ReadonlyArray<ComposerExtensionSelection>,
      ) => ReadonlyArray<ComposerExtensionSelection>,
    ) => {
      if (activeScope.current.client !== options.client) return;
      setState((current) => {
        if (activeScope.current.client !== options.client) return current;
        const byScope = new Map(current.client === options.client ? current.byScope : undefined);
        const next = update(byScope.get(scopeKey) ?? NO_RECEIPTS);
        if (next.length === 0) byScope.delete(scopeKey);
        else byScope.set(scopeKey, next);
        return { client: options.client, byScope };
      });
    },
    [options.client, scopeKey],
  );
  const invalidate = useCallback(() => {
    generations.current.set(scopeKey, (generations.current.get(scopeKey) ?? 0) + 1);
  }, [scopeKey]);
  const clear = useCallback(() => {
    invalidate();
    updateReceipts(() => NO_RECEIPTS);
  }, [invalidate, updateReceipts]);

  const resolveReference = useCallback(
    async (draft: string): Promise<boolean> => {
      const reference = draft.trim();
      const generation = generations.current.get(scopeKey) ?? 0;
      const isCurrent = () =>
        activeScope.current.key === scopeKey &&
        activeScope.current.client === options.client &&
        (generations.current.get(scopeKey) ?? 0) === generation;
      const commit = (
        update: (
          current: ReadonlyArray<ComposerExtensionSelection>,
        ) => ReadonlyArray<ComposerExtensionSelection>,
      ) => {
        if (isCurrent()) updateReceipts((current) => (isCurrent() ? update(current) : current));
      };
      if (reference.toLowerCase() === "@computer") {
        if (!computerEnabled) {
          commit((current) =>
            upsertReceipt(current, blockedReceipt("@Computer", "plugin-disabled")),
          );
          return true;
        }
        commit((current) =>
          upsertReceipt(current, {
            reference: "@Computer",
            label: "Computer",
            selection: computerUseSelection(crypto.randomUUID()),
            status: { kind: "selected" },
          }),
        );
        return true;
      }
      if (reference.toLowerCase() === "@browser") {
        commit((current) =>
          upsertReceipt(current, {
            reference: "@Browser",
            label: "Browser",
            selection: browserUseSelection(crypto.randomUUID()),
            status: { kind: "selected" },
          }),
        );
        return true;
      }
      if (parseComposerReference(reference).kind === "plain-text") return false;
      if (options.client === undefined || options.providerFamily === undefined) {
        commit((current) => upsertReceipt(current, blockedReceipt(reference, "unavailable")));
        return true;
      }
      try {
        const scopedProjectId = decodeScopeUuid(projectId);
        const scopedThreadId = decodeScopeUuid(threadId);
        if (
          (projectId !== null && scopedProjectId === null) ||
          (threadId !== null && scopedThreadId === null)
        ) {
          commit((current) => upsertReceipt(current, blockedReceipt(reference, "invalid-scope")));
          return true;
        }
        let snapshot = await options.client.snapshot();
        const scope = Schema.decodeUnknownSync(ExtensionActivationScopeSchema)({
          hostId: LOCAL_HOST_ID,
          mode,
          projectId: scopedProjectId,
          threadId: scopedThreadId,
          providerFamily: options.providerFamily,
        });
        const effective = await options.client.effectiveState({ scope });
        if (snapshot.sequence !== effective.sequence) snapshot = await options.client.snapshot();
        if (snapshot.sequence !== effective.sequence || effective.stale) {
          commit((current) =>
            upsertReceipt(current, blockedReceipt(reference, "stale-catalog-epoch")),
          );
          return true;
        }
        const result = resolveDraftExtensionReference(
          reference,
          addressingCatalog(snapshot, effective, { mode, projectId, threadId }),
          crypto.randomUUID(),
        );
        if (result.kind === "plain-text") return false;
        if (result.kind === "selected") {
          commit((current) =>
            upsertReceipt(current, {
              reference,
              label: result.label,
              selection: result.selection,
              status: { kind: "selected" },
            }),
          );
          return true;
        }
        commit((current) =>
          upsertReceipt(
            current,
            blockedReceipt(
              reference,
              result.kind === "ambiguous"
                ? `ambiguous:${result.candidates.join(",")}`
                : result.reason,
            ),
          ),
        );
        return true;
      } catch {
        commit((current) => upsertReceipt(current, blockedReceipt(reference, "unavailable")));
        return true;
      }
    },
    [
      computerEnabled,
      mode,
      options.client,
      options.providerFamily,
      projectId,
      threadId,
      scopeKey,
      updateReceipts,
    ],
  );

  const remove = useCallback(
    (reference: string) => {
      invalidate();
      updateReceipts((current) => current.filter((receipt) => receipt.reference !== reference));
    },
    [invalidate, updateReceipts],
  );

  const restore = useCallback(
    (next: ReadonlyArray<ComposerExtensionSelection>) => {
      invalidate();
      updateReceipts(() => [...next]);
    },
    [invalidate, updateReceipts],
  );

  return { clear, receipts, remove, resolveReference, restore };
}

function decodeScopeUuid(value: string | null): string | null {
  if (value === null) return null;
  try {
    return Schema.decodeUnknownSync(Schema.UUID)(String(value));
  } catch {
    return null;
  }
}

function addressingCatalog(
  snapshot: ExtensionSnapshot,
  effective: ExtensionEffectiveSnapshot,
  scope: {
    readonly mode: OctantMode;
    readonly projectId: string | null;
    readonly threadId: string | null;
  },
): ExtensionAddressingCatalog {
  const installedSkills = new Map<
    SourceQualifiedSkillId,
    ExtensionEffectiveSnapshot["packages"][number]["components"][number]
  >();
  for (const packageState of effective.packages) {
    for (const component of packageState.components) {
      if (component.component.kind !== "skill-instructions") continue;
      installedSkills.set(
        sourceQualifiedSkillId(packageState.source, component.component.id, packageState.digest),
        component,
      );
    }
  }
  return {
    epoch: effective.catalogEpoch,
    plugins: effective.packages.flatMap((packageState) =>
      packageState.slug === undefined
        ? []
        : [
            {
              extensionId: packageState.extensionId,
              packageId: packageState.packageId,
              slug: packageState.slug,
              packageVersion: packageState.version,
              packageDigest: packageState.digest,
              ...(packageState.components.length === 1
                ? { primaryComponentId: packageState.components[0]!.component.id }
                : {}),
              components: packageState.components.map((component) => ({
                componentId: component.component.id,
                label: component.component.displayName,
                effectiveState: component.effectiveState,
              })),
            },
          ],
    ),
    skills: filterSkillCatalogForScope(buildSkillCatalog(snapshot.skills ?? []), {
      mode: scope.mode,
      projectId: scope.projectId,
      threadRef: scope.threadId ?? "draft",
    }).skills.map((record) => ({
      skillId: record.skill.qualifiedId,
      name: record.skill.name,
      label: record.displayName,
      ...(record.version === undefined ? {} : { packageVersion: record.version }),
      packageDigest: record.skill.digest,
      effectiveState:
        installedSkills.get(record.skill.qualifiedId)?.effectiveState ?? record.effectiveState,
    })),
  };
}

function blockedReceipt(reference: string, reason: string): ComposerExtensionSelection {
  return { reference, label: reference, status: { kind: "blocked", reason } };
}

function upsertReceipt(
  current: ReadonlyArray<ComposerExtensionSelection>,
  receipt: ComposerExtensionSelection,
): ReadonlyArray<ComposerExtensionSelection> {
  return [...current.filter((candidate) => candidate.reference !== receipt.reference), receipt];
}
