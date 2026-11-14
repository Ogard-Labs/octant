import type { EventActor } from "@octant/contracts/events";
import type { ProviderInstance } from "@octant/contracts/providers";
import type { ModelPickerSelection, PickerGroup } from "./modelPickerPolicy";

export type ProviderAccountMoveRefusal =
  | "unattended"
  | "turn-running"
  | "same-account"
  | "account-missing"
  | "account-disabled"
  | "other-provider";

export type ProviderAccountMoveDecision =
  | { readonly kind: "moves" }
  | {
      readonly kind: "refused";
      readonly reason: ProviderAccountMoveRefusal;
      readonly message: string;
    };

const refusalMessages: Readonly<Record<ProviderAccountMoveRefusal, string>> = {
  unattended: "A thread moves to another account only when you ask for it.",
  "turn-running": "Wait for the running answer to finish before moving this thread.",
  "same-account": "This thread is already on that account.",
  "account-missing": "That account is no longer set up on this computer.",
  "account-disabled": "That account is turned off.",
  "other-provider": "Move to account offers only accounts of the thread's own provider.",
};

function refused(reason: ProviderAccountMoveRefusal): ProviderAccountMoveDecision {
  return { kind: "refused", reason, message: refusalMessages[reason] };
}

/**
 * Whether a thread may move to another account of its provider. Only the
 * person moves a thread, at a window, on a device they paired, or as an owner
 * after a fresh unlock: the host itself and an agent never do, because a
 * move they made would be the silent account rotation the provider rules
 * refuse. A missing actor is a host-internal caller with nobody behind it.
 */
export function decideProviderAccountMove(input: {
  readonly actor: EventActor | undefined;
  readonly turnRunning: boolean;
  readonly from: Pick<ProviderInstance, "id" | "driverKind"> | undefined;
  readonly to: Pick<ProviderInstance, "id" | "driverKind" | "enabled"> | undefined;
}): ProviderAccountMoveDecision {
  const actor = input.actor;
  if (
    actor === undefined ||
    (actor.kind !== "local-user" && actor.kind !== "remote-device" && actor.kind !== "owner-unlock")
  ) {
    return refused("unattended");
  }
  if (input.turnRunning) return refused("turn-running");
  if (input.to === undefined) return refused("account-missing");
  if (input.from !== undefined && String(input.from.id) === String(input.to.id)) {
    return refused("same-account");
  }
  if (!input.to.enabled) return refused("account-disabled");
  if (input.from !== undefined && input.from.driverKind !== input.to.driverKind) {
    return refused("other-provider");
  }
  return { kind: "moves" };
}

/**
 * The other accounts a thread can be moved to: ready instances of the same
 * provider that offer the thread's model. The host decides again on the move.
 */
export function providerAccountMoveTargets(
  groups: ReadonlyArray<PickerGroup>,
  selection: ModelPickerSelection,
): ReadonlyArray<PickerGroup> {
  const current = groups.find(
    (group) => String(group.instance.id) === String(selection.providerInstanceId),
  );
  if (current === undefined) return [];
  return groups.filter(
    (group) =>
      String(group.instance.id) !== String(current.instance.id) &&
      group.instance.driverKind === current.instance.driverKind &&
      group.instance.enabled &&
      group.readiness === "ready" &&
      group.sections.some((section) =>
        section.models.some((picker) => String(picker.model.id) === String(selection.modelId)),
      ),
  );
}
