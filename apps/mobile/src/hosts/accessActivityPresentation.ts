import { MOBILE_THREAD_LEVEL_LABELS } from "@octant/client-runtime";
import type {
  AccessActivityEntry,
  AccessChangeActor,
  ChangeNotice,
} from "@octant/contracts/access-activity";
import { DEVICE_ACCESS_LEVEL_LABELS } from "@octant/contracts/remote-access";

/**
 * The words the phone uses for access activity and change notices
 * (maintainer decision, 2026-11-22), the same the desktop's lists use. The
 * host decides who sees them; this only says what each row means.
 */

const REMOVAL_WORDS: Readonly<
  Record<Extract<AccessActivityEntry, { kind: "removed" }>["reason"], string>
> = {
  revoked: "removed",
  "signed-out": "signed out with every other device",
  "self-revoked": "removed itself",
  expired: "pairing expired",
  "host-key-recovered": "removed when this computer's key was recovered",
  "pairing-abandoned": "removed automatically: pairing never finished",
};

export const ACCESS_ACTIVITY_EMPTY = "No devices added, removed or re-levelled yet";

export function describeAccessEntry(entry: AccessActivityEntry): string {
  switch (entry.kind) {
    case "added":
      return `${entry.deviceLabel} added at ${DEVICE_ACCESS_LEVEL_LABELS[entry.accessLevel]}`;
    case "relevelled":
      return `${entry.deviceLabel} changed from ${DEVICE_ACCESS_LEVEL_LABELS[entry.previousLevel]} to ${DEVICE_ACCESS_LEVEL_LABELS[entry.accessLevel]}`;
    case "removed":
      return `${entry.deviceLabel} ${REMOVAL_WORDS[entry.reason]}`;
  }
}

/** Who made a change, in the words a row's meta line uses. */
export function accessActorPhrase(actor: AccessChangeActor): string {
  switch (actor.kind) {
    case "local-person":
      return "By you on this computer";
    case "host":
      return "By this computer";
    case "owner-device":
      return "By an owner device";
    case "device":
      return `By ${actor.label}`;
    case "agent":
      return `By the agent ${actor.name}`;
  }
}

/** One line naming who changed what. */
export function describeChangeNotice(notice: ChangeNotice): string {
  const who = notice.actor.kind === "agent" ? `The agent ${notice.actor.name}` : notice.actor.label;
  if (notice.kind === "thread-level-raised") {
    const thread = notice.threadTitle === undefined ? "a thread" : `“${notice.threadTitle}”`;
    return `${who} raised ${thread} from ${MOBILE_THREAD_LEVEL_LABELS[notice.from]} to ${MOBILE_THREAD_LEVEL_LABELS[notice.to]}`;
  }
  const provider = notice.providerName ?? "a provider";
  return notice.kind === "provider-key-added"
    ? `${who} added a key for ${provider}`
    : `${who} replaced the key for ${provider}`;
}

/** The actions a notice offers, which are the ones the host takes for it. */
export interface ChangeNoticeActions {
  /** A replaced key has no Undo, since the earlier key is not kept. */
  readonly undo: boolean;
  readonly noUndoReason?: string;
  readonly revokeLabel: string;
  /** What Revoke asks before it runs, since it cannot be taken back from here. */
  readonly revokeTitle: string;
  readonly revokeConsequence: string;
  readonly revokeConfirmLabel: string;
}

export function changeNoticeActions(notice: ChangeNotice): ChangeNoticeActions {
  const agent = notice.actor.kind === "agent";
  const name = notice.actor.kind === "agent" ? notice.actor.name : notice.actor.label;
  return {
    undo: notice.kind !== "provider-key-replaced",
    ...(notice.kind === "provider-key-replaced"
      ? { noUndoReason: "No Undo: the earlier key is not kept." }
      : {}),
    revokeLabel: agent ? `End ${name}'s access` : `Revoke ${name}`,
    revokeTitle: agent ? `End ${name}'s access?` : `Revoke ${name}?`,
    revokeConsequence: agent
      ? "The agent's access to this computer ends now."
      : "The device loses access to this computer and must pair again to return.",
    revokeConfirmLabel: agent ? "End access" : "Revoke device",
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long ago, in words a glance reads; the time itself when it cannot be read. */
export function relativeTimeLabel(at: string, now: number = Date.now()): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return at;
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}
