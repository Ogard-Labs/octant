import type {
  AutomationId,
  AutomationNotificationKind,
  AutomationNotificationMode,
  AutomationNotificationPayloadV1,
  AutomationNotificationPreferences,
  AutomationRunId,
  AutomationRunLifecycle,
  AutomationThreadId,
  RemotePushNotificationPayloadV1,
} from "@octant/contracts";

const MAX_TITLE = 80;
const MAX_BODY = 120;

const SECRETISH =
  /\b(sk-|ghp_|github_pat_|-----BEGIN|password|api[_-]?key|authorization|bearer)\b/i;
const ABSOLUTE_PATH = /(?:^|[\s"'`])(?:\/(?:Users|home|private|var|tmp|etc)\/|\w:\\)/;

export interface PushNotificationDraftInput {
  readonly kind: AutomationNotificationKind;
  readonly hostId: string;
  readonly threadId: string;
  readonly mode?: RemotePushNotificationPayloadV1["mode"];
  readonly threadTitle?: string;
  /** Raw host-side text that must never appear unredacted on lock screens. */
  readonly rawDetail?: string;
}

export interface AutomationPushNotificationDraftInput {
  readonly kind: AutomationNotificationKind;
  readonly hostId: string;
  readonly automationId: AutomationId;
  readonly automationRunId: AutomationRunId;
  readonly mode?: AutomationNotificationMode;
  readonly threadId?: AutomationThreadId;
  readonly displayName?: string;
  /** Raw host-side text that must never appear unredacted on lock screens. */
  readonly rawDetail?: string;
}

function clamp(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function scrub(value: string): string {
  let next = value;
  if (SECRETISH.test(next) || ABSOLUTE_PATH.test(next)) {
    return "Details available on the host.";
  }
  next = next.replace(SECRETISH, "[redacted]");
  next = next.replace(ABSOLUTE_PATH, " [path] ");
  return clamp(next, MAX_BODY);
}

const KIND_TITLE: Record<AutomationNotificationKind, string> = {
  completion: "Thread completed",
  waiting: "Waiting for you",
  failure: "Thread failed",
  "approval-needed": "Approval needed",
};

const AUTOMATION_KIND_TITLE: Record<AutomationNotificationKind, string> = {
  completion: "Automation completed",
  waiting: "Automation waiting",
  failure: "Automation failed",
  "approval-needed": "Automation needs approval",
};

const KIND_BODY: Record<AutomationNotificationKind, string> = {
  completion: "Open Octant to review the result.",
  waiting: "Open Octant to continue.",
  failure: "Open Octant to inspect the failure.",
  "approval-needed": "Approve or reject on the desktop host.",
};

/**
 * Build a lock-screen-safe push payload. Never copies prompts, diffs, secrets,
 * or absolute paths into title/body.
 */
export function buildRedactedPushNotification(
  input: PushNotificationDraftInput,
): RemotePushNotificationPayloadV1 {
  const titleBase =
    input.threadTitle !== undefined && input.threadTitle.trim().length > 0
      ? `${KIND_TITLE[input.kind]}: ${input.threadTitle.trim()}`
      : KIND_TITLE[input.kind];
  const body =
    input.rawDetail !== undefined && input.rawDetail.trim().length > 0
      ? scrub(input.rawDetail)
      : KIND_BODY[input.kind];
  return {
    kind: input.kind,
    hostId: input.hostId as RemotePushNotificationPayloadV1["hostId"],
    threadId: input.threadId,
    title: clamp(titleBase, MAX_TITLE),
    body: clamp(body, MAX_BODY),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
  };
}

/**
 * Build a lock-screen-safe Automation push payload using the same scrubbing
 * rules as ordinary-thread awareness. Includes Automation Center navigation
 * and only attaches a thread id after ordinary-thread creation.
 */
export function buildRedactedAutomationPushNotification(
  input: AutomationPushNotificationDraftInput,
): AutomationNotificationPayloadV1 {
  const titleBase =
    input.displayName !== undefined && input.displayName.trim().length > 0
      ? `${AUTOMATION_KIND_TITLE[input.kind]}: ${input.displayName.trim()}`
      : AUTOMATION_KIND_TITLE[input.kind];
  const body =
    input.rawDetail !== undefined && input.rawDetail.trim().length > 0
      ? scrub(input.rawDetail)
      : KIND_BODY[input.kind];
  return {
    kind: input.kind,
    hostId: input.hostId as AutomationNotificationPayloadV1["hostId"],
    automationId: input.automationId,
    automationRunId: input.automationRunId,
    title: clamp(titleBase, MAX_TITLE),
    body: clamp(body, MAX_BODY),
    navigation: {
      surface: "automation-center",
      automationId: input.automationId,
      runId: input.automationRunId,
    },
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  };
}

/** Map notifiable Automation run lifecycles onto push kinds. */
export function automationNotificationKindForLifecycle(
  lifecycle: AutomationRunLifecycle,
): AutomationNotificationKind | undefined {
  switch (lifecycle) {
    case "waiting":
      return "waiting";
    case "completed":
      return "completion";
    case "failed":
      return "failure";
    default:
      return undefined;
  }
}

export function isAutomationNotificationKindEnabled(
  preferences: AutomationNotificationPreferences,
  kind: AutomationNotificationKind,
): boolean {
  if (!preferences.enabled) return false;
  switch (kind) {
    case "waiting":
      return preferences.waiting;
    case "approval-needed":
      return preferences.approvalNeeded;
    case "failure":
      return preferences.failure;
    case "completion":
      return preferences.completion;
  }
}
