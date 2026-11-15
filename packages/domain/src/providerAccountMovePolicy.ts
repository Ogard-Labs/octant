import type { EventActor } from "@octant/contracts/events";
import type { ProviderInstance, ProviderInstanceId } from "@octant/contracts/providers";
import type {
  ThreadUsageLimitHandoff,
  ThreadUsageLimitHandoffOutcome,
} from "@octant/contracts/usage-limit-handoff";
import type { ModelPickerSelection, PickerGroup } from "./modelPickerPolicy";

export type ProviderAccountMoveRefusal =
  | "unattended"
  | "turn-running"
  | "model-pool"
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
  "model-pool": "Turn off the model pool first; its models stay on the current account.",
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
  /**
   * The thread routes its turns through a model pool. The pool names the
   * current account's instance, so after a move the next turn would either
   * refuse or go back to the old account while the move reported success.
   */
  readonly modelPoolOn: boolean;
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
  if (input.modelPoolOn) return refused("model-pool");
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

/**
 * Whether the person may set "when this account hits its usage limit, hand
 * off to" this account. It is the same choice as a move made ahead of time,
 * so it takes the move's rules except a running turn: the choice changes
 * nothing until a later turn stops on the limit.
 */
export function decideUsageLimitHandoffSetting(input: {
  readonly actor: EventActor | undefined;
  readonly modelPoolOn: boolean;
  readonly from: Pick<ProviderInstance, "id" | "driverKind"> | undefined;
  /** The account to hand off to, or `off` to turn the opt-in off. */
  readonly to: Pick<ProviderInstance, "id" | "driverKind" | "enabled"> | "off" | undefined;
}): ProviderAccountMoveDecision {
  if (input.to === "off") {
    // Turning it off widens nothing, but it is still the person's choice.
    const refusal = decideProviderAccountMove({
      ...input,
      to: undefined,
      turnRunning: false,
      modelPoolOn: false,
    });
    return refusal.kind === "refused" && refusal.reason === "unattended"
      ? refusal
      : { kind: "moves" };
  }
  return decideProviderAccountMove({ ...input, to: input.to, turnRunning: false });
}

export type UsageLimitHandoffDecision =
  | { readonly kind: "stays" }
  | { readonly kind: "hands-off" }
  | { readonly kind: "stopped"; readonly message: string };

/**
 * What the host does when a turn has just stopped. It hands the thread off
 * only on the person's standing opt-in, only for a stop the provider itself
 * reported as a usage limit, only once per stop, and only to the one account
 * the person named. When that account cannot take the thread, or the thread
 * is already on it (so that account hit its limit too), the host stops and
 * says why instead of trying anything else.
 */
export function decideUsageLimitHandoff(input: {
  /** The account the person named; absent when the opt-in is off. */
  readonly targetProviderInstanceId: string | undefined;
  /** The stop the opt-in last acted on, if any. */
  readonly lastStopId: string | undefined;
  /** The stop that just ended the turn, when it was a usage limit. */
  readonly limitStopId: string | undefined;
  readonly modelPoolOn: boolean;
  readonly from: Pick<ProviderInstance, "id" | "driverKind" | "displayName"> | undefined;
  readonly to: Pick<ProviderInstance, "id" | "driverKind" | "enabled" | "displayName"> | undefined;
}): UsageLimitHandoffDecision {
  if (input.targetProviderInstanceId === undefined || input.limitStopId === undefined) {
    return { kind: "stays" };
  }
  if (input.lastStopId === input.limitStopId) return { kind: "stays" };
  if (
    input.from !== undefined &&
    String(input.from.id) === String(input.targetProviderInstanceId)
  ) {
    return {
      kind: "stopped",
      message: `${input.from.displayName} hit its usage limit too, so the thread waits here.`,
    };
  }
  if (input.modelPoolOn) {
    return {
      kind: "stopped",
      message: "The model pool is on, so the thread stays on its account.",
    };
  }
  if (input.to === undefined) {
    return { kind: "stopped", message: "The account to hand off to is no longer set up." };
  }
  if (!input.to.enabled) {
    return { kind: "stopped", message: `${input.to.displayName} is turned off.` };
  }
  if (input.from !== undefined && input.from.driverKind !== input.to.driverKind) {
    return {
      kind: "stopped",
      message: `${input.to.displayName} is not an account of this thread's provider.`,
    };
  }
  return { kind: "hands-off" };
}

type WithUsageLimitHandoff = {
  readonly usageLimitHandoff?: ThreadUsageLimitHandoff | undefined;
};

/**
 * The thread with the person's opt-in set to `target`, or turned off when it
 * is absent. Choosing the same account again keeps what the opt-in last did,
 * so the thread keeps saying it; choosing another account starts afresh.
 */
export function withUsageLimitHandoff<T extends WithUsageLimitHandoff>(
  thread: T,
  target: ProviderInstanceId | undefined,
): T {
  const { usageLimitHandoff: previous, ...rest } = thread;
  if (target === undefined) return rest as T;
  const kept =
    previous !== undefined &&
    String(previous.providerInstanceId) === String(target) &&
    previous.last !== undefined
      ? { last: previous.last }
      : {};
  return { ...rest, usageLimitHandoff: { providerInstanceId: target, ...kept } } as T;
}

/** The thread with what the opt-in just did recorded on it. */
export function withUsageLimitHandoffOutcome<T extends WithUsageLimitHandoff>(
  thread: T,
  last: ThreadUsageLimitHandoffOutcome,
): T {
  if (thread.usageLimitHandoff === undefined) return thread;
  return { ...thread, usageLimitHandoff: { ...thread.usageLimitHandoff, last } };
}
