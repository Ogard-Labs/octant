import { completeOwnerFileAction } from "../providers/providerApprovalCall";
import { createHash } from "node:crypto";
import {
  decodeOwnerApprovalAction,
  decodeOwnerApprovalReading,
  type OwnerApprovalAnswer,
  type OwnerApprovalAuditRecord,
  type OwnerApprovalTarget,
} from "@octant/contracts/owner-approvals";
import { type HubMemberId, type AuditActingPrincipal } from "@octant/contracts";
import type { RuntimeApprovalRecovery } from "../providers/runtimeApprovalRecovery";

export const ownerApprovalDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface OwnerApprovalHost {
  readonly list: (ownerMemberId: HubMemberId) => ReturnType<typeof decodeOwnerApprovalReading>;
  readonly answer: (
    request: OwnerApprovalAnswer,
    authority: { readonly principal: AuditActingPrincipal; readonly current: () => boolean },
  ) => Promise<{ readonly status: "delivered" | "uncertain" | "refused" }>;
}

export function createOwnerApprovalHost(options: {
  readonly hostMemberId: string;
  readonly pending: () => ReadonlyArray<RuntimeApprovalRecovery>;
  /** Current active local thread, Project and root facts; undefined refuses the target. */
  readonly binding: (request: RuntimeApprovalRecovery) =>
    | {
        readonly title: string;
        readonly projectName: string;
        readonly projectId: string;
        readonly version: unknown;
      }
    | undefined;
  /** An admitted record must claim requestId at journal version zero, before any delivery. */
  readonly audit: (fact: OwnerApprovalAuditRecord) => void;
}): OwnerApprovalHost {
  const snapshot = (
    pending: RuntimeApprovalRecovery,
    ownerMemberId: HubMemberId,
  ): OwnerApprovalTarget | undefined => {
    const binding = options.binding(pending);
    if (binding === undefined || pending.action === undefined) return undefined;
    try {
      const action = decodeOwnerApprovalAction(pending.action);
      const complete = completeOwnerFileAction({
        tool: action.tool,
        arguments: JSON.parse(action.input),
        workingDirectory: action.workingDirectory,
      });
      if (complete === undefined || ownerApprovalDigest(complete) !== ownerApprovalDigest(action))
        return undefined;
      return decodeOwnerApprovalReading({
        targets: [
          {
            ownerMemberId,
            hostMemberId: options.hostMemberId,
            mode: pending.mode,
            threadId: pending.threadId,
            projectId: binding.projectId,
            requestId: pending.requestId,
            targetVersion: ownerApprovalDigest({
              binding: binding.version,
              ownerMemberId,
              identity: pending.identity,
              mode: pending.mode,
              threadId: pending.threadId,
              requestId: pending.requestId,
            }),
            actionDigest: ownerApprovalDigest(action),
            title: binding.title,
            projectName: binding.projectName,
            action,
          },
        ],
        unavailable: 0,
      }).targets[0];
    } catch {
      return undefined;
    }
  };
  const locate = (request: OwnerApprovalAnswer) => {
    if (String(request.hostMemberId) !== options.hostMemberId) return undefined;
    return options
      .pending()
      .find(
        (entry) =>
          entry.mode === request.mode &&
          String(entry.threadId) === String(request.threadId) &&
          String(entry.requestId) === String(request.requestId),
      );
  };
  const matches = (request: OwnerApprovalAnswer, pending: RuntimeApprovalRecovery): boolean => {
    const target = snapshot(pending, request.ownerMemberId);
    return (
      target !== undefined &&
      target.targetVersion === request.targetVersion &&
      target.actionDigest === request.actionDigest &&
      String(target.projectId) === String(request.projectId)
    );
  };
  return {
    list: (ownerMemberId) => {
      const pending = options.pending();
      const targets = pending
        .map((entry) => snapshot(entry, ownerMemberId))
        .filter((target) => target !== undefined);
      return decodeOwnerApprovalReading({
        targets: targets.slice(0, 32),
        unavailable: pending.length - targets.length,
      });
    },
    answer: async (request, authority) => {
      const pending = locate(request);
      if (
        authority.principal.kind !== "owner-unlock" ||
        String(authority.principal.memberId) !== String(request.ownerMemberId) ||
        pending === undefined ||
        !authority.current() ||
        !matches(request, pending)
      )
        return { status: "refused" };
      const current = () => {
        return authority.current() && pending.current() && matches(request, pending);
      };
      const fact = { ...request, actingPrincipal: authority.principal };
      try {
        options.audit({ ...fact, phase: "admitted" });
      } catch {
        return { status: "refused" };
      }
      // Audit admission durably consumes this callback, including an uncertain delivery.
      // No await separates the current target check and the runtime's own admission.
      let delivered = false;
      try {
        delivered =
          current() && (await pending.answer(request.approved, current, authority.principal));
      } catch {
        /* Uncertain delivery is never retried. */
      }
      try {
        options.audit({ ...fact, phase: delivered ? "delivered" : "uncertain" });
      } catch {
        return { status: "uncertain" };
      }
      return { status: delivered ? "delivered" : "uncertain" };
    },
  };
}
