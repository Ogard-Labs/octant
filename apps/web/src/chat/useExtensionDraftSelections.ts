import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ChatThread } from "@octant/contracts/chat";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type {
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import type { ExtensionProviderFamily, SourceQualifiedSkillId } from "@octant/contracts/extensions";
import {
  parseComposerReference,
  resolveDraftExtensionReference,
  sourceQualifiedSkillId,
  type ExtensionAddressingCatalog,
} from "@octant/plugin-host";
import { useCallback, useEffect, useState } from "react";
import type { ChatComposerExtensionSelection } from "./ChatComposer";

export function useExtensionDraftSelections(options: {
  readonly client?: ExtensionClient;
  readonly providerFamily?: ExtensionProviderFamily;
  readonly thread?: ChatThread;
}) {
  const [receipts, setReceipts] = useState<ReadonlyArray<ChatComposerExtensionSelection>>([]);

  const clear = useCallback(() => setReceipts([]), []);

  useEffect(clear, [clear, options.providerFamily, options.thread?.id]);

  const resolveReference = useCallback(
    async (draft: string): Promise<boolean> => {
      const reference = draft.trim();
      if (parseComposerReference(reference).kind === "plain-text") return false;
      const thread = options.thread;
      if (
        options.client === undefined ||
        options.providerFamily === undefined ||
        thread === undefined
      ) {
        setReceipts((current) => upsertReceipt(current, blockedReceipt(reference, "unavailable")));
        return true;
      }
      try {
        let snapshot = await options.client.snapshot();
        const effective = await options.client.effectiveState({
          scope: {
            hostId: LOCAL_HOST_ID,
            mode: "chat",
            projectId: thread.projectId ?? null,
            threadId: thread.id,
            providerFamily: options.providerFamily,
          },
        });
        if (snapshot.sequence !== effective.sequence) snapshot = await options.client.snapshot();
        if (snapshot.sequence !== effective.sequence || effective.stale) {
          setReceipts((current) =>
            upsertReceipt(current, blockedReceipt(reference, "stale-catalog-epoch")),
          );
          return true;
        }
        const result = resolveDraftExtensionReference(
          reference,
          addressingCatalog(snapshot, effective),
          crypto.randomUUID(),
        );
        if (result.kind === "plain-text") return false;
        if (result.kind === "selected") {
          setReceipts((current) =>
            upsertReceipt(current, {
              reference,
              label: result.label,
              selection: result.selection,
              status: { kind: "selected" },
            }),
          );
          return true;
        }
        setReceipts((current) =>
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
        setReceipts((current) => upsertReceipt(current, blockedReceipt(reference, "unavailable")));
        return true;
      }
    },
    [options.client, options.providerFamily, options.thread],
  );

  const remove = useCallback(
    (reference: string) =>
      setReceipts((current) => current.filter((receipt) => receipt.reference !== reference)),
    [],
  );

  return { clear, receipts, remove, resolveReference };
}

function addressingCatalog(
  snapshot: ExtensionSnapshot,
  effective: ExtensionEffectiveSnapshot,
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
    skills: (snapshot.skills ?? []).map((record) => ({
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

function blockedReceipt(reference: string, reason: string): ChatComposerExtensionSelection {
  return { reference, label: reference, status: { kind: "blocked", reason } };
}

function upsertReceipt(
  current: ReadonlyArray<ChatComposerExtensionSelection>,
  receipt: ChatComposerExtensionSelection,
): ReadonlyArray<ChatComposerExtensionSelection> {
  return [...current.filter((candidate) => candidate.reference !== receipt.reference), receipt];
}
