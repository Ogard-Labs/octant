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
import { buildSkillCatalog, filterSkillCatalogForScope } from "@octant/plugin-host";
import { parseComposerReference } from "@octant/plugin-host/composer";
import { sourceQualifiedSkillId } from "@octant/plugin-host/model";
import { useCallback, useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import type { ComposerExtensionSelection } from "../composer/composerExtensionSelection";

export function useExtensionDraftSelections(options: {
  readonly client?: ExtensionClient;
  readonly providerFamily?: ExtensionProviderFamily;
  readonly thread?: ChatThread;
  readonly mode?: OctantMode;
  readonly projectId?: string | null;
  readonly threadId?: string | null;
}) {
  const computerEnabled = useComputerUseEnabled();
  const [receipts, setReceipts] = useState<ReadonlyArray<ComposerExtensionSelection>>([]);
  const resolutionGeneration = useRef(0);

  const mode = options.mode ?? "chat";
  const projectId = options.thread?.projectId ?? options.projectId ?? null;
  const threadId = options.thread?.id ?? options.threadId ?? null;

  const clear = useCallback(() => {
    resolutionGeneration.current += 1;
    setReceipts([]);
  }, []);

  useEffect(() => {
    resolutionGeneration.current += 1;
    setReceipts([]);
  }, [mode, options.providerFamily, projectId, threadId]);

  const resolveReference = useCallback(
    async (draft: string): Promise<boolean> => {
      const reference = draft.trim();
      const generation = resolutionGeneration.current;
      const commit = (update: (current: ReadonlyArray<ComposerExtensionSelection>) => ReadonlyArray<ComposerExtensionSelection>) => {
        if (resolutionGeneration.current !== generation) return;
        setReceipts(update);
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
    [computerEnabled, mode, options.client, options.providerFamily, projectId, threadId],
  );

  const remove = useCallback(
    (reference: string) => {
      resolutionGeneration.current += 1;
      setReceipts((current) => current.filter((receipt) => receipt.reference !== reference));
    },
    [],
  );

  const restore = useCallback(
    (next: ReadonlyArray<ComposerExtensionSelection>) => {
      resolutionGeneration.current += 1;
      setReceipts([...next]);
    },
    [],
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
  scope: { readonly mode: OctantMode; readonly projectId: string | null; readonly threadId: string | null },
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
    skills: filterSkillCatalogForScope(
      buildSkillCatalog(snapshot.skills ?? []),
      { mode: scope.mode, projectId: scope.projectId, threadRef: scope.threadId ?? "draft" },
    ).skills.map((record) => ({
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
