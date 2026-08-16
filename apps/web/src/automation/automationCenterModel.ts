import {
  decodeAutomationDefinitionDraft,
  type AutomationAuthorityProfileReceipt,
  type AutomationBindingReceipt,
  type AutomationBlockReason,
  type AutomationDefinitionDraft,
  type AutomationExecutionProfileReceipt,
  type AutomationLifecycle,
  type AutomationMissedRunPolicy,
  type AutomationMode,
  type AutomationRun,
  type AutomationRunLifecycle,
  type AutomationTrigger,
} from "@octant/contracts";

/**
 * Pure presentation and form policy for the Automation Center. Everything the
 * server owns (final validation, occurrence identity, authority) stays on the
 * server; this module only names sanitized projection facts and assembles the
 * strict A1 draft for client-side pre-validation.
 */

// ── Named status text ────────────────────────────────────────────────────────

const lifecycleLabels: Record<AutomationLifecycle, string> = {
  enabled: "Enabled",
  paused: "Paused",
  exhausted: "Completed schedule",
  archived: "Archived",
};

export function automationLifecycleLabel(lifecycle: AutomationLifecycle): string {
  return lifecycleLabels[lifecycle];
}

const runStatusLabels: Record<AutomationRunLifecycle, string> = {
  queued: "Queued",
  dispatching: "Dispatching",
  "recovering-dispatch": "Recovering",
  running: "Running",
  waiting: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  skipped: "Skipped",
};

export function automationRunStatusLabel(lifecycle: AutomationRunLifecycle): string {
  return runStatusLabels[lifecycle];
}

export function automationModeLabel(mode: AutomationMode): string {
  return mode === "work" ? "Work" : "Code";
}

export function automationMissedRunPolicyLabel(policy: AutomationMissedRunPolicy): string {
  return policy === "skip" ? "Skip missed runs" : "Run the newest missed occurrence once";
}

const blockReasonLabels: Record<AutomationBlockReason, string> = {
  "missed-run-cap-exceeded":
    "Paused automatically: too many missed runs. Resume after reviewing the schedule.",
  "host-mismatch": "The owning host no longer matches. Edit and resume to revalidate.",
  "project-mismatch": "The bound Project no longer matches. Edit and resume to revalidate.",
  "binding-mismatch": "The Project binding no longer matches. Edit and resume to revalidate.",
  "execution-profile-mismatch":
    "The execution profile no longer matches. Edit and resume to revalidate.",
  "provider-capability-mismatch":
    "The provider or model capability no longer matches. Edit and resume to revalidate.",
  "authority-mismatch": "The authority profile no longer matches. Edit and resume to revalidate.",
  "delivery-target-invalid":
    "The confirmed delivery target is no longer valid. Edit and confirm a new target.",
  "full-access-ineligible":
    "Full access authority is not eligible for automations. Choose an approval-gated profile.",
  "unsupported-mode": "This mode is not supported for automations.",
  "automation-recursion": "Automation-created work cannot manage automations.",
};

export function automationBlockReasonLabel(reason: AutomationBlockReason): string {
  return blockReasonLabels[reason];
}

// ── Instant and trigger formatting ───────────────────────────────────────────

export interface AutomationFormatOptions {
  /** IANA timezone for display; defaults to the viewer's local timezone. */
  readonly timeZone?: string;
}

export function formatAutomationInstant(
  instant: string,
  options: AutomationFormatOptions = {},
): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

export function automationNextRunLabel(
  nextDueAt: string | null,
  options: AutomationFormatOptions = {},
): string {
  return nextDueAt === null ? "Not scheduled" : formatAutomationInstant(nextDueAt, options);
}

const weekdayShortLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function intervalPhrase(intervalMinutes: number): string {
  if (intervalMinutes % 1_440 === 0) {
    const days = intervalMinutes / 1_440;
    return days === 1 ? "Every day" : `Every ${days} days`;
  }
  if (intervalMinutes % 60 === 0) {
    const hours = intervalMinutes / 60;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  return `Every ${intervalMinutes} minutes`;
}

export function automationTriggerSummary(
  trigger: AutomationTrigger,
  options: AutomationFormatOptions = {},
): string {
  switch (trigger.kind) {
    case "once":
      return `Once at ${formatAutomationInstant(trigger.scheduledAt, options)}`;
    case "interval":
      return `${intervalPhrase(trigger.intervalMinutes)} from ${formatAutomationInstant(
        trigger.anchorAt,
        options,
      )}`;
    case "weekly-local": {
      const days = [...trigger.weekdays]
        .sort((left, right) => left - right)
        .map((weekday) => weekdayShortLabels[weekday - 1])
        .join(", ");
      return `Weekly on ${days} at ${trigger.localTime} (${trigger.timeZone})`;
    }
  }
}

// ── Authority summary ────────────────────────────────────────────────────────

const executionPolicyLabels = {
  plan: "Plan (read-only)",
  "approval-gated": "Approval-gated",
  "full-access": "Full access",
} as const;

const authorityCapabilityKeys = [
  "filesystem",
  "shell",
  "git",
  "network",
  "tools",
  "subagents",
] as const;

export function automationAuthoritySummary(profile: AutomationAuthorityProfileReceipt): string {
  const effective = profile.effective;
  const capabilities = authorityCapabilityKeys.filter((key) => effective[key]);
  const capabilityText = capabilities.length === 0 ? "no capabilities" : capabilities.join(", ");
  const persistence =
    effective.permissionPersistence === "current-session" ? "this session only" : "Project default";
  return `${executionPolicyLabels[effective.executionPolicy]} · ${capabilityText} · ${persistence}`;
}

// ── Ordinary-thread navigation targets ──────────────────────────────────────

export interface AutomationThreadTarget {
  readonly mode: AutomationMode;
  readonly threadId: string;
}

/**
 * A run navigates to its ordinary thread only after a thread-creation receipt
 * exists. Pre-thread outcomes (queued/dispatch/validation failures) stay on
 * the Automation run itself.
 */
export function automationRunThreadTarget(run: AutomationRun): AutomationThreadTarget | undefined {
  if (run.threadId === undefined) return undefined;
  return { mode: run.definitionSnapshot.mode, threadId: String(run.threadId) };
}

// ── Creation/edit form assembly ──────────────────────────────────────────────

export interface AutomationHostOption {
  readonly hostId: string;
  readonly label: string;
}

export interface AutomationProjectOption {
  readonly projectId: AutomationDefinitionDraft["projectId"];
  readonly name: string;
  readonly mode: AutomationMode;
  readonly projectVersion: AutomationDefinitionDraft["projectVersion"];
  readonly binding: AutomationBindingReceipt;
}

export interface AutomationExecutionProfileOption {
  readonly label: string;
  readonly receipt: AutomationExecutionProfileReceipt;
}

export interface AutomationAuthorityProfileOption {
  readonly label: string;
  readonly receipt: AutomationAuthorityProfileReceipt;
}

/** Server-provided facts the editor may choose between; never renderer truth. */
export interface AutomationEditorCatalog {
  readonly hosts: readonly AutomationHostOption[];
  readonly projects: readonly AutomationProjectOption[];
  readonly executionProfiles: readonly AutomationExecutionProfileOption[];
  readonly authorityProfiles: readonly AutomationAuthorityProfileOption[];
  readonly actorId: string;
}

export type AutomationTriggerFormValue =
  | { readonly kind: "once"; readonly scheduledAt: string }
  | { readonly kind: "interval"; readonly anchorAt: string; readonly intervalMinutes: number }
  | {
      readonly kind: "weekly-local";
      readonly weekdays: readonly number[];
      readonly localTime: string;
      readonly timeZone: string;
    };

export interface AutomationDraftFormInput {
  readonly displayName: string;
  readonly taskPrompt: string;
  readonly hostId: string;
  readonly mode: AutomationMode;
  readonly project: AutomationProjectOption | undefined;
  readonly executionProfile: AutomationExecutionProfileReceipt | undefined;
  readonly authorityProfile: AutomationAuthorityProfileReceipt | undefined;
  readonly trigger: AutomationTriggerFormValue;
  readonly missedRunPolicy: AutomationMissedRunPolicy;
  readonly deliveryTargetSummary: string;
  readonly deliveryTargetConfirmed: boolean;
  readonly previousDeliveryTargetRevision?: number;
  readonly actorId: string;
  /** Strict UTC timestamp used as the confirmation instant. */
  readonly now: string;
  readonly generateId: () => string;
}

export type AutomationDraftBuildResult =
  | { readonly kind: "valid"; readonly draft: AutomationDefinitionDraft }
  | { readonly kind: "invalid"; readonly issues: readonly string[] };

export const MAX_AUTOMATION_NAME_LENGTH = 255;
export const MAX_AUTOMATION_PROMPT_LENGTH = 8_192;
export const MAX_AUTOMATION_TARGET_LENGTH = 2_048;

const FULL_ACCESS_ISSUE =
  "Full access profiles are not eligible for automations. Choose an approval-gated profile.";
const CONTRACT_ISSUE =
  "The selection does not satisfy the automation contract. Match host, mode, and Project across every choice.";

function isStrictUtcInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function isValidAutomationTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function triggerIssues(trigger: AutomationTriggerFormValue): readonly string[] {
  switch (trigger.kind) {
    case "once":
      return isStrictUtcInstant(trigger.scheduledAt) ? [] : ["Choose a valid start time."];
    case "interval": {
      const issues: string[] = [];
      if (!isStrictUtcInstant(trigger.anchorAt)) issues.push("Choose a valid start time.");
      if (
        !Number.isInteger(trigger.intervalMinutes) ||
        trigger.intervalMinutes < 15 ||
        trigger.intervalMinutes > 43_200
      ) {
        issues.push("Repeat intervals run from 15 minutes to 30 days.");
      }
      return issues;
    }
    case "weekly-local": {
      const issues: string[] = [];
      if (trigger.weekdays.length === 0) issues.push("Choose at least one weekday.");
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trigger.localTime)) {
        issues.push("Choose a valid time of day.");
      }
      if (!isValidAutomationTimeZone(trigger.timeZone)) {
        issues.push("Choose a valid IANA timezone.");
      }
      return issues;
    }
  }
}

