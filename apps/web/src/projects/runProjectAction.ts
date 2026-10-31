import type {
  CodeTerminalId,
  ProjectAction,
  ProjectId,
  ProjectTerminalCommand,
  ProjectTerminalResult,
} from "@octant/contracts";

interface RunProjectActionDependencies {
  readonly execute: (command: ProjectTerminalCommand) => Promise<ProjectTerminalResult>;
  /** The Project terminals this window already pinned, in order. */
  readonly pinnedTerminals: ReadonlyArray<CodeTerminalId>;
  /** Opens and pins a new Project terminal, or says why it could not. */
  readonly openTerminal: () => Promise<CodeTerminalId | undefined>;
  readonly notify: (message: string) => void;
}

/**
 * Types a saved action into a pinned Project terminal, or into a new one when
 * none takes it. A refusal means the host typed nothing, so the next terminal is
 * safe to try. A lost or undecodable reply leaves it unknown whether the host
 * typed the line, so that outcome is reported and never retried: a second
 * submission could run a command that is not safe to repeat.
 */
export async function runProjectAction(
  dependencies: RunProjectActionDependencies,
  projectId: ProjectId,
  action: ProjectAction,
): Promise<void> {
  const run = async (terminalId: CodeTerminalId) => {
    try {
      return await dependencies.execute({
        kind: "run-action",
        projectId,
        terminalId,
        actionId: action.id,
      });
    } catch {
      return "unknown" as const;
    }
  };
  const unknownOutcome = () =>
    dependencies.notify(
      `${action.name} may or may not have run: Octant lost the reply. Check the terminal before running it again.`,
    );

  let ran: Awaited<ReturnType<typeof run>> | undefined;
  for (const terminalId of dependencies.pinnedTerminals) {
    const result = await run(terminalId);
    if (result === "unknown") return unknownOutcome();
    if (result.kind === "project-terminal") {
      ran = result;
      break;
    }
  }
  if (ran === undefined) {
    const terminalId = await dependencies.openTerminal();
    if (terminalId === undefined) return;
    ran = await run(terminalId);
  }
  if (ran === "unknown") return unknownOutcome();
  if (ran.kind === "project-terminal-refused") {
    dependencies.notify(ran.message);
    return;
  }
  if (ran.kind !== "project-terminal") dependencies.notify(`${action.name} could not be run.`);
}
