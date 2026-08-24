import { canRunHostAction, type HostAction, type LocalHostSnapshot } from "./hostLifecycle";

export interface MenuBarItem {
  readonly id:
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

export function buildMenuBarItems(snapshot: LocalHostSnapshot): ReadonlyArray<MenuBarItem> {
  return [
    { id: "status", label: `Host: ${stateLabel(snapshot)}`, enabled: false },
    { id: "activity", label: `Active agents: ${snapshot.activeAgentCount}`, enabled: false },
    ...(snapshot.attentionRequired
      ? [{ id: "attention" as const, label: "Attention needed", enabled: false }]
      : []),
    { id: "open-app", label: "Open Octant", enabled: true },
    { id: "open-web", label: "Open local web app", enabled: snapshot.state !== "stopped" },
    { id: "start-new-agent", label: "Start new agent", enabled: snapshot.state !== "stopped" },
    { id: "start-host", label: "Start local host", enabled: actionEnabled(snapshot, "start") },
    { id: "stop-host", label: "Stop local host", enabled: actionEnabled(snapshot, "stop") },
    {
      id: "restart-host",
      label: "Restart local host",
      enabled: actionEnabled(snapshot, "restart"),
    },
    { id: "diagnostics", label: "Open redacted diagnostics", enabled: true },
    { id: "fully-quit", label: "Fully quit Octant", enabled: true },
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
