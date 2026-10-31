import type {
  Project,
  ProjectId,
  ProviderExecutionPolicy,
  ProviderInstance,
  ProviderInstanceId,
  ProviderNativeSetup,
} from "@octant/contracts";
import { resolveProviderNativeSetup } from "@octant/domain";

export interface ProviderNativeSetupSources {
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly readProject: (id: ProjectId) => Project | undefined;
}

export interface SessionNativeSetupInput {
  readonly providerInstanceId: ProviderInstanceId;
  /** The thread's Work or Code Project; absent for a Chat thread, whose Project has no folder. */
  readonly projectId?: ProjectId;
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
 * host. Nothing a thread, an agent, or a remote client sends reaches either.
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
    (project.nativeProviders ?? []).some((kind) => kind === instance.driverKind);
  return resolveProviderNativeSetup({
    driverKind: instance.driverKind,
    mode: input.mode,
    executionPolicy: input.executionPolicy,
    accountAllows: "nativeSetup" in instance && instance.nativeSetup === true,
    projectTrusts,
  });
}
