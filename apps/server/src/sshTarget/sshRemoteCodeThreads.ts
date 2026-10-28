import { createHash } from "node:crypto";
import { isAcpAgentKind } from "@octant/contracts/acp-agent-profiles";
import {
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeRepositoryId,
  type CodeCheckoutIdentity,
  type CodeThread,
} from "@octant/contracts/code";
import { decodeBindingRevisionId, type BindingRevisionId } from "@octant/contracts/projects";
import type { ProviderInstanceId } from "@octant/contracts/providers";
import type { SshRemoteProject } from "@octant/contracts/ssh-remote-project";
import {
  SSH_TARGET_MAX_PLACEABLE_RUNTIMES,
  type SshConfinedPosture,
  type SshPlaceableRuntime,
  type SshTargetId,
} from "@octant/contracts/ssh-target";
import type { WindowId } from "@octant/contracts/shell";
import { isNativeHarnessDriverKind } from "@octant/domain/provider-policy";
import { describeSshAdmissionRefusal } from "@octant/domain/ssh-target-recovery";
import type {
  ProviderDriver,
  ProviderRemotePlacementPosture,
  ProviderRemoteProcessPlacement,
} from "@octant/provider-sdk/driver";
import { createRemoteCodeAcpClientTools } from "../code/codeAcpClientTools";
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
 * A turn runs on the native harness, whose inference stays here and whose
 * hands are the remote tool set bound to the target's session now, or on an
 * ACP agent placed on the target, whose client file and terminal requests
 * run as those same hands' calls. Every other provider is refused before
 * anything launches: one whose driver does not declare placement in the
 * turn's posture with admission's own refusal, and one that declares it but
 * is not an ACP agent, because only an ACP agent asks the person before its
 * client requests run. Nothing runs here against the remote path instead.
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
 * Whether a thread on one of the target's Projects holds a turn now: one
 * being prepared, running, or waiting on the person. Removing the target
 * then would end that turn's session under it, so removal waits for it.
 */
