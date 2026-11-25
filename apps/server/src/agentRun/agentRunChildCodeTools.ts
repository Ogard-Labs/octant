import type { CodeThread, ProviderExecutionPolicy, ToolActionAuthority } from "@octant/contracts";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import { createAgentTerminal, type AgentTerminalLaunch } from "../code/agentTerminal";
import { createAgentTerminalTools } from "../code/codeAppManagedTools";
import {
  createCodeDebugAgentSessionApprovals,
  createCodeDebugAgentTools,
  type CodeDebugAgentToolsOptions,
} from "../code/codeDebugAgentTools";
import type { CodeDebugService } from "../code/codeDebugService";
import {
  createCodeLanguageAgentTools,
  type CodeLanguageAgentToolsOptions,
} from "../code/codeLanguageAgentTools";
import type { CodeLanguageService } from "../code/codeLanguageService";
import type { TerminalService } from "../code/terminalService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import type { AgentRunChildCodeThreads } from "./agentRunChildCodeThreads";
import {
  whileChildRuns,
  type AgentRunChildResources,
  type AgentRunChildToolHost,
} from "./agentRunChildTools";

/** What a Code child's tool needs of the host beside the child itself. */
export interface ChildCodeToolInput {
  readonly host: AgentRunChildToolHost;
  readonly threads: AgentRunChildCodeThreads;
  readonly resources: AgentRunChildResources;
  readonly hostId: ToolActionAuthority["hostId"];
  /** Whether this run, or the thread it works for, has read outside content. */
  readonly externalContentIngested: () => boolean;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
}

/** The authority a Code child speaks under: its own Project and provider, and no thread's window. */
export function childCodeAuthority(
  input: Pick<ChildCodeToolInput, "host" | "hostId">,
): ToolActionAuthority | undefined {
  const { host } = input;
  if (host.mode !== "code" || host.projectId === undefined || !host.current()) return undefined;
  return {
    hostId: input.hostId,
    mode: "code",
    projectId: host.projectId,
    providerInstanceId: host.target.providerInstanceId,
    extension: { kind: "core" },
  };
}

/** The child's thread and window for tools that need both now; neither outlives its grant. */
function childCodeCall(input: ChildCodeToolInput) {
  const { host, threads } = input;
  const windowId = host.window();
  const child = host.mode === "code" ? threads.read(host) : undefined;
  if (windowId === undefined || child === undefined) return undefined;
  const readThread = (): CodeThread | undefined =>
    host.current() && host.window() !== undefined ? threads.read(host)?.thread : undefined;
  return { windowId, child, readThread };
}

/** `octant_code` for a Code child: a language server's reads of its own worktree. */
export function childLanguageTools(
  input: ChildCodeToolInput & {
    readonly language: Pick<CodeLanguageService, "readForAgent" | "servesAgentsIn" | "sweep">;
  },
): AppManagedToolSet | undefined {
  const call = childCodeCall(input);
  if (call === undefined) return undefined;
  const { host, threads } = input;
  const options: CodeLanguageAgentToolsOptions = {
    windowId: call.windowId,
    thread: call.child.thread,
    readThread: call.readThread,
    folders: [call.child.folder],
    authority: () => childCodeAuthority(input),
    externalContentIngested: input.externalContentIngested,
    recordExternalContentIngestion: input.recordExternalContentIngestion,
    language: input.language,
    uuid: input.uuid,
  };
  return whileChildRuns({
    host,
    resources: input.resources,
    tools: createCodeLanguageAgentTools(options),
    acquire: () => {
      const release = threads.hold(host);
      return async () => {
        release();
        // A server on a checkout nobody holds any more is one a sweep stops.
        await input.language.sweep();
      };
    },
  });
}

/** `octant_debug` for an attended Code child outside Plan: sessions of its own worktree. */
export function childDebugTools(
  input: ChildCodeToolInput & {
    readonly debug: CodeDebugAgentToolsOptions["debug"] & Pick<CodeDebugService, "endThread">;
  },
): AppManagedToolSet | undefined {
  const { host, threads } = input;
  if (!host.authority.shell || !host.attended()) return undefined;
  const call = childCodeCall(input);
  if (call === undefined) return undefined;
  return whileChildRuns({
    host,
    resources: input.resources,
    tools: createCodeDebugAgentTools({
      windowId: call.windowId,
      thread: call.child.thread,
      readThread: call.readThread,
      authority: () => childCodeAuthority(input),
      externalContentIngested: input.externalContentIngested,
      recordExternalContentIngestion: input.recordExternalContentIngestion,
      debug: input.debug,
      approvals: createCodeDebugAgentSessionApprovals(),
      askPerson: (summary, signal) => host.ask({ summary, approvalClass: "child-debug", signal }),
      uuid: input.uuid,
    }),
    acquire: () => {
      const release = threads.hold(host);
      return async () => {
        try {
          await input.debug.endThread(call.child.thread.id);
        } finally {
          release();
        }
      };
    },
  });
}

/** `octant_terminal` for an attended Code child outside Plan: a shell in its own worktree. */
export function childTerminalTools(
  input: ChildCodeToolInput & {
    readonly terminals: Pick<TerminalService, "launch" | "attach" | "write" | "terminate">;
    /** The shell and confinement a Code thread's own terminal gets at this level. */
    readonly launchFor: (child: {
      readonly thread: CodeThread;
      readonly folder: string;
      readonly executionPolicy: ProviderExecutionPolicy;
    }) => AgentTerminalLaunch;
  },
): AppManagedToolSet | undefined {
  const { host, threads } = input;
  // A child that may run no commands, or reach no network, gets no shell that could.
  if (!host.authority.shell || !host.authority.network || !host.attended()) return undefined;
  const call = childCodeCall(input);
  if (call === undefined) return undefined;
  const stale = () => {
    const current = call.readThread();
    return current === undefined || String(current.checkoutId) !== String(call.child.checkout.id)
      ? "tool-authority-stale"
      : undefined;
  };
  const terminal = createAgentTerminal({
    terminals: input.terminals,
    terminalId: input.uuid(),
    launch: async () => {
      // Proven to be the run's own worktree at each start, as its session was.
      const root = await threads.resolveRoot(call.child.thread, "package.json" as never);
      return root === undefined || stale() !== undefined
        ? { refused: "This child run's worktree is not available." }
        : input.launchFor({
            thread: call.child.thread,
            folder: root.rootPath,
            executionPolicy: host.executionPolicy,
          });
    },
  });
  return whileChildRuns({
    host,
    resources: input.resources,
    tools: createAgentTerminalTools({
      terminal: terminal.port,
      uuid: input.uuid,
      authorityFailure: stale,
      posture: () => host.executionPolicy,
      approve: ({ text }, signal) =>
        host.ask({
          summary: `Run this in a helper's terminal?\n${text}`,
          approvalClass: "child-terminal",
          signal,
        }),
      markResults: (tools) =>
        taintAppManagedToolResults({
          tools,
          threadId: host.runId,
          recordExternalContentIngestion: input.recordExternalContentIngestion,
          uuid: input.uuid,
        }),
    }),
    acquire: () => {
      const release = threads.hold(host);
      return async () => {
        try {
          await terminal.close();
        } finally {
          release();
        }
      };
    },
  });
}
