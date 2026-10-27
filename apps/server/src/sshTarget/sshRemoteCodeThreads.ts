import { createHash } from "node:crypto";
import {
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeRepositoryId,
  type CodeCheckoutIdentity,
  type CodeThread,
} from "@octant/contracts/code";
import { decodeBindingRevisionId, type BindingRevisionId } from "@octant/contracts/projects";
import type { SshRemoteProject } from "@octant/contracts/ssh-remote-project";
import type { WindowId } from "@octant/contracts/shell";
import { isNativeHarnessDriverKind } from "@octant/domain/provider-policy";
import { describeSshAdmissionRefusal } from "@octant/domain/ssh-target-recovery";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { CodeCheckoutObservationPort } from "../code/codeService";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { SshTargetConnectionService } from "./sshTargetConnectionService";
import type { SshTargetStore } from "./sshTargetStore";

/**
 * Code threads in a Project bound to a remote root. Canonical:
 * docs/design/remote-ssh-environments.md § Native harness on a target.
 *
 * A remote-bound Project's thread is an ordinary Code thread on this host's
 * journal, whose checkout is the `remote-root` the binding names. Its
 * identity is derived from the binding alone, so a thread created against
 * one binding can never name another, and no local Files, Git, terminal,
 * test, or checkpoint path resolves it: none of them knows the Project.
 *
 * A turn runs only on the native harness, whose inference stays here and
 * whose hands are the remote tool set bound to the target's session now.
 * Every other provider is refused before anything launches: one whose driver
 * does not declare placement in the turn's posture with admission's own
 * refusal, and one that does because the Code turn runtime does not start a
 * placed runtime yet. Nothing runs here against the remote path instead.
 */

/** The binding revision and checkout a remote-bound Project's threads are created against. */
export interface RemoteCodeCheckout {
  readonly bindingRevisionId: BindingRevisionId;
  readonly checkout: Extract<CodeCheckoutIdentity, { readonly kind: "remote-root" }>;
}

function digest(label: string, project: SshRemoteProject): string {
  return createHash("sha256")
    .update(`${label}\0`)
    .update(String(project.id))
    .update("\0")
    .update(String(project.targetId))
    .update("\0")
    .update(project.remoteRoot)
    .digest("hex");
}

function digestUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function remoteCodeCheckout(project: SshRemoteProject): RemoteCodeCheckout {
  const checkout = decodeCodeCheckoutIdentity({
    id: decodeCodeCheckoutId(digestUuid(digest("octant.ssh-remote-checkout.v1", project))),
    repositoryId: decodeCodeRepositoryId(
      `repo_${digest("octant.ssh-remote-repository.v1", project)}`,
    ),
    kind: "remote-root",
    availability: "available",
    head: { kind: "none" },
    observedAt: project.boundAt,
  });
  if (checkout.kind !== "remote-root") throw new Error("A remote checkout decoded as local.");
  return {
    bindingRevisionId: decodeBindingRevisionId(
      digestUuid(digest("octant.ssh-remote-binding.v1", project)),
    ),
    checkout,
  };
}

/**
 * The remote-bound Project a thread runs in, when the thread's binding,
 * repository, and checkout are exactly the ones that Project derives.
 */
export function remoteCodeProjectOf(
  store: Pick<SshTargetStore, "getProject">,
  thread: Pick<CodeThread, "projectId" | "bindingRevisionId" | "repositoryId" | "checkoutId">,
): SshRemoteProject | undefined {
  const project = store.getProject(String(thread.projectId));
  if (project === undefined) return undefined;
  const derived = remoteCodeCheckout(project);
  return String(derived.bindingRevisionId) === String(thread.bindingRevisionId) &&
    String(derived.checkout.repositoryId) === String(thread.repositoryId) &&
    String(derived.checkout.id) === String(thread.checkoutId)
    ? project
    : undefined;
}

/**
 * Prepares a Project's checkout for a new thread: a remote-bound Project's
 * from its binding alone, any other Project's through `local`.
 */
