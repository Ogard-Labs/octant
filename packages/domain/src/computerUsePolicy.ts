import type {
  ComputerUseActionRequest,
  ComputerUseObservation,
  ComputerUseSessionRecord,
  ComputerUseSensitiveFieldKind,
  ToolActionAuthority,
} from "@octant/contracts";
import { sameToolActionAuthority } from "@octant/contracts";

export type ComputerUsePolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: string };

export function evaluateComputerUseAction(
  request: ComputerUseActionRequest,
  session: ComputerUseSessionRecord,
  granted: ToolActionAuthority,
  observedTargetApp?: string,
): ComputerUsePolicyDecision {
  if (!sameToolActionAuthority(request.authority, session.authority)) {
    return { kind: "denied", reason: "Action authority does not match session authority." };
  }
  if (!sameToolActionAuthority(request.authority, granted)) {
    return { kind: "denied", reason: "Action authority does not match granted authority." };
  }
  if (request.sessionId !== session.sessionId) {
    return { kind: "denied", reason: "Action targets a different computer-use session." };
  }
  if (request.actionId !== session.actionId) {
    return { kind: "denied", reason: "Action identity does not match the session." };
  }
  if (request.correlationId !== session.correlationId) {
    return { kind: "denied", reason: "Action correlation does not match the session." };
  }
  if (request.visibility !== "visible") {
    return { kind: "denied", reason: "Computer-use actions must remain visible." };
  }
  if (session.state !== "active") {
    return { kind: "denied", reason: `Computer-use session is ${session.state}, not active.` };
  }
  const allowlistEntry = session.policy.allowlist.find(
    (entry) =>
      entry.actionKind === request.kind &&
      (entry.targetApp === undefined || entry.targetApp === observedTargetApp),
  );
  if (allowlistEntry === undefined) {
    const appScoped = session.policy.allowlist.some(
      (entry) => entry.actionKind === request.kind && entry.targetApp !== undefined,
    );
    if (appScoped && observedTargetApp !== undefined) {
      return {
        kind: "denied",
        reason: `Target app '${observedTargetApp}' is not allowlisted for '${request.kind}'.`,
      };
    }
    return { kind: "denied", reason: `Action kind '${request.kind}' is not in the allowlist.` };
  }
  if (allowlistEntry.requiresApproval && session.approvalId === undefined) {
    return {
      kind: "denied",
      reason: `Action kind '${request.kind}' requires approval but none was granted.`,
    };
  }
  return { kind: "allowed" };
}

export function isSessionExpired(session: ComputerUseSessionRecord, now: number): boolean {
  if (session.state !== "active" && session.state !== "requesting-approval") return false;
  const createdAt = new Date(session.createdAt).getTime();
  return now - createdAt >= session.policy.maxSessionDurationMs;
}

export function canRecordComputerUseObservation(
  observation: ComputerUseObservation,
  session: ComputerUseSessionRecord,
): boolean {
  return (
    observation.sessionId === session.sessionId &&
    observation.actionId === session.actionId &&
    observation.correlationId === session.correlationId &&
    sameToolActionAuthority(observation.authority, session.authority)
  );
}

export function isSensitiveFieldProtectionEnabled(
  session: ComputerUseSessionRecord,
  _fieldKind: ComputerUseSensitiveFieldKind,
): boolean {
  return session.policy.sensitiveFieldProtection;
}

export function requiresVisibleStop(session: ComputerUseSessionRecord): boolean {
  return session.policy.visibleStopControl;
}

export function requiresProcessOwnership(session: ComputerUseSessionRecord): boolean {
  return session.policy.processOwnershipRequired;
}
