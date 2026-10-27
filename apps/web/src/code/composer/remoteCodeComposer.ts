import type { PickerGroup } from "@octant/domain";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { SshTargetStatus } from "@octant/contracts/ssh-target";
import {
  REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE,
  remoteCodeProviderOffer,
} from "@octant/domain/ssh-target-recovery";

/**
 * The provider menu for a thread on an SSH target. The host runs Octant's
 * own harness there, and an ACP agent it places on the target where its
 * status lists the agent placeable and the person set the agent's path
 * there; it refuses every other provider before anything launches. Every
 * provider it would refuse stays listed, unavailable with the host's reason
 * (for an agent with no path, the command that sets one), rather than
 * disappearing from a menu that otherwise shows what cannot be chosen.
 */
export function remoteCodeThreadProviderGroups(
  groups: ReadonlyArray<PickerGroup>,
  target: Pick<SshTargetStatus, "target" | "placeableRuntimes"> | undefined,
): ReadonlyArray<PickerGroup> {
  return groups.map((group) => {
    if (group.runtime === "octant-harness") return group;
    const offer = remoteCodeProviderOffer(target, String(group.instance.id));
    if (offer.status === "offered") return group;
    return {
      ...group,
      unavailableNote: offer.message,
      sections: group.sections.map((section) => ({
        ...section,
        models: section.models.map((picker) => ({
          ...picker,
          unavailableReason: offer.message,
        })),
      })),
    };
  });
}

/** What a thread on an SSH target would run for the chosen model, or why nothing. */
export type RemoteCodeSelection =
  | { readonly status: "harness" }
  | { readonly status: "placed-agent"; readonly providerInstanceId: ProviderInstanceId }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * Whether the chosen model, in the menu `remoteCodeThreadProviderGroups`
 * made, is one a target runs: Octant's harness, or an agent the host places
 * there. A model listed unavailable carries its own reason.
 */
export function remoteCodeSelection(
  groups: ReadonlyArray<PickerGroup>,
  selection:
    | {
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
      }
    | undefined,
): RemoteCodeSelection {
  const unavailable = {
    status: "unavailable",
    message: REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE,
  } as const;
  if (selection === undefined) return unavailable;
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(selection.providerInstanceId),
  );
  const picker = group?.sections
    .flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(selection.modelId));
  if (group === undefined || picker === undefined) return unavailable;
  if (picker.unavailableReason !== undefined) {
    return { status: "unavailable", message: picker.unavailableReason };
  }
  return group.runtime === "octant-harness"
    ? { status: "harness" }
    : { status: "placed-agent", providerInstanceId: group.instance.id };
}
