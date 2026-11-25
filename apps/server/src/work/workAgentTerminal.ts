import { createHash } from "node:crypto";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import { createAgentTerminal, type AgentTerminalLaunch } from "../code/agentTerminal";
import { createAgentTerminalTools } from "../code/codeAppManagedTools";
import type { TerminalService } from "../code/terminalService";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";

/** The one terminal id of a Work thread's agent terminal, so every turn reaches the same shell. */
export function workAgentTerminalId(threadId: string): string {
  const digest = createHash("sha256").update(`octant.work-terminal.v1\0${threadId}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * `octant_terminal` for a Work thread: one shell in the thread's own folder,
 * at the thread's level and confined as its own commands are, never the wider
 * shell a person's own terminal outside Strict gets. Plan refuses it; below
 * Full access each command asks the person, as a Code thread's terminal does,
 * and where nobody can be asked it runs only at Full access. It carries no
 * credentials and lives until the agent stops it or the thread is archived.
 */
export function createWorkTerminalTools(input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly terminals: Pick<TerminalService, "launch" | "attach" | "write" | "terminate">;
  /** The thread's folder now, proven as its turn's is; undefined refuses a start. */
  readonly folder: () => Promise<string | undefined>;
  /** The level the thread's running turn holds now. */
  readonly posture: () => ProviderExecutionPolicy;
  /** Whether the turn still speaks for the thread. */
  readonly current: () => boolean;
  readonly ask?: (
    summary: string,
    signal?: AbortSignal,
  ) => Promise<"approved" | "denied" | "cancelled">;
  /** A chosen sandbox policy and its network, as a person's terminal for the task starts under. */
  readonly protections: (
    folder: string,
    executionPolicy: ProviderExecutionPolicy,
  ) => Promise<
    | {
        readonly launch: Pick<
          AgentTerminalLaunch,
          "sandboxPolicy" | "strict" | "networkEgress" | "environment"
        >;
        readonly end: () => Promise<void>;
      }
    | { readonly refused: string }
  >;
  readonly platform: NodeJS.Platform;
  readonly strict: () => boolean;
  readonly shell: () => string;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  /** Where the thread's shell was started, kept between turns; nothing while none runs. */
  readonly startedIn: {
    readonly get: () => string | undefined;
    readonly set: (folder: string | undefined) => void;
  };
}): AppManagedToolSet {
  const stale = () =>
    !input.current()
      ? "tool-authority-stale"
      : input.posture() === "plan"
        ? "plan-mode-read-only"
        : undefined;
  const terminal = createAgentTerminal({
    terminals: input.terminals,
    terminalId: workAgentTerminalId(input.threadId),
    launch: async () => {
      const folder = await input.folder();
      if (folder === undefined || stale() !== undefined)
        return { refused: "This thread's folder is not available." };
      const executionPolicy = input.posture();
      const prepared = await input.protections(folder, executionPolicy);
      if ("refused" in prepared) return prepared;
      input.startedIn.set(folder);
      return {
        // Checked again as the shell spawns: an archive or a move to Plan
        // while the sandbox was prepared starts nothing.
        admit: () => stale() === undefined,
        shell: input.shell(),
        cwd: folder,
        stateScope: `work:${input.threadId}`,
        executionPolicy,
        ...prepared.launch,
        // Windows has no sandbox to hold Strict to, as for a Code thread's terminal.
        ...(input.platform === "win32" ? { strict: input.strict() } : {}),
        onClosed: prepared.end,
      };
    },
  });
  const { ask } = input;
  const tools = createAgentTerminalTools({
    terminal: terminal.port,
    uuid: input.uuid,
    authorityFailure: stale,
    posture: input.posture,
    approve:
      ask === undefined
        ? undefined
        : ({ text }, signal) => ask(`Run this in the task's terminal?\n${text}`, signal),
    markResults: (tools) =>
      taintAppManagedToolResults({
        tools,
        threadId: input.threadId,
        recordExternalContentIngestion: input.recordExternalContentIngestion,
        uuid: input.uuid,
      }),
  });
  return {
    ...tools,
    execute: async (call) => {
      // A shell started in another folder (the working directory or the
      // Project moved) is ended rather than reused: the turn's commands now
      // run elsewhere, and so must this one.
      const started = input.startedIn.get();
      if (started !== undefined && started !== (await input.folder())) {
        await terminal.close();
        input.startedIn.set(undefined);
        return {
          result: {
            error: "terminal-folder-changed",
            message:
              "This thread's folder changed, so its terminal was stopped. Start it again to run in the new folder.",
          },
          isError: true,
        };
      }
      return tools.execute(call);
    },
  };
}
