import { shouldConfirmQuit, type LocalHostSnapshot } from "./hostLifecycle";

export interface QuitConfirmationCopy {
  readonly title: "Quit Octant?";
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly ["Cancel", "Quit and stop work"];
  readonly defaultId: 0;
  readonly cancelId: 0;
}

export function buildQuitConfirmation(snapshot: LocalHostSnapshot): QuitConfirmationCopy {
  const message =
    snapshot.activeAgentCount === 1
      ? "1 active agent turn will be interrupted."
      : snapshot.activeAgentCount > 1
        ? `${String(snapshot.activeAgentCount)} active agent turns will be interrupted.`
        : "Active Octant work may be interrupted.";
  return {
    title: "Quit Octant?",
    message,
    detail: "Fully quitting stops the desktop-owned local host and its running work.",
    buttons: ["Cancel", "Quit and stop work"],
    defaultId: 0,
    cancelId: 0,
  };
}

export async function evaluateQuitRequest(options: {
  readonly refreshActivity: () => Promise<void>;
  readonly snapshot: () => LocalHostSnapshot;
  readonly confirm: (snapshot: LocalHostSnapshot) => Promise<boolean>;
}): Promise<boolean> {
  let refreshFailed = false;
  try {
    await options.refreshActivity();
  } catch {
    refreshFailed = true;
  }
  const snapshot = options.snapshot();
  const activeOwnedHost = snapshot.state !== "stopped" && snapshot.ownership === "desktop-owned";
  if (!shouldConfirmQuit(snapshot) && !(refreshFailed && activeOwnedHost)) return true;
  return options.confirm(snapshot);
}
