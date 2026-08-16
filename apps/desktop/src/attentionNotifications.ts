/**
 * Native attention surfacing for threads the user is not currently watching.
 *
 * The renderer owns the decision of *what* deserves attention; this module owns
 * the native presentation of it: the notification text and the dock badge. Both
 * sides stay pure so the policy is testable without Electron.
 */

export const ATTENTION_NOTIFICATION_TITLE_LIMIT = 120;
export const ATTENTION_NOTIFICATION_BODY_LIMIT = 240;
export const ATTENTION_BADGE_LIMIT = 99;

export type AttentionReason = "turn-finished" | "approval-required" | "question-asked";

export interface AttentionNotificationRequest {
  readonly reason: AttentionReason;
  readonly threadTitle: string;
  readonly detail?: string;
}

export interface AttentionNotificationPresentation {
  readonly title: string;
  readonly body: string;
  /** macOS only plays a sound for the interactions that block the agent. */
  readonly silent: boolean;
}

const REASON_TITLES: Readonly<Record<AttentionReason, string>> = {
  "approval-required": "Approval needed",
  "question-asked": "Question for you",
  "turn-finished": "Turn finished",
};

const REASON_SILENT: Readonly<Record<AttentionReason, boolean>> = {
  "approval-required": false,
  "question-asked": false,
  "turn-finished": true,
};

function isAttentionReason(value: unknown): value is AttentionReason {
  return value === "turn-finished" || value === "approval-required" || value === "question-asked";
}

function clamp(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function decodeAttentionNotificationRequest(value: unknown): AttentionNotificationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Octant rejected an invalid attention notification request.");
  }
  const candidate = value as Record<string, unknown>;
  if (!isAttentionReason(candidate.reason) || typeof candidate.threadTitle !== "string") {
    throw new Error("Octant rejected an invalid attention notification request.");
  }
  const threadTitle = clamp(candidate.threadTitle, ATTENTION_NOTIFICATION_TITLE_LIMIT);
  if (threadTitle === "") {
    throw new Error("Octant rejected an invalid attention notification request.");
  }
  const detail = typeof candidate.detail === "string" ? clamp(candidate.detail, 400) : "";
  return {
    reason: candidate.reason,
    threadTitle,
    ...(detail === "" ? {} : { detail }),
  };
}

export function attentionNotificationPresentation(
  request: AttentionNotificationRequest,
): AttentionNotificationPresentation {
  const detail = request.detail === undefined ? "" : ` — ${request.detail}`;
  return {
    title: REASON_TITLES[request.reason],
    body: clamp(`${request.threadTitle}${detail}`, ATTENTION_NOTIFICATION_BODY_LIMIT),
    silent: REASON_SILENT[request.reason],
  };
}

export function decodeAttentionBadgeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Octant rejected an invalid attention badge count.");
  }
  return Math.max(0, Math.floor(value));
}

/** Electron clears the badge on an empty string, so zero must render as one. */
export function attentionBadgeLabel(count: number): string {
  if (count <= 0) return "";
  if (count > ATTENTION_BADGE_LIMIT) return `${ATTENTION_BADGE_LIMIT}+`;
  return String(count);
}
