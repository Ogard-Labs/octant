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

/** Where a Work thread's shell was started, and the ceiling it started under, kept between turns. */
export interface WorkTerminalStart {
  readonly folder: string;
  /** Whether it started under Strict. */
  readonly strict: boolean;
  /** The thread's level it started at. */
  readonly executionPolicy: ProviderExecutionPolicy;
  /** The chosen policy's session it started under, where one was chosen. */
  readonly selectionSessionId?: string;
  /** Whether its sandbox scope and that policy still hold. */
  readonly current: () => boolean;
}

/** The ceiling a Work thread holds now: its Strict value and the level its turns run at. */
export interface WorkTerminalCeiling {
  readonly strict: boolean;
  readonly executionPolicy: ProviderExecutionPolicy;
}

const LEVEL_WIDTH: Readonly<Record<ProviderExecutionPolicy, number>> = {
  plan: 0,
  "approval-gated": 1,
  "auto-accept-edits": 2,
  "full-access": 3,
};

/**
 * Whether a shell may keep running under the thread's ceiling now. A shell
 * outlives the turn that started it, so nothing else stops it from running
 * wider than the thread does now: it ends once the thread is in Plan, at a
 * narrower level, under Strict when it started outside it, or when its
 * sandbox scope or chosen policy no longer holds. A wider ceiling keeps it,
 * since it then runs narrower than the thread.
 */
export function workTerminalCeilingHolds(
  start: WorkTerminalStart,
  now: WorkTerminalCeiling,
): boolean {
  if (!start.current()) return false;
  if (now.executionPolicy === "plan") return false;
  if (now.strict && !start.strict) return false;
  return LEVEL_WIDTH[now.executionPolicy] >= LEVEL_WIDTH[start.executionPolicy];
}

/** The one terminal id of a Work thread's agent terminal, so every turn reaches the same shell. */
export function workAgentTerminalId(threadId: string): string {
  const digest = createHash("sha256").update(`octant.work-terminal.v1\0${threadId}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * `octant_terminal` for a Work thread: one shell in the thread's own folder,
 * at the thread's level and confined as its own commands are, never the wider
 * shell a person's own terminal outside Strict gets. Plan refuses it; below
 * Full access each command, and each input to a running program, asks the
 * person, as a Code thread's terminal does, and where nobody can be asked it
 * runs only at Full access. Windows has no Octant sandbox, so there it runs
 * unconfined outside Strict and rests on those asks alone (maintainer
 * decision, 2026-11-26). It carries no credentials and lives until the agent
 * stops it, the thread is archived or moves, or its ceiling narrows.
 */
export function createWorkTerminalTools(input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly terminals: Pick<
    TerminalService,
    | "launch"
    | "attach"
    | "write"
    | "terminate"
    | "agentCommand"
    | "noteAgentCommand"
    | "noteAgentInterrupt"
  >;
  /** The thread's folder now, proven as its turn's is; undefined refuses a start. */
  readonly folder: () => Promise<string | undefined>;
  /** The level the thread's running turn holds now. */
  readonly posture: () => ProviderExecutionPolicy;
  /** The thread's ceiling now, which a running shell must not exceed. */
  readonly ceiling: () => WorkTerminalCeiling;
  /** Whether the turn still speaks for the thread. */
  readonly current: () => boolean;
  /** Asks the person, with the command apart so its own length is what is bounded. */
  readonly ask?: (
    summary: string,
    command: string,
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
        /** Whether the scope and chosen policy still hold; absent holds. */
        readonly current?: () => boolean;
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
  /** Where and in which shell the thread's terminal started; nothing while none runs. */
  readonly startedIn: {
    readonly get: () => WorkTerminalStart | undefined;
    readonly set: (start: WorkTerminalStart | undefined) => void;
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
      const { strict: preparedStrict, ...protections } = prepared.launch;
      const selectionSessionId = protections.sandboxPolicy?.context.sessionId;
      input.startedIn.set({
        folder,
        strict: input.platform === "win32" ? input.strict() : preparedStrict !== false,
        executionPolicy,
        ...(selectionSessionId === undefined ? {} : { selectionSessionId }),
        current: prepared.current ?? (() => true),
      });
      return {
        // Checked again as the shell spawns: an archive or a move to Plan
        // while the sandbox was prepared starts nothing.
        admit: () => stale() === undefined,
        shell: input.shell(),
        cwd: folder,
        stateScope: `work:${input.threadId}`,
        executionPolicy,
        ...protections,
        // Windows has no sandbox to hold Strict to, as for a Code thread's terminal.
        // Elsewhere the shell is confined at the thread's level, as the thread's own
        // commands are, and runs natively only at Full access outside Strict: a
        // turn outside Strict prepares `strict: false`, which opened an
        // unconfined login shell even at Ask.
        ...(input.platform === "win32"
          ? { strict: input.strict() }
          : preparedStrict === false && executionPolicy === "full-access"
            ? { strict: false }
            : {}),
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
        : ({ text }, signal) => ask(`Run this in the task's terminal?\n${text}`, text, signal),
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
      // run elsewhere, and so must this one. So is one started under a ceiling
      // wider than the thread's now.
      const started = input.startedIn.get();
      const moved = started !== undefined && started.folder !== (await input.folder());
      if (started !== undefined && (moved || !workTerminalCeilingHolds(started, input.ceiling()))) {
        await terminal.close();
        input.startedIn.set(undefined);
        return {
          result: moved
            ? {
                error: "terminal-folder-changed",
                message:
                  "This thread's folder changed, so its terminal was stopped. Start it again to run in the new folder.",
              }
            : {
                error: "terminal-ceiling-changed",
                message:
                  "This thread's level or protections narrowed, so its terminal was stopped. Start it again to run at the thread's level now.",
              },
          isError: true,
        };
      }
      return tools.execute(call);
    },
  };
}

