import {
  resolveSidebarThreadStatus,
  sidebarThreadStatuses,
  SIDEBAR_THREAD_STATUS_LABEL,
} from "@octant/domain/sidebar-thread-status-policy";
import { snoozeWakeLabel } from "@octant/domain/thread-completion-policy";
import type { ThreadUsageLimited } from "@octant/contracts";
import type { SidebarThreadStatus } from "@octant/contracts/sidebar-thread-status";
import {
  sidebarThreadStatusInput,
  type ChatThreadNavigationItem,
  type ThreadRowActivity,
} from "../shell/navigationModel";
import { CircleAlert, Clock, LoaderCircle } from "../ui/icons";
import type { IconComponent } from "../ui/icons";
import type { SidebarThreadRowState } from "./SidebarThreadRowContent";
import { threadRowShortAge } from "./threadRowShortAge";

/**
 * The mark one status wears. `unread` and `idle` have none: the stylesheet
 * draws unread as a dot and idle as nothing at all, so an icon here would be a
 * second, louder reading of the same state.
 */
export function sidebarThreadStatusIcon(status: SidebarThreadStatus): IconComponent | undefined {
  switch (status) {
    case "working":
      return LoaderCircle;
    case "attention":
    case "limited":
      return CircleAlert;
    case "woke":
      return Clock;
    default:
      return undefined;
  }
}

export interface ThreadRowStateReading {
  readonly state?: SidebarThreadRowState;
  readonly unread: boolean;
  /** Every state the thread is in, for the row's one accessible name. */
  readonly label?: string;
}

/** "Limited 2h" while the host named a reset, "Limited" when it named none. */
function limitedText(resetsAt: string | undefined, now: number): string {
  const label = SIDEBAR_THREAD_STATUS_LABEL.limited;
  return resetsAt === undefined
    ? label
    : `${label} ${snoozeWakeLabel(resetsAt, new Date(now).toISOString())}`;
}

/** A row that hides its status says nothing of it. */
export const NO_THREAD_ROW_STATE: ThreadRowStateReading = { unread: false };

/**
 * What a row says of its thread's state, in words: how long a turn has run
 * ("Working 14m"), that the thread waits on the person ("Needs you"), that a
 * usage limit holds it ("Limited 2h", counting down to the reset), or that a
 * snooze ended. A thread with none of those has no state to say, and its row
 * ends with how long ago it moved; new activity alone is a dot beside that
 * time. One state is shown, the strongest, as in the status policy.
 */
export function threadRowState(props: {
  readonly activity: ThreadRowActivity;
  readonly unread: boolean;
  readonly woke: boolean;
  readonly followUp?: boolean;
  readonly startedAt?: string | undefined;
  readonly limited?: ThreadUsageLimited | undefined;
  readonly shelf?: ChatThreadNavigationItem["shelf"] | undefined;
  /** The row's minute clock, which the elapsed and remaining times read. */
  readonly now?: number | undefined;
}): ThreadRowStateReading {
  const now = props.now ?? Date.now();
  const facts = sidebarThreadStatusInput({ ...props, now });
  const status = resolveSidebarThreadStatus(facts);
  if (status === undefined) return { unread: false };
  const label = [
    ...sidebarThreadStatuses(facts).map((each) => SIDEBAR_THREAD_STATUS_LABEL[each]),
    ...(props.followUp === true ? ["Follow-up"] : []),
  ].join(", ");
  if (status === "unread") return { unread: true, label };
  const elapsed =
    status === "working" && props.startedAt !== undefined
      ? threadRowShortAge(props.startedAt, now)
      : undefined;
  const text =
    status === "working"
      ? elapsed === undefined || elapsed === "now"
        ? "Working"
        : `Working ${elapsed}`
      : status === "attention"
        ? "Needs you"
        : status === "limited"
          ? limitedText(props.limited?.resetsAt, now)
          : "Snooze ended";
  return {
    state: { status, text, icon: sidebarThreadStatusIcon(status) },
    unread: false,
    label,
  };
}
