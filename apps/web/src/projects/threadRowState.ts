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
import { CircleAlert, CirclePause, Clock, ClockFading, LoaderCircle } from "../ui/icons";
import type { IconComponent } from "../ui/icons";
import type { SidebarThreadRowState } from "./SidebarThreadRowContent";
import { threadRowShortAge } from "./threadRowShortAge";

/**
 * The mark one status wears beside its short age. `unread` and `idle` have none: the stylesheet
 * draws unread as a dot and idle as nothing at all, so an icon here would be a
 * second, louder reading of the same state.
 */
export function sidebarThreadStatusIcon(status: SidebarThreadStatus): IconComponent | undefined {
  switch (status) {
    case "working":
      return LoaderCircle;
    // A thread that waits on the person is paused, not failing: the alert
    // mark is kept for a usage limit, which the person cannot answer.
    case "attention":
      return CirclePause;
    case "limited":
      return CircleAlert;
    case "waiting":
      return ClockFading;
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

/** How long until a known reset, "2h"; nothing when the host named none or it is due. */
function limitedAge(resetsAt: string | undefined, now: number): string | undefined {
  const age =
    resetsAt === undefined ? undefined : snoozeWakeLabel(resetsAt, new Date(now).toISOString());
  return age === "now" ? undefined : age;
}

/** A short age, or nothing for one under a minute, which "now" would only repeat. */
function shortAgeSince(since: string | undefined, now: number): string | undefined {
  const age = since === undefined ? undefined : threadRowShortAge(since, now);
  return age === "now" ? undefined : age;
}

const AGE_UNITS: Readonly<Record<string, string>> = {
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
  y: "year",
};

/** "5m" as "5 minutes", for a name read aloud; anything else is kept as it is. */
function spokenAge(age: string): string {
  const match = /^(\d+)([mhdwy])$/.exec(age);
  const count = match?.[1];
  const unit = match?.[2] === undefined ? undefined : AGE_UNITS[match[2]];
  if (count === undefined || unit === undefined) return age;
  return `${count} ${unit}${count === "1" ? "" : "s"}`;
}

/** A row that hides its status says nothing of it. */
export const NO_THREAD_ROW_STATE: ThreadRowStateReading = { unread: false };

/**
 * What a row says of its thread's state: a mark and a short age, with the
 * state in words for its tooltip and accessible name. The age is how long a
 * turn has run ("Working 14m" draws a spinner and "14m"), how long the thread
 * has waited on the person (the time it last moved), or how long a usage limit
 * still holds it, counting down to the reset. A snooze that ended has no age
 * and draws its mark alone. A thread with none of those states has none to
 * say, and its row ends with how long ago it moved; new activity alone is a
 * dot beside that time. One state is shown, the strongest, as in the status
 * policy.
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
  /** When the thread began waiting between turns; absent when it is not. */
  readonly waitingSince?: string | undefined;
  /** When the thread last moved, which a Needs-you row counts from. */
  readonly updatedAt?: string | undefined;
}): ThreadRowStateReading {
  const now = props.now ?? Date.now();
  const facts = sidebarThreadStatusInput({ ...props, now });
  const status = resolveSidebarThreadStatus(facts);
  if (status === undefined) return { unread: false };
  const statuses = sidebarThreadStatuses(facts).map((each) => SIDEBAR_THREAD_STATUS_LABEL[each]);
  const followUp = props.followUp === true ? ["Follow-up"] : [];
  if (status === "unread") return { unread: true, label: [...statuses, ...followUp].join(", ") };
  const word = SIDEBAR_THREAD_STATUS_LABEL[status];
  const age =
    status === "working"
      ? shortAgeSince(props.startedAt, now)
      : status === "waiting"
        ? shortAgeSince(props.waitingSince, now)
        : status === "attention"
          ? shortAgeSince(props.updatedAt, now)
          : status === "limited"
            ? limitedAge(props.limited?.resetsAt, now)
            : undefined;
  const text =
    status === "working" || status === "waiting"
      ? age === undefined
        ? word
        : `${word} ${age}`
      : status === "attention"
        ? "Needs you"
        : status === "limited"
          ? age === undefined
            ? word
            : `${word} ${age}`
          : "Snooze ended";
  // The row draws the age beside a mark, so its accessible name says it in
  // words after the status it belongs to: "Working, 5 minutes".
  const spoken = age === undefined ? undefined : spokenAge(age);
  const label = [
    ...statuses.map((each) =>
      each !== word || spoken === undefined
        ? each
        : status === "limited"
          ? `${each}, resets in ${spoken}`
          : `${each}, ${spoken}`,
    ),
    ...followUp,
  ].join(", ");
  return {
    state: {
      status,
      text,
      ...(age === undefined ? {} : { age }),
      icon: sidebarThreadStatusIcon(status),
    },
    unread: false,
    label,
  };
}
