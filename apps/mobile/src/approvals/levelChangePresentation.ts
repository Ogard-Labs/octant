import type { WorkRequest } from "@octant/contracts";
import { MOBILE_THREAD_LEVEL_LABELS } from "@octant/client-runtime";
import { permissionModeOfWorkAccess } from "@octant/domain";

/**
 * What the phone shows for an agent's ask to plan first or to leave Plan with
 * a plan: the same words, plan and two answers the desktop's card has, so the
 * person approves exactly the plan the agent wrote wherever they are.
 */
export interface LevelChangePresentation {
  readonly entering: boolean;
  readonly label: string;
  readonly summary: string;
  readonly plan?: string;
  readonly detail: string;
  readonly approveLabel: string;
  readonly keepLabel: string;
}

/** Undefined for any request that is not a pending level change. */
export function levelChangePresentation(request: WorkRequest): LevelChangePresentation | undefined {
  if (request.status !== "pending" || request.detail.kind !== "approval") return undefined;
  const change = request.detail.levelChange;
  if (change === undefined) return undefined;
  const summary = `${request.detail.action}: ${request.detail.description}`;
  if (change.to === "plan") {
    return {
      entering: true,
      label: "Plan first",
      summary,
      detail: "This turn ends; the next one runs in Plan, read-only.",
      approveLabel: "Switch to Plan",
      keepLabel: "Keep working",
    };
  }
  const level = MOBILE_THREAD_LEVEL_LABELS[permissionModeOfWorkAccess(change.to)];
  return {
    entering: false,
    label: "Approve the plan",
    summary,
    ...(change.plan === undefined ? {} : { plan: change.plan }),
    detail: `This turn ends; the next one runs at ${level}.`,
    approveLabel: `Approve plan · ${level}`,
    keepLabel: "Keep planning",
  };
}