function normalizedTrigger(trigger: AutomationTriggerFormValue): unknown {
  if (trigger.kind !== "weekly-local") return trigger;
  return {
    kind: "weekly-local",
    weekdays: [...new Set(trigger.weekdays)].sort((left, right) => left - right),
    localTime: trigger.localTime,
    timeZone: trigger.timeZone,
  };
}

export function buildAutomationDraft(input: AutomationDraftFormInput): AutomationDraftBuildResult {
  const issues: string[] = [];
  const displayName = input.displayName.trim();
  const taskPrompt = input.taskPrompt.trim();
  const targetSummary = input.deliveryTargetSummary.trim();

  if (displayName.length === 0) issues.push("Name the automation.");
  if (displayName.length > MAX_AUTOMATION_NAME_LENGTH) {
    issues.push(`Keep the name under ${MAX_AUTOMATION_NAME_LENGTH} characters.`);
  }
  if (taskPrompt.length === 0) issues.push("Describe the task for each run.");
  if (taskPrompt.length > MAX_AUTOMATION_PROMPT_LENGTH) {
    issues.push(`Keep the task under ${MAX_AUTOMATION_PROMPT_LENGTH} characters.`);
  }
  if (input.project === undefined) issues.push("Choose the exact Project.");
  if (input.executionProfile === undefined) {
    issues.push("Choose an execution profile.");
  } else if (input.executionProfile.executionPolicy === "full-access") {
    issues.push(FULL_ACCESS_ISSUE);
  }
  if (input.authorityProfile === undefined) {
    issues.push("Choose an authority profile.");
  } else if (
    input.authorityProfile.requested.executionPolicy === "full-access" ||
    input.authorityProfile.effective.executionPolicy === "full-access"
  ) {
    issues.push(FULL_ACCESS_ISSUE);
  }
  issues.push(...crossConsistencyIssues(input));
  issues.push(...triggerIssues(input.trigger));
  if (targetSummary.length === 0) issues.push("Describe the delivery target.");
  if (targetSummary.length > MAX_AUTOMATION_TARGET_LENGTH) {
    issues.push(`Keep the delivery target under ${MAX_AUTOMATION_TARGET_LENGTH} characters.`);
  }
  if (!input.deliveryTargetConfirmed) issues.push("Confirm the delivery target before saving.");

  if (issues.length > 0) return { kind: "invalid", issues: dedupe(issues) };

  const candidate = {
    displayName,
    taskPrompt,
    hostId: input.hostId,
    mode: input.mode,
    projectId: input.project!.projectId,
    projectVersion: input.project!.projectVersion,
    binding: input.project!.binding,
    executionProfile: input.executionProfile,
    authorityProfile: input.authorityProfile,
    deliveryTarget: {
      revisionId: input.generateId(),
      revision: (input.previousDeliveryTargetRevision ?? 0) + 1,
      mode: input.mode,
      summary: targetSummary,
      confirmed: true,
      confirmedBy: input.actorId,
      confirmedAt: input.now,
    },
    trigger: normalizedTrigger(input.trigger),
    missedRunPolicy: input.missedRunPolicy,
    targetPolicy: "new-thread",
  };
  try {
    return { kind: "valid", draft: decodeAutomationDefinitionDraft(candidate) };
  } catch {
    return { kind: "invalid", issues: [CONTRACT_ISSUE] };
  }
}

function dedupe(issues: readonly string[]): readonly string[] {
  return [...new Set(issues)];
}

/**
 * Client-side mirror of the server's definition policy: every selection must
 * name the same host, mode, and Project, and Work authority can never carry
 * shell or Git capability. The server re-validates authoritatively on save.
 */
function crossConsistencyIssues(input: AutomationDraftFormInput): readonly string[] {
  const project = input.project;
  const execution = input.executionProfile;
  const authority = input.authorityProfile;
  const mismatch =
    (project !== undefined &&
      (project.mode !== input.mode ||
        project.binding.kind !== input.mode ||
        String(project.binding.hostId) !== input.hostId ||
        project.binding.projectId !== project.projectId)) ||
    (execution !== undefined &&
      (String(execution.hostId) !== input.hostId ||
        execution.mode !== input.mode ||
        (project !== undefined && execution.projectId !== project.projectId))) ||
    (authority !== undefined &&
      input.mode === "work" &&
      (authority.effective.shell || authority.effective.git));
  return mismatch ? [CONTRACT_ISSUE] : [];
}
