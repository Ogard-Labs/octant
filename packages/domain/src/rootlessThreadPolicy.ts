import type { OctantMode } from "@octant/contracts/modes";
import type {
  ComposerFolderEntry,
  ComposerFolderSelection,
  RootlessThreadWorkspace,
  ThreadWorkspaceVariant,
} from "@octant/contracts/rootless-thread";

export type RootlessThreadRejectionCode =
  | "mode-not-supported"
  | "active-turn"
  | "already-attached"
  | "wrong-mode"
  | "policy-denied";

export type FolderDenialReason =
  | "wrong-mode"
  | "unavailable"
  | "archived"
  | "stale-binding"
  | "disconnected-host"
  | "concurrent-turn"
  | "cancelled"
  | "policy-denied";

export class RootlessThreadRejected extends Error {
  override readonly name = "RootlessThreadRejected";
  constructor(
    readonly code: RootlessThreadRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Rootless threads are supported for Work and Code modes.
 * Chat already has no root requirement and uses virtual Projects.
 */
export function isRootlessModeSupported(mode: OctantMode): boolean {
  return mode === "work" || mode === "code";
}

/**
 * Check whether a thread workspace is rootless.
 */
export function isRootlessWorkspace(
  workspace: ThreadWorkspaceVariant,
): workspace is RootlessThreadWorkspace {
  return workspace.kind === "rootless";
}

/**
 * Validate that a folder attachment may proceed.
 * Returns a denial reason if the attachment cannot proceed.
 */
export type FolderAttachmentDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: FolderDenialReason };

export function validateFolderAttachment(input: {
  readonly workspace: ThreadWorkspaceVariant;
  readonly threadMode: OctantMode;
  readonly projectMode: OctantMode;
  readonly hasActiveTurn: boolean;
}): FolderAttachmentDecision {
  if (!isRootlessWorkspace(input.workspace)) {
    return { kind: "denied", reason: "stale-binding" };
  }
  if (input.hasActiveTurn) {
    return { kind: "denied", reason: "concurrent-turn" };
  }
  if (input.threadMode !== input.projectMode) {
    return { kind: "denied", reason: "wrong-mode" };
  }
  return { kind: "allowed" };
}

/**
 * Authority preconditions for a server-authorized folder attachment. The
 * server evaluates every precondition before side effects and fails closed
 * with a typed actionable denial reason. No renderer or provider payload can
 * grant filesystem, shell, Git, worktree, preview, or delivery authority —
 * only the server-side authority check can allow an attachment.
 */
export interface FolderAttachmentAuthorityInput {
  readonly workspace: ThreadWorkspaceVariant;
  readonly threadMode: OctantMode;
  readonly projectMode: OctantMode;
  readonly hasActiveTurn: boolean;
  readonly hostConnected: boolean;
  readonly hostAuthorized: boolean;
  readonly projectLifecycle: "active" | "archived";
  readonly rootValid: boolean;
  readonly bindingFresh: boolean;
  readonly authorityGranted: boolean;
  readonly requestCancelled: boolean;
}

/**
 * Validate the full authority path for attaching one compatible saved
 * Project/folder to a rootless thread after an active turn ends. Checks are
 * ordered so the most actionable reason is returned first: cancellation,
 * active turn, workspace staleness, mode mismatch, host connectivity, host
 * authorization, project lifecycle, root validity, binding freshness, and
 * finally explicit authority. Returns a typed denial reason matching the
 * issue acceptance criteria.
 */
export function validateFolderAttachmentAuthority(
  input: FolderAttachmentAuthorityInput,
): FolderAttachmentDecision {
  if (input.requestCancelled) {
    return { kind: "denied", reason: "cancelled" };
  }
  if (input.hasActiveTurn) {
    return { kind: "denied", reason: "concurrent-turn" };
  }
  if (!isRootlessWorkspace(input.workspace)) {
    return { kind: "denied", reason: "stale-binding" };
  }
  if (input.threadMode !== input.projectMode) {
    return { kind: "denied", reason: "wrong-mode" };
  }
  if (!input.hostConnected) {
    return { kind: "denied", reason: "disconnected-host" };
  }
  if (!input.hostAuthorized) {
    return { kind: "denied", reason: "policy-denied" };
  }
  if (input.projectLifecycle === "archived") {
    return { kind: "denied", reason: "archived" };
  }
  if (!input.rootValid) {
    return { kind: "denied", reason: "unavailable" };
  }
  if (!input.bindingFresh) {
    return { kind: "denied", reason: "stale-binding" };
  }
  if (!input.authorityGranted) {
    return { kind: "denied", reason: "policy-denied" };
  }
  return { kind: "allowed" };
}

/**
 * Filter composer folder entries to only those compatible with the given mode.
 * "Add folder" and "No folder" are always included.
 */
export function filterComposerFolderEntries(
  entries: ReadonlyArray<ComposerFolderEntry>,
  mode: OctantMode,
  query: string,
  projectModes: ReadonlyMap<string, OctantMode> = new Map(),
): ReadonlyArray<ComposerFolderEntry> {
  const trimmed = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (entry.kind === "saved-project") {
      const projectMode = projectModes.get(String(entry.projectId));
      if (projectMode !== undefined && projectMode !== mode) return false;
      if (trimmed === "") return true;
      return (
        entry.displayName.toLowerCase().includes(trimmed) ||
        entry.rootPath.toLowerCase().includes(trimmed)
      );
    }
    // Add folder / No folder always remain available.
    return true;
  });
}

/**
 * Build the default composer folder selection for a rootless thread.
 */
export function defaultRootlessFolderSelection(): ComposerFolderSelection {
  return { kind: "no-folder" };
}

/**
 * Determine which capabilities are available for a rootless thread.
 * Root-backed tools are absent; web research and non-folder capabilities
 * remain available when ordinary mode/provider/host policy permits them.
 */
export interface RootlessCapabilitySet {
  readonly filesystem: false;
  readonly shell: false;
  readonly git: false;
  readonly worktree: false;
  readonly tests: false;
  readonly previews: false;
  readonly officeMutation: false;
  readonly externalEditor: false;
  readonly delivery: false;
  readonly webResearch: boolean;
}

export function rootlessCapabilities(webResearchAllowed: boolean): RootlessCapabilitySet {
  return {
    filesystem: false,
    shell: false,
    git: false,
    worktree: false,
    tests: false,
    previews: false,
    officeMutation: false,
    externalEditor: false,
    delivery: false,
    webResearch: webResearchAllowed,
  };
}
