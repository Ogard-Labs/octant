import type { HostRestartRecovery } from "@octant/contracts/host-control";

/** A thread this window can open, as its navigation lists it. */
export interface RestartNoticeThread {
  readonly mode: HostRestartRecovery["continued"][number]["mode"];
  readonly threadId: string;
  readonly title: string;
  /** Absent for a Chat thread outside any Project. */
  readonly projectId?: string;
}

export interface HostRestartNotice {
  /** Stable for one start of the host, so a dismissed notice stays dismissed. */
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Whether a thread waits for the person. */
  readonly needsYou: boolean;
  /** What the notice's link opens: the first thread that needs the person, else the first continued. */
  readonly open?: RestartNoticeThread;
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * What the person hears about the threads a restart cut off. Only threads
 * this window can open are counted or named: the host reports every thread,
 * and a window must not learn of one it may not see.
 */
export function hostRestartNotice(
  recovery: HostRestartRecovery | undefined,
  threads: ReadonlyArray<RestartNoticeThread>,
): HostRestartNotice | undefined {
  if (recovery === undefined) return undefined;
  const key = (entry: { readonly mode: string; readonly threadId: string }) =>
    `${entry.mode}:${entry.threadId}`;
  const visible = new Map(threads.map((thread) => [key(thread), thread]));
  const continued = recovery.continued.flatMap((entry) => {
    const thread = visible.get(key(entry));
    return thread === undefined ? [] : [thread];
  });
  const held = recovery.held.flatMap((entry) => {
    const thread = visible.get(key(entry));
    return thread === undefined ? [] : [{ thread, detail: entry.detail, reason: entry.reason }];
  });
  if (continued.length + held.length === 0) return undefined;
  // A person's quit holds every turn it cut off, so nothing was continued and
  // "restarted" would misdescribe what they did.
  const quit = held.some((entry) => entry.reason === "quit");
  const summary = quit
    ? `${count(held.length, "thread waits", "threads wait")} for you.`
    : `Continued ${count(continued.length, "thread", "threads")}; ${held.length} ${held.length === 1 ? "needs" : "need"} you.`;
  const first = held[0];
  const open = first?.thread ?? continued[0];
  return {
    id: `restart:${recovery.at}`,
    title: quit ? "Octant was quit while threads were working" : "Octant restarted",
    detail: first === undefined ? summary : `${summary} ${first.thread.title}: ${first.detail}`,
    needsYou: first !== undefined,
    ...(open === undefined ? {} : { open }),
  };
}
