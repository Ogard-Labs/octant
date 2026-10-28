import type { SshRemoteProjectRefusal } from "@octant/contracts/ssh-remote-project";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import type { SshAdmissionDecision, SshTargetStatus } from "@octant/contracts/ssh-target";

/** Why a bind, a read, or a worktree change on a remote-bound Project did nothing, in a sentence. */
export function describeSshRemoteProjectRefusal(
  refusal: SshRemoteProjectRefusal,
  describe: Parameters<typeof describeSshAdmissionRefusal>[1] = {},
): string {
  if (refusal.reason === "not-admitted") {
    return refusal.decision.status === "refused"
      ? describeSshAdmissionRefusal(refusal.decision, describe)
      : "The target refused the request.";
  }
  switch (refusal.reason) {
    case "root-unavailable":
      return "That folder does not exist on the target, or is not a folder.";
    case "root-moved":
      return "That folder moved on the target since it was bound.";
    case "root-not-confinable":
      return "Octant binds no folder that is /, or holds or sits inside your ~/.ssh or its own runtime. Choose the project folder itself.";
    case "outside-root":
      return "That path leads outside the folder.";
    case "not-found":
      return "That path does not exist.";
    case "not-a-directory":
      return "That path is not a folder.";
    case "not-a-file":
      return "That path is not a file.";
    case "too-large":
      return "The answer is too large to read.";
    case "not-a-repository":
      return "That folder is not a Git repository.";
    case "git-unavailable":
      return "Git is not installed on the target.";
    case "read-failed":
      return "The target could not read it.";
    case "not-repository-root":
      return "A worktree needs the bound folder to be its repository's own top level, with .git inside it.";
    case "worktree-exists":
      return "A worktree or branch of that name already exists.";
    case "worktree-dirty":
      return "The worktree holds changes or untracked files, so Git keeps it.";
    case "worktree-failed":
      return "Git could not change the worktree on the target.";
    case "unknown-project":
      return "That Project is not on this host.";
    case "unknown-worktree":
      return "That worktree is not on this host.";
    case "executor-unavailable":
      return "The session to the target ended. Connect it again and retry.";
  }
}

/**
 * The sentence a person sees when work on an SSH target is refused: what
 * happened and the recovery they can perform, from the design's refusal
 * table. Canonical: docs/design/remote-ssh-environments.md § Confinement
 * attestation and admission.
 *
 * It names no command of one surface, so a Settings page, a terminal, and a
 * read all say the same thing; the refusal's own fields (posture, probe) are
 * the only detail it adds.
 */
export function describeSshAdmissionRefusal(
  decision: Extract<SshAdmissionDecision, { readonly status: "refused" }>,
  options: {
    /**
     * Renders a reconnect's next attempt time for the reader, such as a
     * window's local clock time. Without it the sentence names no time.
     */
    readonly formatTime?: (epochMilliseconds: number) => string;
  } = {},
): string {
  switch (decision.reason) {
    case "target-removed":
      return "This SSH target was removed. Its Projects stay readable here, and take no new work.";
    case "target-unreachable":
      return "The SSH target is not connected. Connect it again when it is reachable.";
    case "target-reconnecting": {
      const next =
        decision.nextAttemptAt === undefined
          ? ", under way"
          : options.formatTime === undefined
            ? ""
            : `, next at ${options.formatTime(decision.nextAttemptAt)}`;
      return `The SSH target's session dropped, and Octant is reconnecting on its own (attempt ${String(decision.attempt)} of ${String(decision.maxAttempts)}${next}). Work there waits until it connects and attests again.`;
    }
    case "authentication-refused":
      return "The target no longer accepts this Mac's SSH key or agent. Check that ssh to it signs in without a prompt, then connect it again.";
    case "host-key-changed":
      return "The SSH target presented a different host key. Check it, then confirm the new key from this Mac.";
    case "executor-missing":
      return "Octant is not installed at the executor path on the target. Install the headless Octant of this version there.";
    case "executor-version-mismatch":
      return "The target's Octant is another version. Install the headless Octant of this host's version there.";
    case "remote-root-user":
      return "The target logs in as root. Register it with a non-root user.";
    case "unsupported-platform":
      return "The target is neither Linux nor macOS. Use a Linux or macOS machine.";
    case "confinement-backend-missing":
      return "The target has no working bubblewrap. Install bubblewrap on the target.";
    case "user-namespaces-unavailable":
      return "The target refuses unprivileged user namespaces. Enable them for this user on the target.";
    case "plan-filter-unavailable":
      return "Plan on Linux needs an x64 or arm64 CPU and an executable /bin/sh on the target.";
    case "confinement-canary-escaped":
      return `Confinement did not hold on the target (${decision.posture}: ${decision.probe}). Contact the target's administrator.`;
    case "not-attested":
      return decision.probe === undefined
        ? `The target has not proven it confines ${decision.posture} work on this connection. Connect it again to attest.`
        : `The target could not show that ${decision.posture} work is confined (${decision.probe}). Connect it again to attest.`;
    case "runtime-not-attestable":
      return "Octant cannot confine this runtime on an SSH target. Choose one it confines there.";
    case "full-access-not-remembered":
      return "Full access is not remembered for this Project. Remember it from this Mac, or choose a narrower posture.";
  }
}

