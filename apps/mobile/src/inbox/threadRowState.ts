import type { MobileInboxRow, MobileRowPullRequests } from "@octant/client-runtime";
import { inboxWorkStatus } from "./inboxWorkPresentation";

export type ThreadRowKind =
  | "waiting"
  | "failed"
  | "finished"
  | "review"
  | "working"
  | "idle"
  | "settled";

export interface ThreadRowState {
  readonly kind: ThreadRowKind;
  /** What the row shows: the state in words, or a working or quiet thread's age. */
  readonly word: string;
  /** What a screen reader hears, where the word alone would not say it. */
  readonly spoken: string;
}

/** An age as short as a row has room for. */
export function compactAge(at: string, now: Date): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - time) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function threadRowState(row: MobileInboxRow, now: Date): ThreadRowState {
  const said = (kind: ThreadRowKind, word: string): ThreadRowState => ({
    kind,
    word,
    spoken: word,
  });
  if (row.completedAt !== undefined) {
    const age = compactAge(row.completedAt, now);
    return { kind: "settled", word: age, spoken: `Settled ${age} ago` };
  }
  if (row.waitingAsk !== undefined) return said("waiting", row.waitingAsk.label);
  if (row.live === "needs-input") return said("waiting", "Needs you");
  if (row.reviewState === "changes-requested") return said("waiting", "Changes requested");
  const age = compactAge(row.freshness, now);
  if (row.live === "working") return { kind: "working", word: age, spoken: `Working, ${age}` };
  // A finished turn nobody has looked at since says so before its review does.
  if (row.unread === true && !/fail|error|interrupt/i.test(row.status))
    return said("finished", "Finished");
  if (row.reviewState === "pending") return said("review", "In review");
  if (row.reviewState === "approved") return said("review", "Approved");
  const status = inboxWorkStatus(row.status, row.reviewState, row.live);
  if (status === "Needs attention") {
    const failed = /fail|error|interrupt/i.test(row.status);
    return failed ? said("failed", "Failed") : said("waiting", "Needs you");
  }
  if (status === "Working") return { kind: "working", word: age, spoken: `Working, ${age}` };
  return { kind: "idle", word: age, spoken: age === "" ? "" : `${age} ago` };
}

/** Two letters that stand for a Project beside its threads. */
export function projectMonogram(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  const [first, second] = words;
  if (first === undefined) return "";
  return (
    second === undefined ? first.slice(0, 2) : `${first.charAt(0)}${second.charAt(0)}`
  ).toUpperCase();
}

export function pullRequestChip(pullRequests: MobileRowPullRequests): string {
  return pullRequests.count === 1 ? String(pullRequests.number) : `+${pullRequests.count}`;
}
