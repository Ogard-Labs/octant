import type {
  CodeCheckoutIdentity,
  NativeHarnessSessionView,
  Project,
  ProjectId,
  ProviderInstance,
  ProviderInstanceId,
} from "@octant/contracts";

export interface NativeHarnessRecoveryFacts {
  readonly providerInstance: (
    id: ProviderInstanceId,
  ) => Pick<ProviderInstance, "enabled"> | undefined;
  /** The checkout a Code thread is bound to, if the thread and checkout still exist. */
  readonly codeCheckout: (
    threadId: string,
  ) => Pick<CodeCheckoutIdentity, "availability"> | undefined;
  readonly project: (projectId: ProjectId) => Project | undefined;
  /** The folder's real path when it is a directory that exists; undefined otherwise. */
  readonly directory: (path: string) => Promise<string | undefined>;
}

/**
 * What must be true again before a session a restart left needing recovery
 * may run: its model is still there, and the place it works is too. Each
 * blocker is a sentence the person can act on; none means resume may proceed.
 */
export async function nativeHarnessRecoveryBlockers(
  facts: NativeHarnessRecoveryFacts,
  view: NativeHarnessSessionView,
): Promise<ReadonlyArray<string>> {
  const blockers: string[] = [];
  const provider = facts.providerInstance(view.session.lead.providerInstanceId);
  if (provider === undefined || !provider.enabled) {
    blockers.push("The model's endpoint is gone or turned off; turn it on in Settings.");
  }
  if (view.session.mode === "code") {
    const checkout = facts.codeCheckout(String(view.session.threadId));
    // A restart resets every checkout to waiting until a window's bootstrap
    // revalidates its root; only a checkout confirmed since then has actually
    // been checked.
    if (checkout === undefined || checkout.availability === "unavailable") {
      blockers.push("The thread's checkout is no longer available.");
    } else if (checkout.availability !== "available") {
      blockers.push(
        "The thread's checkout has not been checked since the restart. Open the thread so Octant can check it, then resume.",
      );
    }
    return blockers;
  }
  if (view.session.projectId === undefined) return blockers;
  const project = facts.project(view.session.projectId);
  if (project === undefined || project.lifecycle !== "active") {
    blockers.push("The thread's Project is no longer available.");
  } else if (project.type === "work") {
    // The Project record outlives its folder: the folder itself must still be
    // there, and still be the one the Project was bound to.
    const root = project.binding.canonicalRoot;
    if ((await facts.directory(root)) !== root) {
      blockers.push("The Work Project's folder is missing or has moved.");
    }
  }
  return blockers;
}
