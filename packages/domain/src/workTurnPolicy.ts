import type { WorkTurnAuthority } from "@octant/contracts/work-turns";

export type WorkTurnAuthorityDecision =
  | { readonly kind: "allow" }
  | {
      readonly kind: "deny";
      readonly category: "invalid" | "unauthorized" | "stale" | "unsupported";
      readonly message: string;
    };

/**
 * Pure authority check for a Project-backed Work provider turn. The server
 * re-validates these facts before journaling acceptance or launching a
 * provider. Shell, Git, worktree, PR, and Code authority are never granted
 * here — those fields cannot appear on `WorkTurnAuthority`.
 */
export function decideWorkTurnAuthority(input: {
  readonly authority: WorkTurnAuthority;
  readonly expectedHostId: string;
  readonly project:
    | {
        readonly type: string;
        readonly lifecycle: string;
        readonly bindingHistory: ReadonlyArray<{ readonly revisionId: string }>;
        readonly binding: { readonly canonicalRoot: string };
      }
    | undefined;
  readonly thread:
    | {
        readonly projectId: string;
        readonly lifecycle: string;
        readonly providerInstanceId: string;
        readonly modelId: string;
        readonly bindingRevisionId: string | undefined;
        readonly workingDirectory: string | undefined;
      }
    | undefined;
}): WorkTurnAuthorityDecision {
  if (input.authority.hostId !== input.expectedHostId) {
    return {
      kind: "deny",
      category: "unauthorized",
      message: "Work turn host is not authorized.",
    };
  }
  if (input.authority.confinementPosture !== "project-root-confined") {
    return {
      kind: "deny",
      category: "unsupported",
      message: "Work turn requires project-root confinement.",
    };
  }
  if (input.project === undefined || input.project.type !== "work") {
    return {
      kind: "deny",
      category: "unauthorized",
      message: "Work Project is unavailable for this turn.",
    };
  }
  if (input.project.lifecycle !== "active") {
    return {
      kind: "deny",
      category: "unauthorized",
      message: "Work Project is not active.",
    };
  }
  if (input.project.binding.canonicalRoot.trim() === "") {
    return {
      kind: "deny",
      category: "invalid",
      message: "Work Project root is unavailable.",
    };
  }
  const latestBinding = input.project.bindingHistory.at(-1);
  if (
    latestBinding === undefined ||
    String(latestBinding.revisionId) !== String(input.authority.bindingRevisionId)
  ) {
    return {
      kind: "deny",
      category: "stale",
      message: "Work Project binding changed; reload and retry.",
    };
  }
  if (input.thread === undefined || input.thread.lifecycle !== "active") {
    return {
      kind: "deny",
      category: "invalid",
      message: "Work thread was not found.",
    };
  }
  if (String(input.thread.projectId) !== String(input.authority.projectId)) {
    return {
      kind: "deny",
      category: "unauthorized",
      message: "Work turn Project does not match the thread.",
    };
  }
  if (
    input.thread.bindingRevisionId !== undefined &&
    String(input.thread.bindingRevisionId) !== String(input.authority.bindingRevisionId)
  ) {
    return {
      kind: "deny",
      category: "stale",
      message: "Work thread binding changed; reload and retry.",
    };
  }
  if (
    input.thread.workingDirectory !== undefined &&
    String(input.thread.workingDirectory) !== String(input.authority.workingDirectory)
  ) {
    return {
      kind: "deny",
      category: "stale",
      message: "Work working directory changed; reload and retry.",
    };
  }
  if (
    String(input.thread.providerInstanceId) !== String(input.authority.providerInstanceId) ||
    String(input.thread.modelId) !== String(input.authority.modelId)
  ) {
    return {
      kind: "deny",
      category: "stale",
      message: "Work provider or model changed; reload and retry.",
    };
  }
  return { kind: "allow" };
}
