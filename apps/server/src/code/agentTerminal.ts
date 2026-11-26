import type { TerminalLaunchRequest, TerminalService } from "./terminalService";
import { terminalSnapshot, type AgentTerminalPort } from "./codeAppManagedTools";

/** Everything about one launch but which terminal it is. */
export type AgentTerminalLaunch = Omit<
  TerminalLaunchRequest,
  "terminalId" | "columns" | "rows" | "credentialReferences"
>;

/**
 * One agent's own terminal over the host's terminal service, for a caller with
 * no Code thread of its own: a child run in its worktree, or a Work thread in
 * its folder. The launch is asked for when one starts, so the folder, level
 * and confinement are those of that moment, and a launch the caller may no
 * longer make starts nothing. It carries no credentials.
 */
export function createAgentTerminal(options: {
  readonly terminals: Pick<TerminalService, "launch" | "attach" | "write" | "terminate">;
  readonly terminalId: string;
  /** The launch as it may start now, or why it may not. */
  readonly launch: () => Promise<AgentTerminalLaunch | { readonly refused: string }>;
}): { readonly port: AgentTerminalPort; readonly close: () => Promise<void> } {
  const { terminals, terminalId } = options;
  let started = false;
  let closed = false;
  let launching: Promise<unknown> | undefined;
  const answer = (error: string, message?: string) => ({
    result: { error, ...(message === undefined ? {} : { message }) },
    isError: true,
  });
  const read = async () => {
    if (!started) throw new Error("No terminal was started.");
    return terminals.attach(terminalId);
  };
  const terminate = async () => {
    if (!started) return;
    await terminals.terminate(terminalId);
  };
  return {
    port: {
      read,
      start: async () => {
        const launch = await options.launch();
        if ("refused" in launch) return answer("terminal-unavailable", launch.refused);
        if (closed) return answer("tool-closed");
        started = true;
        try {
          const starting = terminals.launch({
            ...launch,
            terminalId,
            columns: 100,
            rows: 30,
            credentialReferences: [],
          });
          launching = starting;
          const snapshot = await starting;
          return snapshot.status === "running" ? undefined : terminalSnapshot(snapshot);
        } catch (error) {
          started = false;
          return answer(
            "terminal-unavailable",
            error instanceof Error ? error.message : "The terminal could not start.",
          );
        }
      },
      write: async (data) => {
        try {
          terminals.write(terminalId, data);
          return undefined;
        } catch {
          return answer("terminal-unavailable");
        }
      },
      stop: async () => {
        if (!started) return answer("unavailable", "Terminal is unavailable.");
        return terminalSnapshot(await terminals.terminate(terminalId));
      },
      interrupt: async () => {
        terminals.write(terminalId, "\u0003");
        return read();
      },
      terminate,
    },
    close: async () => {
      closed = true;
      // A shell still starting as the caller ends is stopped once it has.
      try {
        await launching?.catch(() => undefined);
        await terminate();
      } finally {
        // A caller that may act again later starts a fresh shell.
        started = false;
        launching = undefined;
        closed = false;
      }
    },
  };
}
