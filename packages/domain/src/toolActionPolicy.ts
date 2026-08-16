import type {
  ToolActionAuthority,
  ToolActionCancellation,
  ToolActionRequest,
  ToolEvidence,
} from "@octant/contracts";
import { sameToolActionAuthority } from "@octant/contracts";

// Re-export so consumers can import from either layer.
export { sameToolActionAuthority };

export type ToolActionAuthorization =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "unauthorized";
      readonly reason:
        | "host-mismatch"
        | "mode-mismatch"
        | "project-mismatch"
        | "root-mismatch"
        | "worktree-mismatch"
        | "provider-mismatch"
        | "extension-mismatch";
    };

function sameExtension(
  left: ToolActionAuthority["extension"],
  right: ToolActionAuthority["extension"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "core" ||
      (right.kind === "trusted-extension" && left.extensionId === right.extensionId))
  );
}

export function authorizeToolAction(
  request: ToolActionRequest,
  granted: ToolActionAuthority,
): ToolActionAuthorization {
  const requested = request.authority;
  if (requested.hostId !== granted.hostId) return { kind: "unauthorized", reason: "host-mismatch" };
  if (requested.mode !== granted.mode) return { kind: "unauthorized", reason: "mode-mismatch" };
  if (requested.projectId !== granted.projectId) {
    return { kind: "unauthorized", reason: "project-mismatch" };
  }
  if (requested.rootId !== granted.rootId) return { kind: "unauthorized", reason: "root-mismatch" };
  if (requested.worktreeId !== granted.worktreeId) {
    return { kind: "unauthorized", reason: "worktree-mismatch" };
  }
  if (requested.providerInstanceId !== granted.providerInstanceId) {
    return { kind: "unauthorized", reason: "provider-mismatch" };
  }
  if (!sameExtension(requested.extension, granted.extension)) {
    return { kind: "unauthorized", reason: "extension-mismatch" };
  }
  return { kind: "allowed" };
}

export function canRecordToolEvidence(request: ToolActionRequest, evidence: ToolEvidence): boolean {
  return (
    evidence.actionId === request.actionId &&
    evidence.correlationId === request.correlationId &&
    sameToolActionAuthority(evidence.authority, request.authority)
  );
}

export function canRequestToolCancellation(
  request: ToolActionRequest,
  cancellation: ToolActionCancellation,
): boolean {
  return (
    cancellation.actionId === request.actionId &&
    cancellation.correlationId === request.correlationId &&
    sameToolActionAuthority(cancellation.authority, request.authority)
  );
}
