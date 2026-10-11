import type {
  FleetActivity,
  FleetActivitySource,
  FleetActivityThread,
} from "@octant/contracts/fleet-activity";
import { canRunHostAction, type HostAction, type LocalHostSnapshot } from "./hostLifecycle";

export type MenuBarThreadMode = FleetActivityThread["mode"];

/** A thread a window shows, or the one a menu-bar row opens. */
export interface MenuBarOpenThread {
  readonly mode: MenuBarThreadMode;
  readonly threadId: string;
}

/** A window's report of the thread it shows; `undefined` when it shows none. */
export function decodeMenuBarOpenThread(value: unknown): MenuBarOpenThread | undefined {
  if (value === null) return undefined;
  if (
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    !("mode" in value) ||
    (value.mode !== "chat" && value.mode !== "work" && value.mode !== "code") ||
    !("threadId" in value) ||
    typeof value.threadId !== "string" ||
    value.threadId.length === 0 ||
    value.threadId.length > 128
  ) {
    throw new TypeError("Invalid menu thread");
  }
  return { mode: value.mode, threadId: value.threadId };
}

export interface MenuBarFleetThread {
  readonly mode: MenuBarThreadMode;
  readonly threadId: string;
  readonly title: string;
  readonly projectName?: string;
  readonly state: "needs-you" | "working" | "done";
  readonly activitySource: FleetActivitySource;
}

const MAX_DONE_THREADS = 32;

function fleetThread(
  thread: FleetActivityThread,
  state: MenuBarFleetThread["state"],
): MenuBarFleetThread {
  return {
    mode: thread.mode,
    threadId: thread.threadId,
    title: thread.title,
    ...(thread.projectName === undefined ? {} : { projectName: thread.projectName }),
    state,
    activitySource: thread.activitySource,
  };
}

function threadKey(thread: MenuBarOpenThread): string {
  return `${thread.mode}:${thread.threadId}`;
}

/**
 * The menu bar's roster, built from the host's fleet read.
 *
 * Needs-you and working are exactly what the host's journal and live sessions
 * reported on the latest read. Done since you looked is the one thing the host
 * cannot say, because only this app knows when the person last opened a
 * thread: a thread that left the host's list between two reads finished, and
 * it stays done until it is opened or runs again. A cut or failed read proves
 * nothing about a thread it left out, and a state seen only on a terminal's
 * screen is a guess, so neither can ever produce a done row.
 */
export class MenuBarFleet {
  #active = new Map<string, FleetActivityThread>();
  #done = new Map<string, MenuBarFleetThread>();

