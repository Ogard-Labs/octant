import type { SshRemoteProjectRefusal } from "@octant/contracts/ssh-remote-project";
import type { SshAdmissionDecision } from "@octant/contracts/ssh-target";

/** Why a bind, a read, or a worktree change on a remote-bound Project did nothing, in a sentence. */
export function describeSshRemoteProjectRefusal(refusal: SshRemoteProjectRefusal): string {
  if (refusal.reason === "not-admitted") {
    return refusal.decision.status === "refused"
      ? describeSshAdmissionRefusal(refusal.decision)
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
): string {
  switch (decision.reason) {
    case "target-removed":
      return "This SSH target was removed. Its Projects stay readable here, and take no new work.";
    case "target-unreachable":
      return "The SSH target is not connected. Connect it again when it is reachable.";
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
 * Why a provider other than Octant's own harness is not offered for a thread
 * on an SSH target. The host refuses such a turn before anything launches,
 * with admission's reason for a runtime it cannot place and with this rule
 * for one it could place but does not start yet.
 */
export const REMOTE_CODE_THREAD_PROVIDER_UNAVAILABLE =
  "Threads on an SSH target run on Octant's own harness for now. Choose a model it runs.";
