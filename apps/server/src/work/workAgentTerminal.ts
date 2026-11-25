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
      return {
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
  return createAgentTerminalTools({
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
}