  /** Fold one successful host read; `watching` are threads a focused window shows. */
  observe(activity: FleetActivity, watching: ReadonlyArray<MenuBarOpenThread> = []): void {
    const next = new Map(activity.threads.map((thread) => [threadKey(thread), thread] as const));
    if (activity.truncated) {
      for (const [key, thread] of this.#active) if (!next.has(key)) next.set(key, thread);
    }
    const watched = new Set(watching.map(threadKey));
    const finished = new Map<string, MenuBarFleetThread>();
    for (const [key, previous] of this.#active) {
      if (next.has(key) || watched.has(key) || previous.activitySource === "screen") continue;
      finished.set(key, fleetThread(previous, "done"));
    }
    const done = new Map([...finished, ...this.#done]);
    for (const key of next.keys()) done.delete(key);
    this.#done = new Map([...done].slice(0, MAX_DONE_THREADS));
    this.#active = next;
  }

  /** The person opened this thread, so whatever finished there has been seen. */
  looked(thread: MenuBarOpenThread): void {
    this.#done.delete(threadKey(thread));
  }

  /** The host stopped or was replaced; nothing it said still holds. */
  clear(): void {
    this.#active = new Map();
    this.#done = new Map();
  }

  threads(): ReadonlyArray<MenuBarFleetThread> {
    return [
      ...[...this.#active.values()].map((thread) => fleetThread(thread, thread.state)),
      ...this.#done.values(),
    ];
  }
}

export interface MenuBarItem {
  readonly id:
    | "thread"
    | "separator"
    | "local-host"
    | "status"
    | "activity"
    | "open-app"
    | "open-web"
    | "start-new-agent"
    | "start-host"
    | "stop-host"
    | "restart-host"
    | "diagnostics"
    | "fully-quit";
  readonly thread?: MenuBarFleetThread;
  readonly toolTip?: string;
  readonly submenu?: ReadonlyArray<MenuBarItem>;
  readonly label: string;
  readonly enabled: boolean;
}

const MODE_LABELS: Record<MenuBarThreadMode, string> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};

function threadLabel(thread: MenuBarFleetThread): string {
  const title = thread.title.length > 44 ? `${thread.title.slice(0, 43)}…` : thread.title;
  const project =
    thread.projectName === undefined
      ? ""
      : ` · ${thread.projectName.length > 28 ? `${thread.projectName.slice(0, 27)}…` : thread.projectName}`;
  const screen = thread.activitySource === "screen" ? " · seen in terminal" : "";
  return `${title} — ${MODE_LABELS[thread.mode]}${project}${screen}`;
}

function threadToolTip(thread: MenuBarFleetThread): string {
  if (thread.activitySource === "screen") {
    return "Looks busy in a terminal pane · Octant does not notify for it";
  }
  const source = thread.activitySource === "session" ? "the live session" : "the journal";
  if (thread.state === "needs-you") return `Waiting on you · read from ${source}`;
  if (thread.state === "working") return `Running · read from ${source}`;
  return `Finished since you last opened it · read from ${source}`;
}

/**
 * The text beside the menu-bar glyph: `!` while the host itself needs
 * attention, otherwise how many threads wait on the person. A state seen only
 * on screen never counts.
 */
export function menuBarTitle(
  snapshot: LocalHostSnapshot,
  fleet: ReadonlyArray<MenuBarFleetThread>,
): string {
  if (snapshot.attentionRequired) return "!";
  const waiting = fleet.filter(
    (thread) => thread.state === "needs-you" && thread.activitySource !== "screen",
  ).length;
  return waiting === 0 ? "" : String(waiting);
}

function stateLabel(snapshot: LocalHostSnapshot): string {
  if (snapshot.state === "attention-required") return "Attention needed";
  if (snapshot.state === "running") return "Running";
  if (snapshot.state === "starting") return "Starting";
  return "Stopped";
}

function actionEnabled(snapshot: LocalHostSnapshot, action: HostAction): boolean {
  return canRunHostAction(snapshot, action);
}

export function buildMenuBarItems(
  snapshot: LocalHostSnapshot,
  fleet: ReadonlyArray<MenuBarFleetThread> = [],
): ReadonlyArray<MenuBarItem> {
  const separator: MenuBarItem = { id: "separator", label: "", enabled: false };
  const taskItems: MenuBarItem[] = [];
  if (snapshot.state !== "stopped") {
    for (const [state, label] of [
      ["needs-you", "Needs you"],
      ["working", "Working"],
      ["done", "Done since you looked"],
    ] as const) {
      const group = fleet.filter((thread) => thread.state === state);
      if (group.length === 0) continue;
      taskItems.push(separator, {
        id: "activity",
        label: `${label} · ${group.length}`,
        enabled: false,
      });
      for (const thread of group.slice(0, 6)) {
        taskItems.push({
          id: "thread",
          label: threadLabel(thread),
          toolTip: threadToolTip(thread),
          enabled: true,
          thread,
        });
      }
    }
  }
  return [
    { id: "open-app", label: "Open Octant", enabled: true },
    { id: "start-new-agent", label: "New task…", enabled: snapshot.state !== "stopped" },
    ...taskItems,
    separator,
    {
      id: "local-host",
      label: "Local host",
      enabled: true,
      submenu: [
        { id: "status", label: `Status: ${stateLabel(snapshot)}`, enabled: false },
        { id: "open-web", label: "Open local web app", enabled: snapshot.state !== "stopped" },
        separator,
        ...(snapshot.state === "stopped"
          ? [
              {
                id: "start-host" as const,
                label: "Start local host",
                enabled: actionEnabled(snapshot, "start"),
              },
            ]
          : [
              {
                id: "stop-host" as const,
                label: "Stop local host",
                enabled: actionEnabled(snapshot, "stop"),
              },
              {
                id: "restart-host" as const,
                label: "Restart local host",
                enabled: actionEnabled(snapshot, "restart"),
              },
            ]),
        separator,
        { id: "diagnostics", label: "Open redacted diagnostics", enabled: true },
      ],
    },
    separator,
    { id: "fully-quit", label: "Quit Octant", enabled: true },
  ];
}

export function formatRedactedHostDiagnostics(snapshot: LocalHostSnapshot): string {
  const origin = snapshot.url === undefined ? "unavailable" : safeOrigin(snapshot.url);
  return [
    "Octant host diagnostics",
    `State: ${stateLabel(snapshot)}`,
    `Ownership: ${snapshot.ownership ?? "unavailable"}`,
    `Endpoint: ${origin}`,
    `Active agents: ${snapshot.activeAgentCount}`,
    `Attention needed: ${snapshot.attentionRequired ? "yes" : "no"}`,
  ].join("\n");
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "unavailable";
  }
}
