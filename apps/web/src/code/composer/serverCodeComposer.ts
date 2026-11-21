import type { PickerGroup } from "@octant/domain";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";

/** Why a runtime is not offered in a server Project. */
export const SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE =
  "Runs on this computer's files; a Project on a server runs on the Octant Harness, or on a runtime that runs on the server itself.";

/**
 * Whether a runtime runs in a server Project: the Octant Harness, whose hands
 * are on the server, or a runtime that reports it runs on the server itself.
 */
function runsInServerProject(group: PickerGroup, mode: "code" | "work"): boolean {
  // A Work thread on a server runs on the Octant Harness only.
  return (
    group.runtime === "octant-harness" || (mode === "code" && group.serverPlacement === "supported")
  );
}

/**
 * The provider menu for a thread in a server Project. The host runs the Octant
 * Harness there, or a runtime that runs on the server itself (Codex), and
 * refuses every other runtime before it launches. Each one stays listed, unavailable with the
 * reason, rather than disappearing from a menu that otherwise shows what
 * cannot be chosen.
 */
export function serverCodeThreadProviderGroups(
  groups: ReadonlyArray<PickerGroup>,
  mode: "code" | "work" = "code",
): ReadonlyArray<PickerGroup> {
  return groups.map((group) =>
    runsInServerProject(group, mode)
      ? group
      : {
          ...group,
          unavailableNote: SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE,
          sections: group.sections.map((section) => ({
            ...section,
            models: section.models.map((picker) => ({
              ...picker,
              unavailableReason: SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE,
            })),
          })),
        },
  );
}

/**
 * Why the chosen model cannot start a thread in a server Project, or
 * undefined when it can. A model the menu lists unavailable carries its own
 * reason.
 */
export function serverCodeSelectionRefusal(
  groups: ReadonlyArray<PickerGroup>,
  selection:
    | {
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
      }
    | undefined,
): string | undefined {
  if (selection === undefined) return SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE;
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(selection.providerInstanceId),
  );
  const picker = group?.sections
    .flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(selection.modelId));
  if (group === undefined || picker === undefined) return SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE;
  if (picker.unavailableReason !== undefined) return picker.unavailableReason;
  return runsInServerProject(group, "code") ? undefined : SERVER_CODE_THREAD_PROVIDER_UNAVAILABLE;
}

/**
 * What running a provider on a server means, said the first time a person
 * picks it there (maintainer decision, 2026-11-20).
 */
export function serverPlacementNotice(provider: string, server: string): string {
  return `${provider} runs on ${server} as itself. Its sandbox and plan mode are ${provider}'s own; Octant can't sandbox anything on that server. Its requests to its model leave from ${server}, not from this computer, so this computer's network limits don't cover them. Approvals, Stop and the thread's history stay on this computer.`;
}

const SEEN_PLACEMENT_NOTICES = "octant.server-placement-notices";

export function serverPlacementNoticeKey(server: string, providerInstanceId: string): string {
  return `${server}\u0000${providerInstanceId}`;
}

/** The notices this viewer has dismissed. Storage that cannot be read shows each again. */
export function readSeenPlacementNotices(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(
      globalThis.localStorage?.getItem(SEEN_PLACEMENT_NOTICES) ?? "[]",
    );
    return new Set(Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberPlacementNotice(key: string): ReadonlySet<string> {
  const next = new Set([...readSeenPlacementNotices(), key]);
  try {
    globalThis.localStorage?.setItem(SEEN_PLACEMENT_NOTICES, JSON.stringify([...next]));
  } catch {
    // Without storage the notice shows again next time, which is harmless.
  }
  return next;
}
