import type {
  Project,
  ProjectId,
  ProviderExecutionPolicy,
  ProviderInstance,
  ProviderInstanceId,
  ProviderNativeSetup,
} from "@octant/contracts";
import { accountRunsAsItself, resolveProviderNativeSetup } from "@octant/domain";

export interface ProviderNativeSetupSources {
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly readProject: (id: ProjectId) => Project | undefined;
  /** The thread's own choice, or undefined when it inherits. */
  readonly readThreadNativeSetup?: (threadId: string) => "on" | "off" | undefined;
  /** Strict for the thread, read as the session starts; absent reads Strict. */
  readonly readStrict?: (threadId: string) => boolean;
}

/** Whether the person listed this provider under the Project's Trusted providers. */
export function projectListsProvider(
  project: Exclude<Project, { readonly type: "chat" }>,
  driverKind: ProviderInstance["driverKind"],
): boolean {
  return (project.nativeProviders ?? []).some((kind) => kind === driverKind);
}

/**
 * Whether a Work or Code Project trusts a provider to load the Project's own
 * code. Adding the Project in Octant is the person's trust decision for every
 * agent on its threads (maintainer decision, 2026-11-18), so outside Strict
 * every Project does. Strict restores Octant's limit: the Project's code
 * that can run (settings, hooks, MCP servers, plugins) loads only once the
 * person confirmed it for the Project, which lists the provider under
 * Trusted providers. Instruction files are not Project code and load either
 * way.
 */
export function projectTrustsProvider(
  project: Exclude<Project, { readonly type: "chat" }>,
  driverKind: ProviderInstance["driverKind"],
  strict: boolean,
): boolean {
  return !strict || projectListsProvider(project, driverKind);
}

export interface SessionNativeSetupInput {
  readonly providerInstanceId: ProviderInstanceId;
  /** The thread's Work or Code Project; absent for a Chat thread, whose Project has no folder. */
  readonly projectId?: ProjectId;
  /** The Chat, Work, or Code thread the session serves; its own choice outranks the account's. */
  readonly threadId?: string;
  readonly mode: "chat" | "work" | "code";
  readonly executionPolicy: ProviderExecutionPolicy;
}

/** The optional field a session start or resume carries, absent when nothing is on. */
export function nativeSetupOption(setup: ProviderNativeSetup | undefined): {
  readonly nativeSetup?: ProviderNativeSetup;
} {
  return setup === undefined ? {} : { nativeSetup: setup };
}

/**
 * What a session of this thread may load of the provider's own setup, read
 * from the journal when the session starts or resumes: the account's switch,
 * the Project's Trusted providers, both set only by a person at a window on
 * this host, and, outside Strict, the Project the person added.
 * Nothing a thread, an agent, or a remote client sends reaches any of them.
 */
export function sessionNativeSetup(
  sources: ProviderNativeSetupSources,
  input: SessionNativeSetupInput,
): ProviderNativeSetup | undefined {
  const instance = sources.readProviderInstance(input.providerInstanceId);
  if (instance === undefined) return undefined;
  const project =
    input.mode === "chat" || input.projectId === undefined
      ? undefined
      : sources.readProject(input.projectId);
  const folderProject = project !== undefined && project.type !== "chat" ? project : undefined;
  const strict = input.threadId === undefined || (sources.readStrict?.(input.threadId) ?? true);
  const threadChoice =
    input.threadId === undefined ? undefined : sources.readThreadNativeSetup?.(input.threadId);
  return resolveProviderNativeSetup({
    driverKind: instance.driverKind,
    mode: input.mode,
    executionPolicy: input.executionPolicy,
    accountAllows: "nativeSetup" in instance ? accountRunsAsItself(instance) : true,
    projectTrusts:
      folderProject !== undefined && projectListsProvider(folderProject, instance.driverKind),
    projectAddedTrusts: folderProject !== undefined && !strict,
    ...(threadChoice === undefined ? {} : { threadChoice }),
  });
}
