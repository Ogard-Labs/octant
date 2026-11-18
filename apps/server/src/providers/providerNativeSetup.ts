import type {
  Project,
  ProjectId,
  ProviderExecutionPolicy,
  ProviderInstance,
  ProviderInstanceId,
  ProviderNativeSetup,
} from "@octant/contracts";
import { accountRunsAsItself, resolveProviderNativeSetup } from "@octant/domain";
import type { ProviderCliProjectTrust } from "./providerCliProjectTrust";

export interface ProviderNativeSetupSources {
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly readProject: (id: ProjectId) => Project | undefined;
  /** The thread's own choice, or undefined when it inherits. */
  readonly readThreadNativeSetup?: (threadId: string) => "on" | "off" | undefined;
  /** Whether the provider's own CLI already trusts the Project's folder; absent reads none. */
  readonly readProviderCliTrust?: ProviderCliProjectTrust;
  /** Strict for the thread, read as the session starts; absent reads Strict. */
  readonly readStrict?: (threadId: string) => boolean;
}

/**
 * Whether a Work or Code Project trusts a key provider: the person trusted it
 * in Octant, or already in the provider's own CLI, whose record Octant's one
 * card would only ask again (maintainer decision, 2026-11-16).
 *
 * Under Strict only Octant's own trust counts: the CLI's record is a lift of
 * Octant's own limit, and Strict restores that limit.
 */
export function projectTrustsProvider(
  project: Exclude<Project, { readonly type: "chat" }>,
  driverKind: ProviderInstance["driverKind"],
  readProviderCliTrust: ProviderCliProjectTrust | undefined,
  strict: boolean,
): boolean {
  return (
    (project.nativeProviders ?? []).some((kind) => kind === driverKind) ||
    (!strict && readProviderCliTrust?.(driverKind, project.binding.canonicalRoot) === true)
  );
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
 * from the journal when the session starts or resumes: the account's switch
 * and the Project's trust, both set only by a person at a window on this
 * host, or, outside Strict, the trust the person gave the folder in the
 * provider's own CLI.
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
  const projectTrusts =
    project !== undefined &&
    project.type !== "chat" &&
    projectTrustsProvider(
      project,
      instance.driverKind,
      sources.readProviderCliTrust,
      input.threadId === undefined || (sources.readStrict?.(input.threadId) ?? true),
    );
  const threadChoice =
    input.threadId === undefined ? undefined : sources.readThreadNativeSetup?.(input.threadId);
  return resolveProviderNativeSetup({
    driverKind: instance.driverKind,
    mode: input.mode,
    executionPolicy: input.executionPolicy,
    accountAllows: "nativeSetup" in instance ? accountRunsAsItself(instance) : true,
    projectTrusts,
    ...(threadChoice === undefined ? {} : { threadChoice }),
  });
}
