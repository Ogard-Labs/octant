import type { TerminalSessionClient } from "@octant/client-runtime/terminal-session-client";
import type { ProjectId, TerminalSessionProvider, TerminalSessionSummary } from "@octant/contracts";
import { loadList } from "../composer/createFromCache";

export const TERMINAL_SESSION_TOOL_NAMES: Record<TerminalSessionProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export const terminalSessionsKey = (projectId: ProjectId) =>
  `terminal-sessions:${String(projectId)}`;

/** The sessions kept for a Project's folder, shared with whoever reads ahead of the popup opening. */
export function loadTerminalSessions(
  client: TerminalSessionClient,
  projectId: ProjectId,
): Promise<ReadonlyArray<TerminalSessionSummary>> {
  return loadList(client, terminalSessionsKey(projectId), () => client.list(projectId));
}
