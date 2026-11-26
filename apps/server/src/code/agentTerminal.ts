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
  readonly terminals: Pick<
    TerminalService,
    "launch" | "attach" | "write" | "terminate" | "agentCommand" | "noteAgentCommand"
  >;
  readonly terminalId: string;
  /** The launch as it may start now, or why it may not. */
  readonly launch: () => Promise<AgentTerminalLaunch | { readonly refused: string }>;
}): { readonly port: AgentTerminalPort; readonly close: () => Promise<void> } {
  const { terminals, terminalId } = options;
  let closed = false;
  // Each close begins a new generation; a start that began before it starts nothing.
  let generation = 0;
  let launching: Promise<unknown> | undefined;
  const answer = (error: string, message?: string) => ({
    result: { error, ...(message === undefined ? {} : { message }) },
    isError: true,
  });
  // Read by id, so a terminal one turn started is the next turn's too.
  const read = async () => terminals.attach(terminalId);
  const terminate = async () => {
    try {
      await terminals.terminate(terminalId);
    } catch {
      // Nothing was started under this id, or it is already gone.
    }
  };
  return {
    port: {
      read,
      start: async () => {
        const began = generation;
        const launch = await options.launch();
        if ("refused" in launch) return answer("terminal-unavailable", launch.refused);
        // The scope the launch prepared stays ours to release until the
        // service has started the shell: a launch that never reaches it, or
        // fails before it keeps a record, would leave the terminal's id
        // admitted, and every later start refused as still stopping.
        const release = async () => {
          await launch.onClosed?.().catch(() => undefined);
        };
        if (closed || began !== generation) {
          await release();
          return answer("tool-closed");
        }
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
          // Releasing twice is safe: a launch that failed after keeping its
          // record has already released it.
          await release();
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
        try {
          return terminalSnapshot(await terminals.terminate(terminalId));
        } catch {
          return answer("unavailable", "Terminal is unavailable.");
        }
      },
      interrupt: async () => {
        terminals.write(terminalId, "\u0003");
        return read();
      },
      terminate,
      // Kept with the terminal, so a later turn's tools see the shell it
      // started in and a command an earlier run left running.
      agentCommand: {
        read: async () => terminals.agentCommand(terminalId),
        note: async (pending) => terminals.noteAgentCommand(terminalId, pending),
      },
    },
    close: async () => {
      closed = true;
      generation += 1;
      // A shell still starting as the caller ends is stopped once it has.
      try {
        await launching?.catch(() => undefined);
        await terminate();
      } finally {
        // A caller that may act again later starts a fresh shell.
        launching = undefined;
        closed = false;
      }
    },
  };
}
