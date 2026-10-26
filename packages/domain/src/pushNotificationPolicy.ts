import type {
  AutomationId,
  AutomationNotificationKind,
  AutomationNotificationMode,
  AutomationNotificationPayloadV1,
  AutomationNotificationPreferences,
  AutomationRunId,
  AutomationRunLifecycle,
  AutomationThreadId,
  RemotePushNotificationKind,
  RemotePushNotificationPayloadV1,
  RemotePushPreferencesV1,
} from "@octant/contracts";

const MAX_TITLE = 80;
const MAX_BODY = 120;

// Token prefixes run straight into the token, so only the words need a
// boundary after them; a trailing `\b` after `ghp_` never matched a token.
const SECRETISH =
  /\b(?:sk-|ghp_|github_pat_)|-----BEGIN|\b(?:password|api[_-]?key|authorization|bearer)\b/i;
const ABSOLUTE_PATH = /(?:^|[\s"'`])(?:\/(?:Users|home|private|var|tmp|etc)\/|\w:\\)/;

export interface PushNotificationDraftInput {
  readonly kind: RemotePushNotificationKind;
  /** The id the phone knows this host by. */
  readonly hostId: string;
  readonly threadId: string;
  readonly mode: NonNullable<RemotePushNotificationPayloadV1["mode"]>;
  /** The name the paired computer shows the phone. */
  readonly computerLabel: string;
  readonly threadTitle?: string;
  /** Whether the person enabled thread names for this phone. */
  readonly threadTitles: boolean;
}

export interface AutomationPushNotificationDraftInput {
  readonly kind: AutomationNotificationKind;
  readonly hostId: string;
  readonly automationId: AutomationId;
  readonly automationRunId: AutomationRunId;
  readonly mode?: AutomationNotificationMode;
  readonly threadId?: AutomationThreadId;
  readonly displayName?: string;
  /** The name the paired computer shows the phone. */
  readonly computerLabel: string;
  /** Whether the person enabled thread names for this phone. */
  readonly threadTitles: boolean;
}

const encoder = new TextEncoder();

/** Collapses whitespace and cuts to a UTF-8 byte budget, never inside a character. */
function clamp(value: string, maxBytes: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (encoder.encode(trimmed).byteLength <= maxBytes) return trimmed;
  const budget = maxBytes - encoder.encode("…").byteLength;
  let kept = "";
  let used = 0;
  for (const character of trimmed) {
    const size = encoder.encode(character).byteLength;
    if (used + size > budget) break;
    kept += character;
    used += size;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * The display text is built from the kind, the computer's label, and, when the
 * phone opted in, a name the person chose. The scrubber is a second guard on
 * those names: one that looks like a secret or a path is left out whole.
 */
function shownName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0 || SECRETISH.test(collapsed) || ABSOLUTE_PATH.test(collapsed)) {
    return undefined;
  }
  return collapsed;
}

function titled(kindTitle: string, name: string | undefined, threadTitles: boolean): string {
  const shown = threadTitles ? shownName(name) : undefined;
  return clamp(shown === undefined ? kindTitle : `${kindTitle}: ${shown}`, MAX_TITLE);
}

function computerLine(computerLabel: string): string {
  return clamp(`On ${shownName(computerLabel) ?? "your paired computer"}`, MAX_BODY);
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

/**
 * Build the display text a phone shows for an ordinary thread: the kind and
 * the computer's label, and the thread title only when the person enabled
 * thread names for that phone. Prompts, transcript text, diffs, paths, tool
 * arguments, and failure messages are not inputs, so none can appear.
 */
export function buildRedactedPushNotification(
  input: PushNotificationDraftInput,
): RemotePushNotificationPayloadV1 {
  return {
    kind: input.kind,
    hostId: input.hostId as RemotePushNotificationPayloadV1["hostId"],
    threadId: input.threadId,
    mode: input.mode,
    title: titled(KIND_TITLE[input.kind], input.threadTitle, input.threadTitles),
    body: computerLine(input.computerLabel),
  };
}

/**
 * Build the display text a phone shows for an Automation run, under the same
 * rule as ordinary threads: the automation's name stands where a thread title
 * would and is shown only when the phone opted in. Includes Automation Center
 * navigation and only attaches a thread id after ordinary-thread creation.
 */
export function buildRedactedAutomationPushNotification(
  input: AutomationPushNotificationDraftInput,
): AutomationNotificationPayloadV1 {
  return {
    kind: input.kind,
    hostId: input.hostId as AutomationNotificationPayloadV1["hostId"],
    automationId: input.automationId,
    automationRunId: input.automationRunId,
    title: titled(AUTOMATION_KIND_TITLE[input.kind], input.displayName, input.threadTitles),
    body: computerLine(input.computerLabel),
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

/** Whether a phone asked to hear about this kind. */
export function remotePushPreferenceAllows(
  preferences: RemotePushPreferencesV1,
  kind: RemotePushNotificationKind,
): boolean {
  switch (kind) {
    case "approval-needed":
      return preferences.approvalNeeded;
    case "waiting":
      return preferences.waiting;
    case "failure":
      return preferences.failure;
    case "completion":
      return preferences.completion;
  }
}

/**
 * One notification per thread, kind, and run. A run is the turn (a Chat
 * attempt, a Work turn, a Code provider turn) for lifecycle facts, and the
 * request itself for an approval or a question, since one turn can ask several.
 */
export function remotePushDedupeKey(input: {
  readonly threadId: string;
  readonly kind: RemotePushNotificationKind;
  readonly runId: string;
}): string {
  return `${input.threadId}:${input.kind}:${input.runId}`;
}

/**
 * At most six notifications per device in any sixty seconds. A burst of
 * threads finishing together reaches the phone as the first few; the rest are
 * journaled as rate-limited and the person sees them on the thread list.
 */
export const REMOTE_PUSH_RATE_LIMIT = { maximum: 6, windowMs: 60_000 } as const;

export type RemotePushRateAdmission =
  | { readonly kind: "admit"; readonly recent: ReadonlyArray<number> }
  | { readonly kind: "rate-limited"; readonly recent: ReadonlyArray<number> };

/** `recent` holds the device's send times (ms) still inside the window. */
export function admitRemotePushByRate(input: {
  readonly recent: ReadonlyArray<number>;
  readonly now: number;
}): RemotePushRateAdmission {
  const recent = input.recent.filter(
    (sentAt) => sentAt > input.now - REMOTE_PUSH_RATE_LIMIT.windowMs,
  );
  if (recent.length >= REMOTE_PUSH_RATE_LIMIT.maximum) return { kind: "rate-limited", recent };
  return { kind: "admit", recent: [...recent, input.now] };
}

/** What waits on the person goes at high urgency; the rest at normal. */
export function remotePushUrgency(kind: RemotePushNotificationKind): "high" | "normal" {
  return kind === "approval-needed" || kind === "waiting" ? "high" : "normal";
}
