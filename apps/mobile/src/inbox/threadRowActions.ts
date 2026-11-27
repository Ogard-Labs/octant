import type { MobileInboxRow, MobileThreadRestAction } from "@octant/client-runtime";
import {
  decideCompleteThread,
  decideSnoozeThread,
  resolveSnoozePresets,
  type RestingThreadLifecycle,
} from "@octant/domain/thread-completion-policy";
import type { MobileIconName } from "../ui/symbols";
import { mobileThreadShelf } from "./threadArrangement";

const REFUSAL: Readonly<Record<string, string>> = {
  archived: "This thread is archived.",
  executing: "A turn is running. Settle it when it finishes.",
  "awaiting-input": "The agent is waiting on you. Answer it first.",
  "wake-time-not-in-future": "Pick a later time.",
};

export interface ThreadRowAction {
  readonly id: string;
  readonly label: string;
  readonly icon: MobileIconName;
  /** When a snooze would wake it. */
  readonly value?: string;
  readonly run: MobileThreadRestAction;
}

/** An action the row offers, a choice of times, or why the host would refuse it. */
export type ThreadRowActionOffer =
  | { readonly kind: "action"; readonly action: ThreadRowAction }
  | {
      readonly kind: "choice";
      readonly label: string;
      readonly actions: ReadonlyArray<ThreadRowAction>;
    }
  | {
      readonly kind: "refused";
      readonly id: string;
      readonly label: string;
      readonly icon: MobileIconName;
      readonly reason: string;
    };

/**
 * What a thread row offers on the phone: the desktop row menu's Snooze or
 * Wake, Settle or Un-settle, and (Code only) Pin.
 */
export function threadRowActions(
  row: MobileInboxRow,
  now: Date,
): ReadonlyArray<ThreadRowActionOffer> {
  const lifecycle = row.status as RestingThreadLifecycle;
  const awaitingInput = row.live === "needs-input";
  const shelf = mobileThreadShelf(row, now);
  return [
    snoozeOffer(row, shelf, lifecycle, awaitingInput, now),
    settleOffer(shelf, lifecycle, row.live === "working", awaitingInput),
    ...(row.mode === "code"
      ? [
          {
            kind: "action" as const,
            action: {
              id: "pin",
              label: row.pinned === true ? "Unpin" : "Pin",
              icon: row.pinned === true ? ("pin" as const) : ("pin-outline" as const),
              run: { kind: "pin" as const, pinned: row.pinned !== true },
            },
          },
        ]
      : []),
  ];
}

function snoozeOffer(
  row: MobileInboxRow,
  shelf: string,
  lifecycle: RestingThreadLifecycle,
  awaitingInput: boolean,
  now: Date,
): ThreadRowActionOffer {
  if (row.snooze !== undefined && shelf === "snoozed")
    return {
      kind: "action",
      action: { id: "wake", label: "Wake now", icon: "alarm-outline", run: { kind: "wake" } },
    };
  const allowed = decideSnoozeThread({
    lifecycle,
    awaitingInput,
    until: new Date(now.getTime() + 3_600_000).toISOString(),
    now: now.toISOString(),
  });
  if (allowed.status === "refused")
    return {
      kind: "refused",
      id: "snooze",
      label: "Snooze",
      icon: "time-outline",
      reason: REFUSAL[allowed.reason] ?? "This thread cannot be snoozed.",
    };
  return {
    kind: "choice",
    label: "Snooze",
    actions: resolveSnoozePresets(now).map((preset) => ({
      id: `snooze-${preset.id}`,
      label: preset.label,
      icon: "time-outline",
      value: preset.whenLabel,
      run: { kind: "snooze", until: preset.until },
    })),
  };
}

function settleOffer(
  shelf: string,
  lifecycle: RestingThreadLifecycle,
  executing: boolean,
  awaitingInput: boolean,
): ThreadRowActionOffer {
  if (shelf === "completed")
    return {
      kind: "action",
      action: {
        id: "reopen",
        label: "Un-settle",
        icon: "arrow-undo-outline",
        run: { kind: "reopen" },
      },
    };
  const complete = decideCompleteThread({ executing, awaitingInput, lifecycle });
  return complete.status === "refused"
    ? {
        kind: "refused",
        id: "put-away",
        label: "Settle",
        icon: "checkmark-done-outline",
        reason: REFUSAL[complete.reason] ?? "This thread cannot be settled.",
      }
    : {
        kind: "action",
        action: {
          id: "put-away",
          label: "Settle",
          icon: "checkmark-done-outline",
          run: { kind: "put-away" },
        },
      };
}
