import type {
  ProviderDriverKind,
  ProviderExecutionPolicy,
  StrictKeptProtections,
} from "@octant/contracts";
import { resolveStrict, strictKeptAtLaunch } from "@octant/domain";
import { activeSandboxStrict } from "./process/sandboxRuntimePolicy";

/**
 * What the host reads to decide Strict: each thread's own choice, its
 * Project's default, and the Settings defaults. Every read is the projection
 * as it is now, so a change to any of them applies at the next launch or call.
 */
export interface StrictReads {
  readonly codeThread: (
    threadId: string,
  ) => { readonly strict?: boolean | undefined; readonly projectId: string } | undefined;
  readonly workThread: (
    threadId: string,
  ) => { readonly strict?: boolean | undefined; readonly projectId: string } | undefined;
  readonly project: (
    projectId: string,
  ) => { readonly type: "code" | "work"; readonly defaultStrict?: boolean | undefined } | undefined;
  readonly codeSettings: () => { readonly defaultStrict?: boolean | undefined } | undefined;
  readonly workSettings: () => { readonly defaultStrict?: boolean | undefined } | undefined;
}

/**
 * The effective Strict value for one thread's launch or call. Every gate that
 * moves behind Strict reads it here, at the moment it decides, never from an
 * earlier launch.
 */
export type StrictResolver = (threadId: string) => boolean;

/**
 * One resolver for every gate. A Code or Work thread takes its own choice,
 * else its Project's, else its mode's Settings default, else off. A Chat
 * thread has no Project or switch of its own, so it is Strict when Strict is
 * the default in Code or Work Settings: a person who asked for Strict anywhere
 * in Settings keeps it in Chat too.
 */
export function createStrictResolver(reads: StrictReads): StrictResolver {
  return (threadId) => {
    const admitted = activeSandboxStrict(threadId);
    if (admitted !== undefined) return admitted;
    const code = reads.codeThread(threadId);
    if (code !== undefined) {
      return resolveStrict({
        thread: code,
        project: reads.project(code.projectId),
        settings: reads.codeSettings(),
      });
    }
    const work = reads.workThread(threadId);
    if (work !== undefined) {
      return resolveStrict({
        thread: work,
        project: reads.project(work.projectId),
        settings: reads.workSettings(),
      });
    }
    return createHostStrictResolver(reads)();
  };
}

/**
 * Strict for something the host runs for no one thread or Project, such as an
 * outside provider driver's process: Strict when it is the default in Code or
 * Work Settings, the same reading a Chat thread takes.
 */
export type HostStrictResolver = () => boolean;

export function createHostStrictResolver(
  reads: Pick<StrictReads, "codeSettings" | "workSettings">,
): HostStrictResolver {
  return () =>
    resolveStrict({ settings: reads.codeSettings() }) ||
    resolveStrict({ settings: reads.workSettings() });
}

/**
 * Strict for something a Project owns with no thread of its own, such as the
 * person's Project terminal: the Project's choice, else its mode's Settings
 * default, else off. A Project that is gone reads as Strict.
 */
export type ProjectStrictResolver = (projectId: string) => boolean;

export function createProjectStrictResolver(reads: StrictReads): ProjectStrictResolver {
  return (projectId) => {
    const project = reads.project(projectId);
    if (project === undefined) return true;
    return resolveStrict({
      project,
      settings: project.type === "code" ? reads.codeSettings() : reads.workSettings(),
    });
  };
}

/**
 * What Strict kept for one provider launch, from the values the host started
 * it with: its Strict value, its runtime family, and whether it ran inside
 * Octant's sandbox (below Full access, or at Full access with the sandbox
 * kept, on a platform where Octant has one). Undefined when the launch was
 * not Strict. Journaled with the launch so the thread can say what Strict
 * withheld.
 */
export function strictKeptForLaunch(input: {
  readonly strict: boolean;
  readonly driverKind: ProviderDriverKind;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly fullAccessSandbox?: boolean | undefined;
  readonly platform?: NodeJS.Platform;
}): StrictKeptProtections | undefined {
  const sandboxed =
    (input.platform ?? process.platform) !== "win32" &&
    (input.executionPolicy !== "full-access" || input.fullAccessSandbox === true);
  return strictKeptAtLaunch({ strict: input.strict, driverKind: input.driverKind, sandboxed });
}