/**
 * Why an operation other than a turn is refused on a Code thread whose
 * checkout is on an SSH target: terminals, tests, Git, files, checkpoints,
 * and pull requests each act on a folder of this host. The host refuses with
 * this sentence and a window shows the same one beside the control it hides.
 */
export const REMOTE_CODE_THREAD_OPERATION_UNAVAILABLE =
  "This thread's checkout is on an SSH target, where this operation is not available.";

/** Why a connector or plugin cannot join a turn of a thread on an SSH target. */
export const REMOTE_CODE_THREAD_CONNECTORS_UNAVAILABLE =
  "Connectors and plugins run their tools on this Mac, so a thread on an SSH target cannot use them. Send the message without them.";

/**
 * Why a provider that is neither Octant's own harness nor an agent the host
 * places is not offered for a thread on an SSH target. The host refuses such
 * a turn before anything launches, with admission's reason for a runtime it
 * cannot place and with its own rule for one it could place but does not
 * start there.
 */
export const REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE =
  "This model is not available on an SSH target: threads there run on Octant's own harness or an ACP agent Octant places there.";

/** Why a thread on an SSH target is not created holding Full access. */
export const REMOTE_CODE_THREAD_FULL_ACCESS_UNAVAILABLE =
  "Full access is not available for a Project on an SSH target. Choose a narrower posture.";

/**
 * The postures a window offers for a thread on an SSH target. Full access has
 * nowhere to be remembered for a remote-bound Project, and Auto-accept edits
 * would write on the target with no checkpoint to return to, since a remote
 * turn takes none; each write there is approved instead.
 */
export const REMOTE_CODE_THREAD_POSTURES = ["plan", "approval-gated"] as const;

/** Why a thread on an SSH target is not created holding, or raised to, Auto-accept edits. */
export const REMOTE_CODE_THREAD_AUTO_ACCEPT_UNAVAILABLE =
  "Auto-accept edits is not available for a thread on an SSH target: a turn there takes no checkpoint, so each edit is approved. Choose Ask for approvals or Plan.";

/**
 * Why the host refuses a thread on an SSH target holding `posture`, or
 * undefined for a posture in `REMOTE_CODE_THREAD_POSTURES`. The host applies
 * this when a thread is created and when its access changes; a window only
 * mirrors it.
 */
export function remoteCodeThreadPostureRefusal(
  posture: ProviderExecutionPolicy,
): string | undefined {
  switch (posture) {
    case "plan":
    case "approval-gated":
      return undefined;
    case "auto-accept-edits":
      return REMOTE_CODE_THREAD_AUTO_ACCEPT_UNAVAILABLE;
    case "full-access":
      return REMOTE_CODE_THREAD_FULL_ACCESS_UNAVAILABLE;
  }
}

/** Whether a native-harness turn could start on a target now, or why not. */
export type RemoteCodeTurnReadiness =
  | { readonly status: "ready" }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * Whether the host's status of a target admits a turn in `posture` now, as a
 * window shows it before anyone presses Start. It reads only what the host
 * reported (the connection and its admission of each confined posture) and
 * decides nothing: the host admits every turn and every call itself.
 * `target` is absent when the Project's target is no longer registered.
 */
export function remoteCodeTurnReadiness(
  target: Pick<SshTargetStatus, "connection" | "admission"> | undefined,
  posture: ProviderExecutionPolicy,
  describe: Parameters<typeof describeSshAdmissionRefusal>[1] = {},
): RemoteCodeTurnReadiness {
  if (target === undefined) {
    return {
      status: "unavailable",
      message: describeSshAdmissionRefusal({ status: "refused", reason: "target-removed" }),
    };
  }
  if (posture === "full-access") {
    return { status: "unavailable", message: REMOTE_CODE_THREAD_FULL_ACCESS_UNAVAILABLE };
  }
  const decision = target.admission.find((entry) => entry.posture === posture)?.decision;
  if (target.connection !== "connected") {
    // The host's own refusal names why (reconnecting, a changed key); a
    // status that holds none for the posture still admits nothing.
    return {
      status: "unavailable",
      message: describeSshAdmissionRefusal(
        decision?.status === "refused"
          ? decision
          : { status: "refused", reason: "target-unreachable" },
        describe,
      ),
    };
  }
  if (decision === undefined) {
    return {
      status: "unavailable",
      message: describeSshAdmissionRefusal({ status: "refused", reason: "not-attested", posture }),
    };
  }
  return decision.status === "admitted"
    ? { status: "ready" }
    : { status: "unavailable", message: describeSshAdmissionRefusal(decision, describe) };
}

