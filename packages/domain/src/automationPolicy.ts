import { decodeAgentRunAuthority, type AgentRunAuthority } from "@octant/contracts/agent-run";
import {
  decodeAutomationId,
  decodeAutomationRunNowRequestId,
  decodeAutomationDefinition,
  decodeAutomationDefinitionRevision,
  decodeAutomationTrigger,
  type AutomationDefinition,
  type AutomationId,
  type AutomationLocalDate,
  type AutomationLocalTime,
  type AutomationOccurrenceKeyText,
  type AutomationOrigin,
  type AutomationRunLifecycle,
  type AutomationTrigger,
  type AutomationTriggerKind,
  type AutomationWeeklyResolution,
} from "@octant/contracts/automation";
import type { AutomationRunNowRequestId } from "@octant/contracts/automation";
import type { UtcTimestamp } from "@octant/contracts/events";

export const AUTOMATION_MAX_RECONCILIATION_CAP = 10_000;
export const AUTOMATION_DEFAULT_RECONCILIATION_CAP = 128;

export type AutomationPolicyRejectionCode =
  | "invalid-trigger"
  | "invalid-date"
  | "invalid-time-zone"
  | "unsafe-reconciliation-cap"
  | "invalid-definition"
  | "unsupported-mode"
  | "binding-mismatch"
  | "profile-mismatch"
  | "delivery-target-invalid"
  | "authority-widening"
  | "full-access-ineligible"
  | "automation-recursion"
  | "invalid-revision";

export class AutomationPolicyRejected extends Error {
  override readonly name = "AutomationPolicyRejected";

