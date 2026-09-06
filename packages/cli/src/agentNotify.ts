import { spawn } from "node:child_process";

/**
 * A desktop notice that a turn finished, for the person who switched away.
 * Best effort on the platforms with a notifier at hand; silence elsewhere.
 */
export function notifyDesktop(title: string, body: string): void {
  const quiet = { stdio: "ignore" as const, detached: true };
  try {
    if (process.platform === "darwin") {
      const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      spawn(
        "osascript",
        ["-e", `display notification "${escape(body)}" with title "${escape(title)}"`],
        quiet,
      ).unref();
    } else if (process.platform === "linux") {
      spawn("notify-send", [title, body], quiet).unref();
    }
  } catch {
    // No notifier on this host; the screen still shows the outcome.
  }
}
