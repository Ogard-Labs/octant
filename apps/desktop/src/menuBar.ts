import { canRunHostAction, type HostAction, type LocalHostSnapshot } from "./hostLifecycle";

export interface MenuBarTask {
  readonly threadId: string;
  readonly mode: "chat" | "work" | "code";
  readonly title: string;
  readonly activity: "working" | "attention" | "unread";
}

export interface WindowMenuBarTask extends MenuBarTask {
  readonly windowId: number;
}

export function decodeMenuBarTasks(value: unknown): ReadonlyArray<MenuBarTask> {
  if (!Array.isArray(value) || value.length > 18) throw new TypeError("Invalid menu tasks");
  return value.map((task: unknown) => {
    if (
      typeof task !== "object" ||
      task === null ||
      !("threadId" in task) ||
      typeof task.threadId !== "string" ||
      task.threadId.length === 0 ||
      task.threadId.length > 128 ||
      !("title" in task) ||
      typeof task.title !== "string" ||
      task.title.length > 200 ||
      !("mode" in task) ||
      (task.mode !== "chat" && task.mode !== "work" && task.mode !== "code") ||
      !("activity" in task) ||
      (task.activity !== "working" && task.activity !== "attention" && task.activity !== "unread")
    ) {
      throw new TypeError("Invalid menu task");
    }
    return {
      threadId: task.threadId,
      title: task.title.replace(/[\r\n\t]/g, " "),
      mode: task.mode,
      activity: task.activity,
    };
  });
}

export interface MenuBarItem {
  readonly id:
    | "task"
    | "separator"
    | "local-host"
    | "status"
    | "activity"
    | "attention"
    | "open-app"
    | "open-web"
    | "start-new-agent"
    | "start-host"
    | "stop-host"
    | "restart-host"
    | "diagnostics"
    | "fully-quit";
  readonly task?: WindowMenuBarTask;
  readonly submenu?: ReadonlyArray<MenuBarItem>;
  readonly label: string;
  readonly enabled: boolean;
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
  tasks: ReadonlyArray<WindowMenuBarTask> = [],
): ReadonlyArray<MenuBarItem> {
  const separator: MenuBarItem = { id: "separator", label: "", enabled: false };
  const taskItems: MenuBarItem[] = [];
  if (snapshot.state !== "stopped") {
    const unique = [
      ...new Map(tasks.map((task) => [`${task.mode}:${task.threadId}`, task])).values(),
    ];
    for (const [activity, label] of [
      ["attention", "Needs attention"],
      ["working", "Running"],
      ["unread", "Unread"],
    ] as const) {
      const group = unique.filter((task) => task.activity === activity);
      if (group.length === 0) continue;
      taskItems.push(separator, {
        id: "activity",
        label: `${label} · ${group.length}`,
        enabled: false,
      });
      for (const task of group.slice(0, 6)) {
        taskItems.push({
          id: "task",
          label: task.title.length > 52 ? `${task.title.slice(0, 51)}…` : task.title,
          enabled: true,
          task,
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