export function targetHoldsRunningTurn(
  sources: {
    readonly projects: () => ReadonlyArray<SshRemoteProject>;
    readonly threads: () => ReadonlyArray<CodeThread>;
    readonly turnInProgress: (threadId: string) => boolean;
  },
  targetId: string,
): boolean {
  const projects = sources.projects().filter((project) => String(project.targetId) === targetId);
  if (projects.length === 0) return false;
  const store = {
    getProject: (projectId: string) => projects.find((project) => String(project.id) === projectId),
  };
  return sources
    .threads()
    .some(
      (thread) =>
        remoteCodeProjectOf(store, thread) !== undefined &&
        sources.turnInProgress(String(thread.id)),
    );
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
      /**
       * Where the turn's provider runtime starts on the target, for a runtime
       * placed there; absent for the native harness, whose inference stays
       * here. The turn acquires its provider with it and with no other.
       */
      readonly placement?: ProviderRemoteProcessPlacement;
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

const PLACED_RUNTIME_NOT_ACP =
  "This provider's runtime can be placed on an SSH target, but only an ACP agent's turn runs there yet. Choose an ACP agent, or a model this host's harness runs.";
const TARGET_UNREACHABLE = "This host cannot reach SSH targets.";

/**
 * Binds a remote-bound thread's turn before anything launches. The provider
 * check comes first, so a runtime that cannot run on the target is refused
 * without touching the session; the harness's tools then bind to the session
 * the target holds now, admitted in the turn's posture.
 */
export function bindRemoteCodeTurn(
  options: {
    readonly store: Pick<SshTargetStore, "getProject">;
    readonly connections: Pick<
      SshTargetConnectionService,
      "admitProviderRuntime" | "session" | "placement"
    >;
    readonly composition: Pick<NativeHarnessComposition, "forRemoteCode" | "remoteHandsForCode">;
    readonly uuid: () => string;
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
    return bindPlacedAcpTurn(options, input, project);
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
      return { status: "refused", message: PLACED_RUNTIME_NOT_ACP };
    case "unavailable":
      return { status: "refused", message: TARGET_UNREACHABLE };
  }
}

/**
 * A placed ACP agent's turn. Admission decides from the driver's declaration
 * first, so a runtime that cannot run on the target touches no session. The
 * agent's client tools then bind to the session the target holds now, and
 * the placement names that same session, the thread's posture, and the path
 * the person set for the provider instance there: without that path nothing
 * is placed and the tools are released.
 */
function bindPlacedAcpTurn(
  options: Parameters<typeof bindRemoteCodeTurn>[0],
  input: RemoteCodeTurnInput,
  project: SshRemoteProject,
): RemoteCodeTurnBinding {
  const { thread } = input;
  const decision = options.connections.admitProviderRuntime(project.targetId, input.driver, {
    posture: thread.executionPolicy,
    permissionPersistence: thread.permissionPersistence,
  });
  if (decision.status === "refused") {
    return { status: "refused", message: describeSshAdmissionRefusal(decision) };
  }
  const posture = placedPosture(thread.executionPolicy);
  if (!isPlacedAcpAgent(input.driver) || posture === undefined) {
    return { status: "refused", message: PLACED_RUNTIME_NOT_ACP };
  }
  const hands = options.composition.remoteHandsForCode({
    thread,
    project,
    windowId: String(input.windowId),
    onTargetDisconnected: input.onTargetDisconnected,
  });
  if (hands.status === "unavailable") return { status: "refused", message: TARGET_UNREACHABLE };
  if (hands.status === "refused") {
    return { status: "refused", message: describeSshAdmissionRefusal(hands.decision) };
  }
  // Nothing yields between binding the hands and asking for the session, so
  // the placement names the session the hands are bound to.
  const session = options.connections.session(project.targetId);
  const placed =
    session === undefined
      ? undefined
      : options.connections.placement({
          session,
          driver: input.driver,
          root: project.remoteRoot,
          projectId: String(project.id),
          threadId: String(thread.id),
          providerInstanceId: thread.providerInstanceId,
          posture,
          permissionPersistence: thread.permissionPersistence,
          currentPosture: hands.executionPolicy,
        });
  if (placed?.status !== "placed") {
    hands.release();
    return {
      status: "refused",
      message:
        placed === undefined
          ? describeSshAdmissionRefusal({ status: "refused", reason: "target-unreachable" })
          : placed.failure.message,
    };
  }
  const tools = createRemoteCodeAcpClientTools({
    root: project.remoteRoot,
    thread,
    // A posture no longer readable is the narrowest one: nothing is written.
    readExecutionPolicy: () => hands.executionPolicy() ?? "plan",
    filesystem: hands.filesystem,
    shell: hands.shell,
    uuid: options.uuid,
  });
  return { status: "bound", tools, placement: placed.placement, release: hands.release };
}

/**
 * Whether a remote turn places this driver's runtime at all. The client tools
 * a placed agent is given admit a write or a terminal in every writing posture
 * without asking; an ACP agent asks the person through its own permission
 * requests first, so only an ACP agent is placed.
 */
function isPlacedAcpAgent(driver: Pick<ProviderDriver, "kind" | "remotePlacement">): boolean {
  return isAcpAgentKind(driver.kind) && driver.remotePlacement !== undefined;
}

/** A provider instance and the driver a turn of it would acquire. */
export interface RemoteRuntimeSource {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: Pick<ProviderDriver, "kind" | "remotePlacement">;
}

const CONFINED_POSTURES: ReadonlyArray<SshConfinedPosture> = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
];

/**
 * The agents a window may offer for a thread on this target, from the checks
 * a turn makes before it binds: an ACP agent that declares placement; its
 * runtime's own admission in each confined posture, the call the turn makes,
 * so a macOS target or an unproven runtime canary refuses here as it would
 * there; and whether the person set its path on the target, without which
 * the turn's placement refuses. Every other provider is left out, as the
 * turn refuses it.
 */
export function placeableRuntimesOn(
  options: {
    readonly connections: Pick<SshTargetConnectionService, "admitProviderRuntime">;
    readonly store: Pick<SshTargetStore, "runtimeBinaries">;
    readonly runtimes: () => ReadonlyArray<RemoteRuntimeSource>;
  },
  targetId: SshTargetId,
): ReadonlyArray<SshPlaceableRuntime> {
  const paths = new Set(
    options.store.runtimeBinaries(targetId).map((binary) => String(binary.providerInstanceId)),
  );
  return options
    .runtimes()
    .filter((runtime) => isPlacedAcpAgent(runtime.driver))
    .slice(0, SSH_TARGET_MAX_PLACEABLE_RUNTIMES)
    .map((runtime) => ({
      providerInstanceId: runtime.providerInstanceId,
      runtimePath: paths.has(String(runtime.providerInstanceId)) ? "set" : "missing",
      admission: CONFINED_POSTURES.map((posture) => ({
        posture,
        decision: options.connections.admitProviderRuntime(targetId, runtime.driver, {
          posture,
          permissionPersistence: "current-session",
        }),
      })),
    }));
}

/** The thread's posture as a placement's, which is never Full access. */
function placedPosture(
  posture: CodeThread["executionPolicy"],
): ProviderRemotePlacementPosture | undefined {
  return posture === "full-access" ? undefined : posture;
}