  constructor(
    readonly code: AutomationPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: AutomationPolicyRejectionCode, message: string): never {
  throw new AutomationPolicyRejected(code, message);
}

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LOCAL_SEARCH_DAYS = 14;
const LOCAL_OFFSET_SAMPLE_RADIUS_HOURS = 48;
const LOCAL_OFFSET_SAMPLE_STEP_HOURS = 6;
const LOCAL_TRANSITION_PROBE_HOURS = 36;
const LOCAL_TRANSITION_SEARCH_ITERATIONS = 40;

function parseUtc(value: string): number {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) {
    return reject(
      "invalid-date",
      "Automation timestamps must be canonical millisecond UTC values.",
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return reject("invalid-date", "Automation timestamp is not a valid UTC instant.");
  }
  return parsed.getTime();
}

function toUtcTimestamp(epochMs: number): UtcTimestamp {
  if (!Number.isFinite(epochMs)) {
    return reject("invalid-date", "Automation occurrence resolved to a non-finite instant.");
  }
  try {
    return new Date(epochMs).toISOString() as UtcTimestamp;
  } catch {
    return reject("invalid-date", "Automation occurrence resolved outside the UTC date range.");
  }
}

function decodeTrigger(input: AutomationTrigger): AutomationTrigger {
  try {
    return decodeAutomationTrigger(input);
  } catch {
    return reject("invalid-trigger", "Automation trigger failed strict validation.");
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

interface LocalDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function localDateTimeParts(epochMs: number, timeZone: string): LocalDateTimeParts {
  if (!isValidTimeZone(timeZone)) {
    return reject("invalid-time-zone", `Unknown IANA timezone: ${timeZone}`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const values = new Map(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if ([year, month, day, hour, minute, second].some((value) => value === undefined)) {
    return reject("invalid-time-zone", "Timezone formatter returned incomplete local time parts.");
  }
  return {
    year: year as number,
    month: month as number,
    day: day as number,
    hour: hour as number,
    minute: minute as number,
    second: second as number,
  };
}

function localDateAsUtc(parts: Pick<LocalDateTimeParts, "year" | "month" | "day">): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function localWallAsUtc(parts: LocalDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetMinutesAt(epochMs: number, timeZone: string): number {
  const local = localDateTimeParts(epochMs, timeZone);
  return (localWallAsUtc(local) - epochMs) / MINUTE_MS;
}

function sameLocalMinute(epochMs: number, timeZone: string, desired: LocalDateTimeParts): boolean {
  const actual = localDateTimeParts(epochMs, timeZone);
  return (
    actual.year === desired.year &&
    actual.month === desired.month &&
    actual.day === desired.day &&
    actual.hour === desired.hour &&
    actual.minute === desired.minute &&
    actual.second === desired.second
  );
}

function sampledOffsetsAroundLocalWall(nominal: number, timeZone: string): ReadonlySet<number> {
  const offsets = new Set<number>();
  for (
    let hours = -LOCAL_OFFSET_SAMPLE_RADIUS_HOURS;
    hours <= LOCAL_OFFSET_SAMPLE_RADIUS_HOURS;
    hours += LOCAL_OFFSET_SAMPLE_STEP_HOURS
  ) {
    offsets.add(offsetMinutesAt(nominal + hours * 60 * MINUTE_MS, timeZone));
  }
  return offsets;
}

function possibleInstantsForLocalMinute(
  desired: LocalDateTimeParts,
  timeZone: string,
): ReadonlyArray<number> {
  const nominal = localWallAsUtc(desired);
  const offsets = sampledOffsetsAroundLocalWall(nominal, timeZone);
  const candidates = new Set<number>();
  for (const offset of offsets) {
    const candidate = nominal - offset * MINUTE_MS;
    if (sameLocalMinute(candidate, timeZone, desired)) candidates.add(candidate);
  }
  return [...candidates].sort((left, right) => left - right);
}

function firstInstantAfterForwardTransition(
  lowerBound: number,
  upperBound: number,
  beforeOffset: number,
  timeZone: string,
): number {
  let left = lowerBound;
  let right = upperBound;
  for (let iteration = 0; iteration < LOCAL_TRANSITION_SEARCH_ITERATIONS; iteration += 1) {
    if (left >= right) break;
    const midpoint = left + Math.floor((right - left) / 2);
    if (offsetMinutesAt(midpoint, timeZone) <= beforeOffset) {
      left = midpoint + 1;
    } else {
      right = midpoint;
    }
  }
  return right;
}

function resolveForwardGap(desired: LocalDateTimeParts, timeZone: string): number | undefined {
  const nominal = localWallAsUtc(desired);
  const offsets = sampledOffsetsAroundLocalWall(nominal, timeZone);

  const resolutions: Array<{ readonly instant: number; readonly probe: number }> = [];
  for (const offset of offsets) {
    // A local wall time maps to this nominal instant under the sampled offset.
    // Probe around that candidate, rather than around the unadjusted wall-clock
    // timestamp, so positive-offset zones are sampled on both sides of UTC DST
    // transitions as well.
    const transitionProbe = nominal - offset * MINUTE_MS;
    const beforeOffset = offsetMinutesAt(
      transitionProbe - LOCAL_TRANSITION_PROBE_HOURS * 60 * MINUTE_MS,
      timeZone,
    );
    const afterOffset = offsetMinutesAt(
      transitionProbe + LOCAL_TRANSITION_PROBE_HOURS * 60 * MINUTE_MS,
      timeZone,
    );
    if (afterOffset <= beforeOffset) continue;

    const instant = firstInstantAfterForwardTransition(
      transitionProbe - LOCAL_TRANSITION_PROBE_HOURS * 60 * MINUTE_MS,
      transitionProbe + LOCAL_TRANSITION_PROBE_HOURS * 60 * MINUTE_MS,
      beforeOffset,
      timeZone,
    );
    const resolved = localDateTimeParts(instant, timeZone);
    if (
      resolved.year < desired.year ||
      (resolved.year === desired.year && resolved.month < desired.month) ||
      (resolved.year === desired.year &&
        resolved.month === desired.month &&
        (resolved.day < desired.day ||
          (resolved.day === desired.day &&
            (resolved.hour < desired.hour ||
              (resolved.hour === desired.hour && resolved.minute < desired.minute)))))
    ) {
      continue;
    }
    resolutions.push({ instant, probe: transitionProbe });
  }
  resolutions.sort((left, right) => left.instant - right.instant || left.probe - right.probe);
  return resolutions[0]?.instant;
}

/**
 * Resolve one local wall-clock minute using the approved deterministic policy:
 * an ambiguous fold chooses the earlier instant; a gap shifts the wall time
 * forward by the transition gap (the first valid representation of that
 * scheduled local minute).
 */
function resolveLocalMinute(desired: LocalDateTimeParts, timeZone: string): number | undefined {
  const candidates = possibleInstantsForLocalMinute(desired, timeZone);
  if (candidates.length > 0) return candidates[0];

  const nominal = localWallAsUtc(desired);
  const transitionResolved = resolveForwardGap(desired, timeZone);
  if (transitionResolved !== undefined) return transitionResolved;

  // Historical timezone transitions can be more unusual than a one-hour gap.
  // The bounded scan remains deterministic and prevents an unsafe unbounded
  // search when timezone data is malformed.
  for (let minute = 1; minute <= 48 * 60; minute += 1) {
    const candidate = nominal + minute * MINUTE_MS;
    const actual = localDateTimeParts(candidate, timeZone);
    if (
      actual.year > desired.year ||
      (actual.year === desired.year && actual.month > desired.month) ||
      (actual.year === desired.year &&
        actual.month === desired.month &&
        (actual.day > desired.day ||
          (actual.day === desired.day &&
            (actual.hour > desired.hour ||
              (actual.hour === desired.hour && actual.minute >= desired.minute)))))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function isoWeekday(nominalDateMs: number): number {
  const day = new Date(nominalDateMs).getUTCDay();
  return day === 0 ? 7 : day;
}

function nextLocalDate(
  localAfter: LocalDateTimeParts,
  dayOffset: number,
): {
  readonly dateMs: number;
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const dateMs = localDateAsUtc(localAfter) + dayOffset * DAY_MS;
  const date = new Date(dateMs);
  return {
    dateMs,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export interface ResolveNextAutomationOccurrenceInput {
  readonly trigger: AutomationTrigger;
  readonly after: UtcTimestamp;
  /** Defaults to false: schedulers ask for the next strictly future instant. */
  readonly inclusive?: boolean;
}

export function resolveWeeklyLocalOccurrence(
  trigger: Extract<AutomationTrigger, { readonly kind: "weekly-local" }>,
  after: UtcTimestamp,
  inclusive = false,
): UtcTimestamp | undefined {
  const validated = decodeTrigger(trigger);
  if (validated.kind !== "weekly-local") {
    return reject("invalid-trigger", "Weekly resolver requires a weekly-local trigger.");
  }
  const afterMs = parseUtc(after);
  const localAfter = localDateTimeParts(afterMs, validated.timeZone);
  for (let dayOffset = 0; dayOffset <= LOCAL_SEARCH_DAYS; dayOffset += 1) {
    const date = nextLocalDate(localAfter, dayOffset);
    if (!validated.weekdays.some((weekday) => weekday === isoWeekday(date.dateMs))) continue;
    const [hourText, minuteText] = validated.localTime.split(":") as [string, string];
    const desired: LocalDateTimeParts = {
      year: date.year,
      month: date.month,
      day: date.day,
      hour: Number(hourText),
      minute: Number(minuteText),
      second: 0,
    };
    const resolved = resolveLocalMinute(desired, validated.timeZone);
    if (resolved === undefined) continue;
    if (resolved > afterMs || (inclusive && resolved === afterMs)) {
      return toUtcTimestamp(resolved);
    }
  }
  return undefined;
}

export function resolveNextAutomationOccurrence(
  input: ResolveNextAutomationOccurrenceInput,
): UtcTimestamp | undefined {
  const trigger = decodeTrigger(input.trigger);
  const afterMs = parseUtc(input.after);
  const inclusive = input.inclusive ?? false;
  switch (trigger.kind) {
    case "once": {
      const scheduledMs = parseUtc(trigger.scheduledAt);
      return scheduledMs > afterMs || (inclusive && scheduledMs === afterMs)
        ? trigger.scheduledAt
        : undefined;
    }
    case "interval": {
      const anchorMs = parseUtc(trigger.anchorAt);
      const intervalMs = trigger.intervalMinutes * MINUTE_MS;
      let occurrenceIndex = Math.ceil((afterMs - anchorMs) / intervalMs);
      if (!inclusive && anchorMs + occurrenceIndex * intervalMs <= afterMs) occurrenceIndex += 1;
      if (occurrenceIndex < 0) occurrenceIndex = 0;
      return toUtcTimestamp(anchorMs + occurrenceIndex * intervalMs);
    }
    case "weekly-local":
      return resolveWeeklyLocalOccurrence(trigger, input.after, inclusive);
  }
}

export interface BuildAutomationWeeklyResolutionInput {
  readonly trigger: Extract<AutomationTrigger, { readonly kind: "weekly-local" }>;
  readonly scheduledAt: UtcTimestamp;
  /** Bounded label for the timezone database that produced the resolution. */
  readonly timeZoneDatabase?: string;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Build the durable resolution evidence for one weekly-local occurrence. The
 * evidence makes replay deterministic even if timezone data later changes, so
 * the builder fails closed when the given instant is not the canonical
 * resolution of the trigger's local wall time under the approved DST policy
 * (fold chooses the earlier instant; a gap moves to the first valid instant).
 */
export function buildAutomationWeeklyResolution(
  input: BuildAutomationWeeklyResolutionInput,
): AutomationWeeklyResolution {
  const trigger = decodeTrigger(input.trigger);
  if (trigger.kind !== "weekly-local") {
    return reject("invalid-trigger", "Weekly resolution evidence requires a weekly-local trigger.");
  }
  const scheduledMs = parseUtc(input.scheduledAt);
  const local = localDateTimeParts(scheduledMs, trigger.timeZone);
  if (local.second !== 0) {
    return reject("invalid-date", "Weekly occurrences resolve on whole local minutes.");
  }
  if (!trigger.weekdays.some((weekday) => weekday === isoWeekday(localDateAsUtc(local)))) {
    return reject("invalid-date", "Weekly occurrence does not land on a configured weekday.");
  }

  const [hourText, minuteText] = trigger.localTime.split(":") as [string, string];
  const desired: LocalDateTimeParts = {
    year: local.year,
    month: local.month,
    day: local.day,
    hour: Number(hourText),
    minute: Number(minuteText),
    second: 0,
  };
  const candidates = possibleInstantsForLocalMinute(desired, trigger.timeZone);
  let resolution: AutomationWeeklyResolution["resolution"];
  if (candidates.length > 0) {
    if (scheduledMs !== candidates[0]) {
      return reject(
        "invalid-date",
        "Weekly occurrence is not the canonical earlier instant of its local minute.",
      );
    }
    resolution = candidates.length > 1 ? "fold-earlier" : "exact";
  } else {
    if (resolveLocalMinute(desired, trigger.timeZone) !== scheduledMs) {
      return reject(
        "invalid-date",
        "Weekly occurrence is not the first valid instant after the DST gap.",
      );
    }
    resolution = "gap-forward";
  }

  const resolvedLocalTime = `${twoDigits(local.hour)}:${twoDigits(local.minute)}`;
  if (resolution !== "gap-forward" && resolvedLocalTime !== trigger.localTime) {
    return reject("invalid-date", "Weekly occurrence does not match the trigger's local time.");
  }
  return {
    resolutionVersion: 1,
    timeZone: trigger.timeZone,
    timeZoneDatabase: input.timeZoneDatabase ?? "host-intl",
    resolvedAt: toUtcTimestamp(scheduledMs),
    resolvedLocalDate:
      `${local.year}-${twoDigits(local.month)}-${twoDigits(local.day)}` as AutomationLocalDate,
    resolvedLocalTime: resolvedLocalTime as AutomationLocalTime,
    utcOffsetMinutes: offsetMinutesAt(scheduledMs, trigger.timeZone),
    resolution,
  };
}

function recurringDueMatchesTrigger(
  trigger: Extract<AutomationTrigger, { readonly kind: "interval" | "weekly-local" }>,
  nextDueAt: UtcTimestamp,
  resolution: AutomationWeeklyResolution | undefined,
): boolean {
  if (trigger.kind === "weekly-local" && resolution !== undefined) {
    try {
      if (resolution.timeZone !== trigger.timeZone || resolution.resolvedAt !== nextDueAt) {
        return false;
      }
      const resolvedLocal = new Date(parseUtc(nextDueAt) + resolution.utcOffsetMinutes * MINUTE_MS);
      if (
        resolvedLocal.toISOString().slice(0, 10) !== resolution.resolvedLocalDate ||
        resolvedLocal.toISOString().slice(11, 16) !== resolution.resolvedLocalTime
      ) {
        return false;
      }
      const weekday = resolvedLocal.getUTCDay() || 7;
      if (!trigger.weekdays.includes(weekday as (typeof trigger.weekdays)[number])) {
        return false;
      }
      const [hourText, minuteText] = trigger.localTime.split(":") as [string, string];
      const triggerMinutes = Number(hourText) * 60 + Number(minuteText);
      const resolvedMinutes =
        Number(resolution.resolvedLocalTime.slice(0, 2)) * 60 +
        Number(resolution.resolvedLocalTime.slice(3, 5));
      return resolution.resolution === "gap-forward"
        ? resolvedMinutes >= triggerMinutes
        : resolution.resolvedLocalTime === trigger.localTime;
    } catch {
      return false;
    }
  }
  try {
    const dueMs = parseUtc(nextDueAt);
    const predecessor = toUtcTimestamp(dueMs - 1);
    return (
      resolveNextAutomationOccurrence({ trigger, after: predecessor, inclusive: true }) ===
      nextDueAt
    );
  } catch {
    return false;
  }
}

export const resolveNextOccurrence = resolveNextAutomationOccurrence;

export interface ReconcileMissedAutomationOccurrencesInput {
  readonly trigger: AutomationTrigger;
  readonly nextDueAt: UtcTimestamp | null;
  readonly now: UtcTimestamp;
  readonly policy: "skip" | "run-once";
  readonly cap?: number;
}

export type ReconcileMissedAutomationOccurrencesResult =
  | {
      readonly kind: "reconciled";
      readonly skipped: ReadonlyArray<UtcTimestamp>;
      readonly claimed: UtcTimestamp | undefined;
      readonly nextDueAt: UtcTimestamp | null;
    }
  | {
      readonly kind: "cap-exceeded";
      readonly reason: "missed-run-cap-exceeded";
      readonly examinedFrom: UtcTimestamp;
      readonly examinedThrough: UtcTimestamp;
      readonly nextDueAt: UtcTimestamp | null;
    };

function validateReconciliationCap(cap: number): number {
  if (!Number.isInteger(cap) || cap < 1 || cap > AUTOMATION_MAX_RECONCILIATION_CAP) {
    return reject(
      "unsafe-reconciliation-cap",
      `Automation missed-run cap must be an integer from 1 through ${AUTOMATION_MAX_RECONCILIATION_CAP}.`,
    );
  }
  return cap;
}

function enumerateMissedOccurrences(input: {
  readonly trigger: AutomationTrigger;
  readonly nextDueAt: UtcTimestamp;
  readonly now: UtcTimestamp;
  readonly limit: number;
}): ReadonlyArray<UtcTimestamp> {
  const nowMs = parseUtc(input.now);
  const occurrences: UtcTimestamp[] = [];
  let cursor = input.nextDueAt;
  for (let count = 0; count <= input.limit; count += 1) {
    const occurrence = resolveNextAutomationOccurrence({
      trigger: input.trigger,
      after: cursor,
      inclusive: true,
    });
    if (occurrence === undefined || parseUtc(occurrence) > nowMs) break;
    occurrences.push(occurrence);
    cursor = toUtcTimestamp(parseUtc(occurrence) + 1);
  }
  return occurrences;
}

export function reconcileMissedAutomationOccurrences(
  input: ReconcileMissedAutomationOccurrencesInput,
): ReconcileMissedAutomationOccurrencesResult {
  const cap = validateReconciliationCap(input.cap ?? AUTOMATION_DEFAULT_RECONCILIATION_CAP);
  const trigger = decodeTrigger(input.trigger);
  const nowMs = parseUtc(input.now);
  if (input.nextDueAt === null) {
    return { kind: "reconciled", skipped: [], claimed: undefined, nextDueAt: null };
  }
  const nextDueMs = parseUtc(input.nextDueAt);
  if (nextDueMs > nowMs) {
    return { kind: "reconciled", skipped: [], claimed: undefined, nextDueAt: input.nextDueAt };
  }
  const examined = enumerateMissedOccurrences({
    trigger,
    nextDueAt: input.nextDueAt,
    now: input.now,
    limit: cap,
  });
  if (examined.length > cap) {
    const bounded = examined.slice(0, cap);
    const nextDueAt = resolveNextAutomationOccurrence({ trigger, after: input.now });
    return {
      kind: "cap-exceeded",
      reason: "missed-run-cap-exceeded",
      examinedFrom: bounded[0]!,
      examinedThrough: bounded.at(-1)!,
      nextDueAt: nextDueAt ?? null,
    };
  }
  const latest = examined.at(-1);
  const claimed = input.policy === "run-once" ? latest : undefined;
  const skipped =
    input.policy === "run-once" && latest !== undefined ? examined.slice(0, -1) : examined;
  const nextDueAt = resolveNextAutomationOccurrence({ trigger, after: input.now });
  return { kind: "reconciled", skipped, claimed, nextDueAt: nextDueAt ?? null };
}

export const reconcileMissedOccurrences = reconcileMissedAutomationOccurrences;

export interface ScheduledAutomationOccurrenceKeyInput {
  readonly automationId: AutomationId;
  readonly definitionRevision: number;
  readonly triggerKind: AutomationTriggerKind;
  readonly scheduledAt: UtcTimestamp;
}

export function buildScheduledAutomationOccurrenceKey(
  input: ScheduledAutomationOccurrenceKeyInput,
): AutomationOccurrenceKeyText {
  try {
    const automationId = decodeAutomationId(input.automationId);
    const definitionRevision = decodeAutomationDefinitionRevision(input.definitionRevision);
    const scheduledAt = toUtcTimestamp(parseUtc(input.scheduledAt));
    if (!["once", "interval", "weekly-local"].includes(input.triggerKind)) {
      return reject("invalid-trigger", "Scheduled occurrence trigger kind is unsupported.");
    }
    return `scheduled:${String(automationId)}:${definitionRevision}:${input.triggerKind}:${scheduledAt}` as AutomationOccurrenceKeyText;
  } catch (error) {
    if (error instanceof AutomationPolicyRejected) throw error;
    return reject("invalid-revision", "Scheduled occurrence identity is malformed.");
  }
}

export interface ManualAutomationOccurrenceKeyInput {
  readonly automationId: AutomationId;
  readonly definitionRevision: number;
  readonly runNowRequestId: AutomationRunNowRequestId;
}

export function buildManualAutomationOccurrenceKey(
  input: ManualAutomationOccurrenceKeyInput,
): AutomationOccurrenceKeyText {
  try {
    const automationId = decodeAutomationId(input.automationId);
    const definitionRevision = decodeAutomationDefinitionRevision(input.definitionRevision);
    const runNowRequestId = decodeAutomationRunNowRequestId(input.runNowRequestId);
    return `manual:${String(automationId)}:${definitionRevision}:${String(runNowRequestId)}` as AutomationOccurrenceKeyText;
  } catch (error) {
    if (error instanceof AutomationPolicyRejected) throw error;
    return reject("invalid-revision", "Manual occurrence identity is malformed.");
  }
}

export const buildScheduledOccurrenceKey = buildScheduledAutomationOccurrenceKey;
export const buildManualOccurrenceKey = buildManualAutomationOccurrenceKey;

const authorityRank: Record<AgentRunAuthority["executionPolicy"], number> = {
  plan: 0,
  "approval-gated": 1,
  "auto-accept-edits": 2,
  "full-access": 3,
};

function decodeAuthority(input: AgentRunAuthority, label: string): AgentRunAuthority {
  try {
    return decodeAgentRunAuthority(input);
  } catch {
    return reject("authority-widening", `${label} automation authority is malformed.`);
  }
}

function automationAuthorityProfileFitsExecutionProfile(
  authorityProfile: AutomationDefinition["authorityProfile"],
  executionProfile: AutomationDefinition["executionProfile"],
): boolean {
  const executionPolicyCeiling = authorityRank[executionProfile.executionPolicy];
  return (
    authorityRank[authorityProfile.requested.executionPolicy] <= executionPolicyCeiling &&
    authorityRank[authorityProfile.effective.executionPolicy] <= executionPolicyCeiling &&
    (executionProfile.permissionPersistence === "project-default" ||
      (authorityProfile.requested.permissionPersistence === "current-session" &&
        authorityProfile.effective.permissionPersistence === "current-session"))
  );
}

export interface IntersectAutomationAuthorityInput {
  readonly requested: AgentRunAuthority;
  readonly hostCapability: AgentRunAuthority;
  readonly modeProjectCeiling: AgentRunAuthority;
  readonly savedProfile: AgentRunAuthority;
  readonly providerCapability: AgentRunAuthority;
  readonly mode: "work" | "code";
}

/**
 * Intersect all authority ceilings. The operation never grants a capability,
 * never inherits Full access, and never replaces a rejected profile with a
 * hidden fallback. Full-access automation profiles are rejected before the
 * boolean intersection is returned.
 */
export function intersectAutomationAuthority(
  input: IntersectAutomationAuthorityInput,
): AgentRunAuthority {
  const requested = decodeAuthority(input.requested, "Requested");
  const host = decodeAuthority(input.hostCapability, "Host");
  const modeProject = decodeAuthority(input.modeProjectCeiling, "Mode/Project");
  const saved = decodeAuthority(input.savedProfile, "Saved profile");
  const provider = decodeAuthority(input.providerCapability, "Provider");
  if (input.mode !== "work" && input.mode !== "code") {
    return reject("unsupported-mode", "Automation authority requires Work or Code mode.");
  }
  if (requested.executionPolicy === "full-access" || saved.executionPolicy === "full-access") {
    return reject(
      "full-access-ineligible",
      "Automation-origin work cannot use a Full access execution profile.",
    );
  }

  const ceilings = [host, modeProject, saved, provider];
  const capabilityKeys = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;
  const effective: AgentRunAuthority = {
    filesystem: requested.filesystem && ceilings.every((ceiling) => ceiling.filesystem),
    shell:
      input.mode === "work" ? false : requested.shell && ceilings.every((ceiling) => ceiling.shell),
    git: input.mode === "work" ? false : requested.git && ceilings.every((ceiling) => ceiling.git),
    network: requested.network && ceilings.every((ceiling) => ceiling.network),
    tools: requested.tools && ceilings.every((ceiling) => ceiling.tools),
    subagents: requested.subagents && ceilings.every((ceiling) => ceiling.subagents),
    executionPolicy: ceilings.reduce<AgentRunAuthority["executionPolicy"]>(
      (current, ceiling) =>
        authorityRank[ceiling.executionPolicy] < authorityRank[current]
          ? ceiling.executionPolicy
          : current,
      requested.executionPolicy,
    ),
    permissionPersistence:
      requested.permissionPersistence === "project-default" &&
      ceilings.every((ceiling) => ceiling.permissionPersistence === "project-default")
        ? "project-default"
        : "current-session",
  };

  for (const key of capabilityKeys) {
    if (effective[key] && !requested[key]) {
      return reject("authority-widening", `Automation authority widened ${key}.`);
    }
  }
  return effective;
}

export const intersectAuthority = intersectAutomationAuthority;

export function isAutomationMutationAllowed(origin: AutomationOrigin): boolean {
  return origin.kind === "interactive";
}

export function assertAutomationMutationAllowed(origin: AutomationOrigin): void {
  if (!isAutomationMutationAllowed(origin)) {
    reject(
      "automation-recursion",
      "Automation-origin execution cannot create, edit, control, or archive an automation.",
    );
  }
}

export function canExhaustOnceAutomation(input: {
  readonly trigger: AutomationTrigger;
  readonly currentDefinitionRevision: number;
  readonly occurrenceDefinitionRevision: number;
  readonly currentOnceAt: UtcTimestamp;
  readonly occurrenceScheduledAt: UtcTimestamp;
  readonly terminal: boolean;
}): boolean {
  if (!input.terminal || input.trigger.kind !== "once") return false;
  if (input.currentDefinitionRevision !== input.occurrenceDefinitionRevision) return false;
  try {
    return (
      parseUtc(input.currentOnceAt) === parseUtc(input.occurrenceScheduledAt) &&
      parseUtc(input.trigger.scheduledAt) === parseUtc(input.occurrenceScheduledAt)
    );
  } catch {
    return false;
  }
}

export type AutomationRunNowDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "duplicate"; readonly runId: string }
  | {
      readonly kind: "active-conflict";
      readonly runId: string;
      readonly lifecycle: AutomationRunLifecycle;
    };

const ACTIVE_AUTOMATION_RUN_LIFECYCLES = new Set<AutomationRunLifecycle>([
  "queued",
  "dispatching",
  "recovering-dispatch",
  "running",
  "waiting",
]);

/** True when the run still occupies its Automation's single active slot. */
export function isAutomationRunLifecycleActive(lifecycle: AutomationRunLifecycle): boolean {
  return ACTIVE_AUTOMATION_RUN_LIFECYCLES.has(lifecycle);
}

export function classifyAutomationRunNow(input: {
  readonly requestedRunNowRequestId: AutomationRunNowRequestId;
  readonly existing?: {
    readonly runId: string;
    readonly requestId: AutomationRunNowRequestId;
    readonly lifecycle: AutomationRunLifecycle;
  };
}): AutomationRunNowDecision {
  if (input.existing === undefined) return { kind: "allowed" };
  if (input.existing.requestId === input.requestedRunNowRequestId) {
    return { kind: "duplicate", runId: input.existing.runId };
  }
  if (ACTIVE_AUTOMATION_RUN_LIFECYCLES.has(input.existing.lifecycle)) {
    return {
      kind: "active-conflict",
      runId: input.existing.runId,
      lifecycle: input.existing.lifecycle,
    };
  }
  return { kind: "allowed" };
}

export function validateAutomationDefinition(input: AutomationDefinition): AutomationDefinition {
  let definition: AutomationDefinition;
  try {
    definition = decodeAutomationDefinition(input);
  } catch {
    return reject("invalid-definition", "Automation definition failed strict validation.");
  }
  if (definition.mode !== definition.binding.kind) {
    return reject("binding-mismatch", "Automation mode and binding mode must match exactly.");
  }
  if (
    definition.binding.hostId !== definition.hostId ||
    definition.binding.projectId !== definition.projectId ||
    definition.binding.projectVersion !== definition.projectVersion
  ) {
    return reject(
      "binding-mismatch",
      "Automation binding must name the exact host and Project revision.",
    );
  }
  if (
    definition.executionProfile.hostId !== definition.hostId ||
    definition.executionProfile.mode !== definition.mode ||
    definition.executionProfile.projectId !== definition.projectId
  ) {
    return reject(
      "profile-mismatch",
      "Automation execution profile is bound to a different scope.",
    );
  }
  if (
    definition.deliveryTarget.mode !== definition.mode ||
    definition.deliveryTarget.confirmed !== true
  ) {
    return reject(
      "delivery-target-invalid",
      "Automation delivery target must be an exact confirmed template.",
    );
  }
  if (definition.lifecycle === "enabled" && definition.blockedReason !== undefined) {
    return reject(
      "invalid-definition",
      "Enabled automations cannot retain a validation block reason.",
    );
  }
  if (
    definition.lifecycle === "enabled" &&
    (definition.trigger.kind === "once"
      ? definition.nextDueAt !== definition.trigger.scheduledAt
      : definition.nextDueAt === null ||
        !recurringDueMatchesTrigger(
          definition.trigger,
          definition.nextDueAt,
          definition.nextDueResolution,
        ))
  ) {
    return reject(
      "invalid-definition",
      definition.trigger.kind === "once"
        ? "Enabled once automations must retain their configured due instant."
        : "Enabled recurring automations must retain a due occurrence.",
    );
  }
  if (
    definition.executionProfile.executionPolicy === "full-access" ||
    definition.authorityProfile.requested.executionPolicy === "full-access" ||
    definition.authorityProfile.effective.executionPolicy === "full-access"
  ) {
    return reject(
      "full-access-ineligible",
      "Automation definitions cannot persist Full access authority.",
    );
  }
  if (
    !automationAuthorityProfileFitsExecutionProfile(
      definition.authorityProfile,
      definition.executionProfile,
    )
  ) {
    return reject(
      "authority-widening",
      "Automation authority cannot exceed the selected execution profile.",
    );
  }
  const authorityKeys = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;
  for (const key of authorityKeys) {
    if (definition.authorityProfile.effective[key] && !definition.authorityProfile.requested[key]) {
      return reject("authority-widening", `Automation authority widened ${key}.`);
    }
  }
  if (
    definition.authorityProfile.requested.permissionPersistence === "current-session" &&
    definition.authorityProfile.effective.permissionPersistence === "project-default"
  ) {
    return reject(
      "authority-widening",
      "Automation authority cannot widen permission persistence beyond the requested profile.",
    );
  }
  if (
    authorityRank[definition.authorityProfile.effective.executionPolicy] >
    authorityRank[definition.authorityProfile.requested.executionPolicy]
  ) {
    return reject("authority-widening", "Automation authority cannot widen execution policy.");
  }
  if (
    definition.mode === "work" &&
    (definition.authorityProfile.effective.shell || definition.authorityProfile.effective.git)
  ) {
    return reject("authority-widening", "Work automation cannot receive shell or Git authority.");
  }
  if (
    (definition.lifecycle === "archived" || definition.lifecycle === "exhausted") &&
    definition.nextDueAt !== null
  ) {
    return reject(
      "invalid-definition",
      "Archived and exhausted automations cannot retain a due occurrence.",
    );
  }
  return definition;
}

// Kept as named aliases so callers can describe the policy at either the
// aggregate or trigger level without creating a second implementation.
export const validateAutomation = validateAutomationDefinition;
export const classifyRunNow = classifyAutomationRunNow;
