import type {
  AutomationNotificationKind,
  AutomationNotificationPreferences,
  AutomationRunLifecycle,
  LiveStatusCountsV1,
  LiveStatusEventV1,
  LiveStatusRowState,
  LiveStatusRowV1,
  LiveStatusV1,
  PushAlertV2,
  PushMessageV2,
  RemotePushAlertKind,
  RemotePushNotificationKind,
  RemotePushNotificationMode,
  RemotePushPreferencesV1,
  RemotePushUrgency,
  StableHostId,
  UtcTimestamp,
} from "@octant/contracts";
import { REMOTE_PUSH_PLACEHOLDER_ALERT } from "@octant/contracts";
import { checkPushLabel } from "./pushLabelPolicy";

const MAX_TITLE_BYTES = 80;
const MAX_BODY_BYTES = 120;
const MAX_PROJECT_BYTES = 60;
const MAX_LIVE_STATUS_ROWS = 5;

const FALLBACK_COMPUTER_NAME = "your paired computer";
const FALLBACK_DESTINATION_NAME = "another computer";
const FALLBACK_DEVICE_TITLE = "New device";

declare const CHECKED_PUSH_MESSAGE_BRAND: unique symbol;

/**
 * A push message whose every free-text field has passed the host-side secret
 * check (or been replaced by its fallback / generic placeholder). Transports
 * accept only this branded type so no un-checked payload can reach APNs, FCM,
 * or a hub handoff.
 */
export type CheckedPushMessageV2 = PushMessageV2 & {
  readonly [CHECKED_PUSH_MESSAGE_BRAND]: "checked-push-message-v2";
};

function brand(message: PushMessageV2): CheckedPushMessageV2 {
  return message as CheckedPushMessageV2;
}

/**
 * Snapshot of the secret values the host holds in memory and in its local
 * credential store. When `status` is `"unavailable"` (for example, a locked or
 * unreadable keyring), the builder fails closed and emits only the generic
 * placeholder text.
 */
export type HeldSecretSnapshot =
  | { readonly status: "ready"; readonly values: ReadonlyArray<string> }
  | { readonly status: "unavailable" };

const encoder = new TextEncoder();

