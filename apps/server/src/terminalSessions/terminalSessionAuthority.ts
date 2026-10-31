import { readPrincipalRouteContext } from "../principalRouteContext";

/** What a paired device is told when it tries to start a thread from a terminal session. */
export const TERMINAL_SESSION_LOCAL_ONLY =
  "Only the Octant window on this host can start a thread from a terminal session.";

/**
 * Whether a create command would read a terminal session for anyone but a
 * window on this host. The sessions are files in the person's home folder, and
 * the list and history routes already refuse a paired device; creation reads
 * the same files and hands them to the thread's model, so it is the same
 * local-only step.
 */
export function refusesTerminalSessionImport(
  request: Request,
  command: { readonly terminalSession?: unknown },
): boolean {
  if (command.terminalSession === undefined) return false;
  const principal = readPrincipalRouteContext(request)?.principal;
  return principal !== undefined && principal.kind !== "local-window";
}
