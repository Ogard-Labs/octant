import type { LocalHostSnapshot } from "./hostLifecycle";

/**
 * The host's loopback route that records a person's quit. The host holds the
 * turns this quit cuts off at its next start instead of continuing them
 * (docs/architecture.md, restart recovery); only this desktop's bridge secret
 * reaches it.
 */
export const PERSON_QUIT_ROUTE = "/api/desktop/person-quit";

/** The report rides the quit; a host that does not answer quickly is left to continue. */
export const PERSON_QUIT_REPORT_BOUND_MS = 1_000;

export interface PersonQuitReportInput {
  /** The quit came from the person: the menu, ⌘Q, or closing the last window where that quits. */
  readonly interactive: boolean;
  /** The system announced a restart, shutdown or session end before or during this quit. */
  readonly systemShuttingDown: boolean;
  readonly host: Pick<LocalHostSnapshot, "state" | "ownership" | "url">;
}

/**
 * Whether this quit is one the host should not continue after. Only a
 * person's quit of a host this app stops counts: a quit the system asked for
 * (a restart, a shutdown, a logout, a signal) continues like a crash, and a
 * background service host keeps running through the quit, so nothing it runs
 * is cut off.
 */
export function quitStopsHostForPerson(input: PersonQuitReportInput): boolean {
  return (
    input.interactive &&
    !input.systemShuttingDown &&
    input.host.ownership === "desktop-owned" &&
    input.host.state !== "stopped" &&
    input.host.url !== undefined
  );
}

/**
 * Tells the host this quit is a person's, when it is. Never rejects and never
 * holds the quit past its bound: a report that does not land leaves the host
 * continuing its cut-off turns, which is what a crash does.
 */
export async function reportPersonQuit(
  input: PersonQuitReportInput & {
    readonly brokerHeaders: Readonly<Record<string, string>>;
    readonly fetch: typeof globalThis.fetch;
    readonly boundMs?: number;
  },
): Promise<"recorded" | "not-a-person-quit" | "failed"> {
  if (!quitStopsHostForPerson(input) || input.host.url === undefined) return "not-a-person-quit";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.boundMs ?? PERSON_QUIT_REPORT_BOUND_MS);
  try {
    const response = await input.fetch(new URL(PERSON_QUIT_ROUTE, input.host.url), {
      method: "POST",
      headers: input.brokerHeaders,
      signal: controller.signal,
    });
    return response.ok ? "recorded" : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/** The system events that mean a quit is the machine's, not the person's. */
export interface SystemShutdownSources {
  /** Electron's `powerMonitor`: `shutdown` fires on macOS and Linux. */
  readonly powerMonitor: { readonly on: (event: "shutdown", listener: () => void) => unknown };
  /** Windows reports a session end to each window, not to the app. */
  readonly onSessionEnd: (listener: () => void) => void;
}

/**
 * Remembers that the system is restarting, shutting down or ending the
 * session. It only ever latches: the app is leaving either way.
 */
export function watchSystemShutdown(sources: SystemShutdownSources): () => boolean {
  let shuttingDown = false;
  const latch = () => {
    shuttingDown = true;
  };
  sources.powerMonitor.on("shutdown", latch);
  sources.onSessionEnd(latch);
  return () => shuttingDown;
}