/** Cuts already-cleaned text to a UTF-8 byte budget, never splitting a character. */
function clampBytes(value: string, maxBytes: number): string {
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

const KIND_TITLE: Readonly<Record<RemotePushNotificationKind, string>> = {
  completion: "Thread completed",
  waiting: "Waiting for you",
  failure: "Thread failed",
  "approval-needed": "Approval needed",
};

const AUTOMATION_KIND_TITLE: Readonly<Record<AutomationNotificationKind, string>> = {
  completion: "Automation completed",
  waiting: "Automation waiting",
  failure: "Automation failed",
  "approval-needed": "Automation needs approval",
};

const MOVE_WAITING_TITLE = "A move is waiting for your phone";

const LIVE_STATUS_PRIORITY: Readonly<Record<LiveStatusRowState, number>> = {
  "approval-needed": 0,
  "needs-input": 1,
  failed: 2,
  working: 3,
  done: 4,
};

function checkedTitled(
  kindTitle: string,
  name: string | undefined,
  threadTitles: boolean,
  heldValues: ReadonlyArray<string>,
): string {
  const shown = threadTitles ? checkPushLabel(name, heldValues) : undefined;
  return clampBytes(shown === undefined ? kindTitle : `${kindTitle}: ${shown}`, MAX_TITLE_BYTES);
}

function checkedComputerName(computerLabel: string, heldValues: ReadonlyArray<string>): string {
  return clampBytes(
    checkPushLabel(computerLabel, heldValues) ?? FALLBACK_COMPUTER_NAME,
    MAX_TITLE_BYTES,
  );
}

function checkedComputerBody(computerLabel: string, heldValues: ReadonlyArray<string>): string {
  return clampBytes(`On ${checkedComputerName(computerLabel, heldValues)}`, MAX_BODY_BYTES);
}

interface PushAlertCommonInput {
  readonly hostId: StableHostId;
  readonly collapseId: string;
  readonly sequence: number;
  readonly occurredAt: UtcTimestamp;
  readonly heldSecrets: HeldSecretSnapshot;
}

export type PushAlertBuildInput = PushAlertCommonInput &
  (
    | {
        readonly source: "thread";
        readonly kind: RemotePushNotificationKind;
        readonly threadId: string;
        readonly mode: RemotePushNotificationMode;
        readonly computerLabel: string;
        readonly threadTitle?: string;
        readonly projectName?: string;
        /** Whether "Show thread names" is enabled for this phone. */
        readonly threadTitles: boolean;
      }
    | {
        readonly source: "automation";
        readonly kind: AutomationNotificationKind;
        readonly threadId?: string;
        readonly mode?: RemotePushNotificationMode;
        readonly computerLabel: string;
        readonly displayName?: string;
        /** Whether "Show thread names" is enabled for this phone. */
        readonly threadTitles: boolean;
      }
    | {
        readonly source: "move-waiting";
        readonly destinationName: string;
      }
    | {
        readonly source: "device-joined";
        readonly deviceName: string;
        readonly joined: "hub" | "host";
        readonly computerLabel: string;
      }
  );

/**
 * The single host-side alert builder every push path calls.
 *
 * Accepts only the closed set of fields authorized for push payloads: fixed
 * status words, checked short labels, routing IDs, and transport metadata.
 * Transcript text, replies, prompts, tool input, file paths, diffs, error
 * messages, and private network addresses are never inputs.
 *
 * If `heldSecrets` is `"unavailable"` (the secret check could not run), emits
 * only the generic placeholder title and body.
 */
export function buildPushAlert(input: PushAlertBuildInput): CheckedPushMessageV2 {
  const kind: RemotePushAlertKind =
    input.source === "move-waiting"
      ? "move-waiting"
      : input.source === "device-joined"
        ? "device-joined"
        : input.kind;
  const urgency = remotePushUrgency(kind);
  const routing =
    input.source === "thread"
      ? { threadId: input.threadId, mode: input.mode }
      : input.source === "automation"
        ? input.threadId === undefined
          ? {}
          : {
              threadId: input.threadId,
              ...(input.mode === undefined ? {} : { mode: input.mode }),
            }
        : {};

  if (input.heldSecrets.status === "unavailable") {
    const alert: PushAlertV2 = {
      version: 2,
      kind,
      hostId: input.hostId,
      ...routing,
      title: REMOTE_PUSH_PLACEHOLDER_ALERT.title,
      body: REMOTE_PUSH_PLACEHOLDER_ALERT.body,
      collapseId: input.collapseId,
      urgency,
      sequence: input.sequence,
      occurredAt: input.occurredAt,
    };
    return brand({ type: "alert", alert });
  }

  const held = input.heldSecrets.values;
  let title: string;
  let body: string;

  switch (input.source) {
    case "thread": {
      title = checkedTitled(KIND_TITLE[input.kind], input.threadTitle, input.threadTitles, held);
      const shownProject = input.threadTitles ? checkPushLabel(input.projectName, held) : undefined;
      const computer = checkedComputerName(input.computerLabel, held);
      body =
        shownProject === undefined
          ? clampBytes(`On ${computer}`, MAX_BODY_BYTES)
          : clampBytes(
              `${clampBytes(shownProject, MAX_PROJECT_BYTES)} · On ${computer}`,
              MAX_BODY_BYTES,
            );
      break;
    }
    case "automation":
      title = checkedTitled(
        AUTOMATION_KIND_TITLE[input.kind],
        input.displayName,
        input.threadTitles,
        held,
      );
      body = checkedComputerBody(input.computerLabel, held);
      break;
    case "move-waiting": {
      const destination = checkPushLabel(input.destinationName, held) ?? FALLBACK_DESTINATION_NAME;
      title = MOVE_WAITING_TITLE;
      body = clampBytes(`To ${destination}`, MAX_BODY_BYTES);
      break;
    }
    case "device-joined": {
      // Private addresses are deliberately excluded from readable push payloads.
      const device = checkPushLabel(input.deviceName, held);
      title =
        device === undefined
          ? FALLBACK_DEVICE_TITLE
          : clampBytes(`New device: ${device}`, MAX_TITLE_BYTES);
      body =
        input.joined === "hub"
          ? "Joined the hub"
          : clampBytes(
              `Paired with ${checkedComputerName(input.computerLabel, held)}`,
              MAX_BODY_BYTES,
            );
      break;
    }
  }

  const alert: PushAlertV2 = {
    version: 2,
    kind,
    hostId: input.hostId,
    ...routing,
    title,
    body,
    collapseId: input.collapseId,
    urgency,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
  };
  return brand({ type: "alert", alert });
}

export interface LiveStatusRowInput {
  readonly threadId: string;
  readonly mode: RemotePushNotificationMode;
  readonly status: LiveStatusRowState;
  readonly title?: string;
  readonly projectName?: string;
  readonly updatedAt: UtcTimestamp;
}

export interface LiveStatusBuildInput {
  readonly hostId: StableHostId;
  readonly computerLabel: string;
  readonly event: LiveStatusEventV1;
  readonly counts: LiveStatusCountsV1;
  readonly rows: ReadonlyArray<LiveStatusRowInput>;
  /** Whether "Show thread names" is enabled for this phone. */
  readonly threadTitles: boolean;
  readonly sequence: number;
  readonly occurredAt: UtcTimestamp;
  readonly staleAt: UtcTimestamp;
  readonly heldSecrets: HeldSecretSnapshot;
}

/**
 * Builds a checked live-status push message for iOS Live Activities and Android
 * Live Updates: at most five rows ordered needs-you, failed, working, done.
 * When `heldSecrets` is unavailable, emits the generic computer label and omits
 * every thread title and project name.
 */
export function buildLiveStatusPushMessage(input: LiveStatusBuildInput): CheckedPushMessageV2 {
  const sorted = [...input.rows]
    .sort((left, right) => {
      const priority = LIVE_STATUS_PRIORITY[left.status] - LIVE_STATUS_PRIORITY[right.status];
      if (priority !== 0) return priority;
      return String(right.updatedAt).localeCompare(String(left.updatedAt));
    })
    .slice(0, MAX_LIVE_STATUS_ROWS);

  const urgent = sorted.some(
    (row) =>
      row.status === "approval-needed" || row.status === "needs-input" || row.status === "failed",
  );
  const urgency: RemotePushUrgency = urgent ? "high" : "normal";

  if (input.heldSecrets.status === "unavailable") {
    const liveStatus: LiveStatusV1 = {
      version: 1,
      hostId: input.hostId,
      computerName: FALLBACK_COMPUTER_NAME,
      event: input.event,
      counts: input.counts,
      rows: sorted.map((row) => ({
        threadId: row.threadId,
        mode: row.mode,
        status: row.status,
        updatedAt: row.updatedAt,
      })),
      sequence: input.sequence,
      occurredAt: input.occurredAt,
      staleAt: input.staleAt,
      urgency,
    };
    return brand({ type: "live-status", liveStatus });
  }

  const held = input.heldSecrets.values;
  const rows: ReadonlyArray<LiveStatusRowV1> = sorted.map((row) => {
    const checkedTitle = input.threadTitles ? checkPushLabel(row.title, held) : undefined;
    const checkedProject = input.threadTitles ? checkPushLabel(row.projectName, held) : undefined;
    return {
      threadId: row.threadId,
      mode: row.mode,
      status: row.status,
      ...(checkedTitle === undefined ? {} : { title: clampBytes(checkedTitle, MAX_TITLE_BYTES) }),
      ...(checkedProject === undefined
        ? {}
        : { projectName: clampBytes(checkedProject, MAX_PROJECT_BYTES) }),
      updatedAt: row.updatedAt,
    };
  });

  const liveStatus: LiveStatusV1 = {
    version: 1,
    hostId: input.hostId,
    computerName: checkedComputerName(input.computerLabel, held),
    event: input.event,
    counts: input.counts,
    rows,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    staleAt: input.staleAt,
    urgency,
  };
  return brand({ type: "live-status", liveStatus });
}

function fallbackAlertTitleForKind(kind: RemotePushAlertKind): string {
  switch (kind) {
    case "move-waiting":
      return MOVE_WAITING_TITLE;
    case "device-joined":
      return FALLBACK_DEVICE_TITLE;
    default:
      return KIND_TITLE[kind];
  }
}

function fallbackAlertBodyForKind(kind: RemotePushAlertKind): string {
  switch (kind) {
    case "move-waiting":
      return `To ${FALLBACK_DESTINATION_NAME}`;
    case "device-joined":
      return `Paired with ${FALLBACK_COMPUTER_NAME}`;
    default:
      return `On ${FALLBACK_COMPUTER_NAME}`;
  }
}

/**
 * Hub-side re-check before delivering a spoke's `HubPushHandoffV2`. Re-runs
 * `checkPushLabel` against the hub's own held secrets and credential patterns
 * so a spoke's message cannot leak a secret the hub holds, and fails closed to
 * the generic placeholder when the hub's check cannot run.
 */
export function recheckHubPushMessage(
  message: PushMessageV2,
  heldSecrets: HeldSecretSnapshot,
): CheckedPushMessageV2 {
  if (message.type === "alert") {
    const { alert } = message;
    if (heldSecrets.status === "unavailable") {
      return brand({
        type: "alert",
        alert: {
          ...alert,
          title: REMOTE_PUSH_PLACEHOLDER_ALERT.title,
          body: REMOTE_PUSH_PLACEHOLDER_ALERT.body,
        },
      });
    }
    const checkedTitle = checkPushLabel(alert.title, heldSecrets.values);
    const checkedBody = checkPushLabel(alert.body, heldSecrets.values);
    return brand({
      type: "alert",
      alert: {
        ...alert,
        title:
          checkedTitle === undefined
            ? fallbackAlertTitleForKind(alert.kind)
            : clampBytes(checkedTitle, MAX_TITLE_BYTES),
        body:
          checkedBody === undefined
            ? fallbackAlertBodyForKind(alert.kind)
            : clampBytes(checkedBody, MAX_BODY_BYTES),
      },
    });
  }

  const { liveStatus } = message;
  if (heldSecrets.status === "unavailable") {
    return brand({
      type: "live-status",
      liveStatus: {
        ...liveStatus,
        computerName: FALLBACK_COMPUTER_NAME,
        rows: liveStatus.rows.map((row) => ({
          threadId: row.threadId,
          mode: row.mode,
          status: row.status,
          updatedAt: row.updatedAt,
        })),
      },
    });
  }
  const held = heldSecrets.values;
  return brand({
    type: "live-status",
    liveStatus: {
      ...liveStatus,
      computerName: checkedComputerName(liveStatus.computerName, held),
      rows: liveStatus.rows.map((row) => {
        const title = checkPushLabel(row.title, held);
        const projectName = checkPushLabel(row.projectName, held);
        return {
          threadId: row.threadId,
          mode: row.mode,
          status: row.status,
          ...(title === undefined ? {} : { title: clampBytes(title, MAX_TITLE_BYTES) }),
          ...(projectName === undefined
            ? {}
            : { projectName: clampBytes(projectName, MAX_PROJECT_BYTES) }),
          updatedAt: row.updatedAt,
        };
      }),
    },
  });
}

/** Whether a phone hears about new devices: on unless it turned them off. */
export function remotePushWantsNewDevices(preferences: RemotePushPreferencesV1): boolean {
  return preferences.newDevices !== false;
}

/** Map notifiable Automation run lifecycles onto push kinds. */
export function automationNotificationKindForLifecycle(
  lifecycle: AutomationRunLifecycle,
): AutomationNotificationKind | undefined {
  switch (lifecycle) {
    case "awaiting-confirmation":
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
export function remotePushUrgency(kind: RemotePushAlertKind): RemotePushUrgency {
  // A device the person did not add is worth seeing at once.
  return kind === "approval-needed" ||
    kind === "waiting" ||
    kind === "move-waiting" ||
    kind === "device-joined"
    ? "high"
    : "normal";
}