/**
 * The command that sets where a provider instance's runtime is on a target,
 * with the path left for the person to fill in.
 */
export function sshTargetRuntimeCommand(targetId: string, providerInstanceId: string): string {
  return `octant ssh-target runtime ${targetId} ${providerInstanceId} <path>`;
}

/**
 * Why a placed agent does not run on a target where the person set no path
 * for it. The host refuses the turn with this sentence and a window shows the
 * same one on the agent it lists unavailable.
 */
export function sshTargetRuntimePathMissing(targetId: string, providerInstanceId: string): string {
  return `Set where this provider's runtime is on the SSH target before it runs there: ${sshTargetRuntimeCommand(targetId, providerInstanceId)}.`;
}

/** Whether a window offers a provider's models for a thread on an SSH target. */
export type RemoteCodeProviderOffer =
  | { readonly status: "offered" }
  | { readonly status: "unavailable"; readonly message: string };

type PlaceableRuntimeStatus = Pick<SshTargetStatus, "target" | "placeableRuntimes">;

function placeableRuntime(target: PlaceableRuntimeStatus | undefined, providerInstanceId: string) {
  return target?.placeableRuntimes.find(
    (runtime) => String(runtime.providerInstanceId) === providerInstanceId,
  );
}

/**
 * Whether a window offers a provider other than Octant's own harness for a
 * thread on an SSH target, from the host's status of the target alone. An
 * agent is offered only where the host listed it placeable (an ACP agent the
 * turn would place), its runtime is attestable there in some posture a remote
 * thread offers, and the person set its path there; otherwise the window lists
 * it unavailable with the host's sentence. It decides nothing: the host
 * checks each turn itself.
 */
export function remoteCodeProviderOffer(
  target: PlaceableRuntimeStatus | undefined,
  providerInstanceId: string,
): RemoteCodeProviderOffer {
  const runtime = placeableRuntime(target, providerInstanceId);
  if (target === undefined || runtime === undefined) {
    return { status: "unavailable", message: REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE };
  }
  // A runtime its driver does not confine in a posture, or that a macOS
  // target cannot place, is refused there whatever the connection does next.
  const attestableNowhere = REMOTE_CODE_THREAD_POSTURES.every((posture) => {
    const decision = runtime.admission.find((entry) => entry.posture === posture)?.decision;
    return decision?.status === "refused" && decision.reason === "runtime-not-attestable";
  });
  if (attestableNowhere) {
    return {
      status: "unavailable",
      message: describeSshAdmissionRefusal({ status: "refused", reason: "runtime-not-attestable" }),
    };
  }
  if (runtime.runtimePath === "missing") {
    return {
      status: "unavailable",
      message: sshTargetRuntimePathMissing(String(target.target.id), providerInstanceId),
    };
  }
  return { status: "offered" };
}

/**
 * Whether a placed agent's turn could start on a target in `posture` now:
 * the target ready for the posture, the agent offered there, and its
 * runtime's own admission in the posture, which also asks the runtime
 * canaries a command does not need.
 */
export function remotePlacedAgentReadiness(
  target:
    | Pick<SshTargetStatus, "target" | "connection" | "admission" | "placeableRuntimes">
    | undefined,
  providerInstanceId: string,
  posture: ProviderExecutionPolicy,
  describe: Parameters<typeof describeSshAdmissionRefusal>[1] = {},
): RemoteCodeTurnReadiness {
  const targetReadiness = remoteCodeTurnReadiness(target, posture, describe);
  if (targetReadiness.status === "unavailable" || posture === "full-access") return targetReadiness;
  const offer = remoteCodeProviderOffer(target, providerInstanceId);
  if (offer.status === "unavailable") return offer;
  const decision = placeableRuntime(target, providerInstanceId)?.admission.find(
    (entry) => entry.posture === posture,
  )?.decision;
  if (decision === undefined) {
    return {
      status: "unavailable",
      message: describeSshAdmissionRefusal({ status: "refused", reason: "not-attested", posture }),
    };
  }
  return decision.status === "admitted"
    ? { status: "ready" }
    : { status: "unavailable", message: describeSshAdmissionRefusal(decision) };
}
