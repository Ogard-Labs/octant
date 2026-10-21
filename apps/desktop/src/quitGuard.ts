import { shouldConfirmQuit, workInFlight, type LocalHostSnapshot } from "./hostLifecycle";

export interface QuitConfirmationCopy {
  readonly title: "Quit Octant?";
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly ["Cancel", "Quit and stop work"];
  readonly defaultId: 0;
  readonly cancelId: 0;
}

export function buildQuitConfirmation(snapshot: LocalHostSnapshot): QuitConfirmationCopy {
  const sessionsConfirmed = snapshot.activityUnconfirmed !== true && snapshot.activeAgentCount > 0;
  const message = !sessionsConfirmed
    ? "Active Octant work may be interrupted."
    : snapshot.activeAgentCount === 1
      ? "1 provider session is still open."
      : `${String(snapshot.activeAgentCount)} provider sessions are still open.`;
  return {
    title: "Quit Octant?",
    message,
    detail: sessionsConfirmed
      ? "Quitting closes these sessions and stops any running work on this local host."
      : "Fully quitting stops the desktop-owned local host and its running work.",
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
  const work = await workInFlight(options);
  const snapshot = options.snapshot();
  if (!shouldConfirmQuit(snapshot, work)) return true;
  return options.confirm({ ...snapshot, activityUnconfirmed: work.activityUnconfirmed });
}
