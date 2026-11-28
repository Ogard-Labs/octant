import type { ThreadLiveStep } from "@octant/contracts";
import { liveStepWords } from "./liveStepWords";
import { serverCodeProjectFor, useServerCodeProjects } from "./serverProjectEntries";

/** What a working row's last line says, and the server it names. */
export interface WorkingRowLine {
  readonly activity?: string;
  readonly host?: string;
}

const NOT_WORKING: WorkingRowLine = {};

/**
 * The plain-words line every Working row carries under its title: the live
 * step ("Running bun bench.ts"), or "Thinking" before the turn's first tool
 * and from a host that reports no step, and the server a server Project runs
 * on. A local Project names no host: the row is already on this computer.
 */
export function useWorkingRowLine(
  thread: { readonly liveStep?: ThreadLiveStep | undefined; readonly projectId?: unknown },
  working: boolean,
): WorkingRowLine {
  const server = useServerCodeProjects();
  if (!working) return NOT_WORKING;
  const projectId = thread.projectId === undefined ? undefined : String(thread.projectId);
  const host =
    serverCodeProjectFor(server.projects, projectId)?.serverName ??
    serverCodeProjectFor(server.workProjects, projectId)?.serverName;
  return {
    activity: thread.liveStep === undefined ? "Thinking" : liveStepWords(thread.liveStep),
    ...(host === undefined ? {} : { host }),
  };
}