export function withRemoteCodeCheckouts(
  store: Pick<SshTargetStore, "getProject">,
  local: CodeCheckoutObservationPort,
): CodeCheckoutObservationPort {
  return {
    observe: async (windowId, projectId) => {
      const remote = store.getProject(String(projectId));
      return remote === undefined ? local.observe(windowId, projectId) : remoteCodeCheckout(remote);
    },
  };
}

/**
 * A remote-bound thread's checkout root as the Code operation runtime takes
 * it: the path as the target names it, never resolved or opened here. Only
 * the turn's executor tools act on it.
 */
export function remoteCodeCheckoutRoot(
  store: Pick<SshTargetStore, "getProject">,
  thread: Pick<CodeThread, "projectId" | "bindingRevisionId" | "repositoryId" | "checkoutId">,
) {
  const project = remoteCodeProjectOf(store, thread);
  return project === undefined
    ? undefined
    : {
        checkoutRoot: String(project.remoteRoot),
        shell: "/bin/sh",
        credentialReferences: [],
        environment: {},
      };
}

/** A remote-bound thread's turn: its tools on the target, or why it cannot run. */
export type RemoteCodeTurnBinding =
  | {
      readonly status: "bound";
      readonly tools: AppManagedToolSet;
      /** The turn ended: the tools stop listening for the session's end. */
      readonly release: () => void;
    }
  | { readonly status: "refused"; readonly message: string };

export interface RemoteCodeTurnInput {
  /** The thread in the posture its turn runs in. */
  readonly thread: CodeThread;
  readonly windowId: WindowId;
  readonly driver: Pick<ProviderDriver, "kind" | "remotePlacement">;
  readonly secrets: ReadonlyArray<string>;
  /** Told once, when the session the turn's tools are bound to ends. */
  readonly onTargetDisconnected: () => void;
}

const PLACED_RUNTIME_NOT_STARTED =
  "This provider's runtime can be placed on an SSH target, but Code threads do not start a placed runtime yet. Choose a model this host's harness runs.";

/**
 * Binds a remote-bound thread's turn before anything launches. The provider
 * check comes first, so a runtime that cannot run on the target is refused
 * without touching the session; the harness's tools then bind to the session
 * the target holds now, admitted in the turn's posture.
 */
export function bindRemoteCodeTurn(
  options: {
    readonly store: Pick<SshTargetStore, "getProject">;
    readonly connections: Pick<SshTargetConnectionService, "admitProviderRuntime">;
    readonly composition: Pick<NativeHarnessComposition, "forRemoteCode">;
  },
  input: RemoteCodeTurnInput,
): RemoteCodeTurnBinding {
  const project = remoteCodeProjectOf(options.store, input.thread);
  if (project === undefined) {
    return {
      status: "refused",
      message: "This thread's SSH target binding is not recorded on this host.",
    };
  }
  if (!isNativeHarnessDriverKind(input.driver.kind)) {
    const decision = options.connections.admitProviderRuntime(project.targetId, input.driver, {
      posture: input.thread.executionPolicy,
      permissionPersistence: input.thread.permissionPersistence,
    });
    return {
      status: "refused",
      message:
        decision.status === "refused"
          ? describeSshAdmissionRefusal(decision)
          : PLACED_RUNTIME_NOT_STARTED,
    };
  }
  const composed = options.composition.forRemoteCode({
    thread: input.thread,
    project,
    windowId: String(input.windowId),
    secrets: input.secrets,
    onTargetDisconnected: input.onTargetDisconnected,
  });
  switch (composed.status) {
    case "composed":
      return { status: "bound", tools: composed.tools, release: composed.release };
    case "refused":
      return { status: "refused", message: describeSshAdmissionRefusal(composed.decision) };
    case "not-harness":
      return { status: "refused", message: PLACED_RUNTIME_NOT_STARTED };
    case "unavailable":
      return { status: "refused", message: "This host cannot reach SSH targets." };
  }
}
