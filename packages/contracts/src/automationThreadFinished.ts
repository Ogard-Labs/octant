import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));

/** Default lifetime of a wait-on-thread trigger before it expires without firing. */
export const AUTOMATION_THREAD_FINISH_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;

/** Upper bound on a wait-on-thread expiry window. */
export const MAX_AUTOMATION_THREAD_FINISH_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;

/** Maximum simultaneously armed finish waits per waiting thread. */
export const MAX_AUTOMATION_FINISH_WAITS_PER_THREAD = 8;

/** Maximum simultaneously armed finish waits across a host. */
export const MAX_AUTOMATION_FINISH_WAITS_PER_HOST = 32;

/** Query token (`?reads=thread-finished`) older clients omit so strict decoders stay compatible. */
export const AUTOMATION_THREAD_FINISHED_READS_FLAG = "thread-finished";

export const AutomationFinishWaitId = brandedUuid("AutomationFinishWaitId");
export type AutomationFinishWaitId = typeof AutomationFinishWaitId.Type;

/**
 * Closed set of host-checked finish conditions.
 * - `turn-finished`: a turn that started or was running after arming completed
 *   and the thread is idle with no open approval, question, pending decision, or
 *   queued message.
 * - `done`: the board says `done` from unambiguous evidence or a person marked
 *   the thread complete/done.
 */
export const AutomationThreadFinishCondition = Schema.Literal("turn-finished", "done");
export type AutomationThreadFinishCondition = typeof AutomationThreadFinishCondition.Type;

export const AutomationFinishWaitState = Schema.Literal(
  "armed",
  "fired",
  "missed",
  "expired",
  "cancelled",
  "unavailable",
);
export type AutomationFinishWaitState = typeof AutomationFinishWaitState.Type;

export const AutomationFinishWaitTargetStatus = Schema.Literal(
  "working",
  "waiting",
  "idle",
  "done",
  "unavailable",
);
export type AutomationFinishWaitTargetStatus = typeof AutomationFinishWaitTargetStatus.Type;

/** One local thread a person may pick as the waited-on target in the arm sheet. */
export const AutomationFinishWaitTargetCandidate = Schema.Struct({
  threadId: Schema.UUID,
  mode: Schema.Literal("chat", "work", "code"),
  projectId: ProjectId,
  projectName: boundedText(255),
  title: boundedText(255),
  status: AutomationFinishWaitTargetStatus,
  alreadyTurnFinished: Schema.Boolean,
  alreadyDone: Schema.Boolean,
  hostId: HostId,
}).annotations(strict);
export type AutomationFinishWaitTargetCandidate = typeof AutomationFinishWaitTargetCandidate.Type;

export const AutomationFinishWaitTargetsResponse = Schema.Struct({
  kind: Schema.Literal("automation-finish-wait-targets"),
  targets: Schema.Array(AutomationFinishWaitTargetCandidate).pipe(Schema.maxItems(200)),
}).annotations(strict);
export type AutomationFinishWaitTargetsResponse = typeof AutomationFinishWaitTargetsResponse.Type;

export const decodeAutomationFinishWaitId = Schema.decodeUnknownSync(AutomationFinishWaitId);
export const decodeAutomationFinishWaitTargetsResponse = Schema.decodeUnknownSync(
  AutomationFinishWaitTargetsResponse,
);

const THREAD_FINISHED_HEADING_PREFIX = "Follow-up started after thread ";
const THREAD_FINISHED_HEADING_SUFFIX = " finished:";

/**
 * The host-authored first line of a turn triggered when another thread
 * finishes. It names the target thread by opaque reference only (never its
 * title or reply text) so the follow-up thread is never marked with content
 * from the target.
 */
export function automationThreadFinishedTurnHeading(targetThreadId: string): string {
  return `${THREAD_FINISHED_HEADING_PREFIX}${targetThreadId}${THREAD_FINISHED_HEADING_SUFFIX}`;
}

export function automationThreadFinishedTurnPrompt(
  taskPrompt: string,
  targetThreadId: string,
): string {
  return `${automationThreadFinishedTurnHeading(targetThreadId)}\n\n${taskPrompt}`;
}

export function parseAutomationThreadFinishedTurnPrompt(
  text: string,
): { readonly targetThreadId: string; readonly prompt: string } | undefined {
  if (!text.startsWith(THREAD_FINISHED_HEADING_PREFIX)) return undefined;
  const separatorIndex = text.indexOf(`${THREAD_FINISHED_HEADING_SUFFIX}\n\n`);
  if (separatorIndex < THREAD_FINISHED_HEADING_PREFIX.length) return undefined;
  const targetThreadId = text.slice(THREAD_FINISHED_HEADING_PREFIX.length, separatorIndex);
  if (targetThreadId.length === 0 || /\s/.test(targetThreadId)) return undefined;
  return {
    targetThreadId,
    prompt: text.slice(separatorIndex + THREAD_FINISHED_HEADING_SUFFIX.length + 2),
  };
}

/** Strict UTC instant check shared by wait expiry validation. */
export const AutomationFinishWaitTimestamp = UtcTimestamp;