/**
 * Ends each Work thread's shell whose thread is no longer active in the folder
 * it started in (archived, deleted, its Project unbound, or moved to another
 * folder) or whose ceiling no longer holds, as the change is committed, rather
 * than at the agent's next terminal call. Returns the unsubscribe.
 */
export function watchWorkTerminalsLeftBehind(input: {
  readonly subscribeCommitted: (listener: (append: unknown) => void) => () => void;
  /** Where each thread's shell was started, by thread id; ended ones are removed. */
  readonly started: Map<string, WorkTerminalStart>;
  /** The thread's active folder now; undefined when it has none. */
  readonly folderNow: (threadId: string) => Promise<string | undefined>;
  /** The thread's ceiling now; undefined when it cannot be read. */
  readonly ceilingNow: (threadId: string) => WorkTerminalCeiling | undefined;
  readonly terminate: (threadId: string) => Promise<void>;
  readonly onError: (error: unknown) => void;
}): () => void {
  const sweep = async () => {
    for (const [threadId, start] of [...input.started]) {
      const ceiling = input.ceilingNow(threadId);
      if (
        ceiling !== undefined &&
        workTerminalCeilingHolds(start, ceiling) &&
        (await input.folderNow(threadId)) === start.folder
      )
        continue;
      // A start since this check began owns the entry now.
      if (input.started.get(threadId) !== start) continue;
      input.started.delete(threadId);
      await input.terminate(threadId);
    }
  };
  // A Strict or policy change is not a thread event, so every append is a
  // cue; one sweep runs at a time, and appends during it queue one more.
  let sweeping: Promise<void> | undefined;
  let again = false;
  const run = (): void => {
    if (sweeping !== undefined) {
      again = true;
      return;
    }
    sweeping = sweep()
      .catch(input.onError)
      .finally(() => {
        sweeping = undefined;
        if (again) {
          again = false;
          run();
        }
      });
  };
  return input.subscribeCommitted(() => {
    if (input.started.size === 0) return;
    // The journal tells its listeners before the service that appended has
    // applied the change to its projection, so a sweep run here read the old
    // folder and kept a shell the move had just left behind.
    queueMicrotask(run);
  });
}
