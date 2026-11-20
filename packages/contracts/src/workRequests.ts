import { personDecides } from "./hostAnswer";
import { Schema } from "effect";
import { ProjectId } from "./projects";
import { AggregateVersion, UtcTimestamp } from "./events";
import { MAX_PROVIDER_PLAN_CHARACTERS, ProviderInstanceId, ProviderSessionId } from "./providers";
import { WorkAccess, WorkThreadId } from "./workThreads";
import { Questionnaire, QuestionnaireResponse } from "./questionnaire";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

/**
 * Branded identity for one durable Work pending-approval or user-input
 * request. One request owns exactly one Project, one Work thread, and one
 * originating provider session; it never spans Projects or threads.
 */
export const WorkRequestId = brandedUuid("WorkRequestId");
export type WorkRequestId = typeof WorkRequestId.Type;

/**
 * Sanitized free text carried by a Work request or its resolution. Rejects
 * path separators and `file:`/`http(s):` schemes so a host path, source
 * snippet, or authority URL from an untrusted provider payload can never
 * reach the renderer-facing contract. Mirrors `WorkPromotionSummaryText`.
 */
export const WorkRequestSanitizedText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(2_000),
  Schema.filter((value) => !/[\\/]/.test(value) && !/(?:^|\s|[[({<])(file|https?):/i.test(value)),
);

/**
 * Bounded Octant request surrogate exposed in a renderer-facing request
 * list. It never contains a provider callback id; the runtime derives it from
 * the Octant request id so an untrusted provider cannot use this field to
 * disclose a credential, path, or authority URL.
 */
export const WorkRequestProviderRequestId = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(256),
);
export type WorkRequestProviderRequestId = typeof WorkRequestProviderRequestId.Type;

/**
 * Private, server-journal-only provider callback identity. It is never part
 * of `WorkRequest` or an HTTP response: the service uses it only to answer
 * a live provider wait (or recover a durable wait after restart). Preserve it
 * exactly because callback values are opaque provider data, but bound it so a
 * provider cannot make the private journal unbounded.
 */
const WorkRequestProviderCallbackId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(16_384),
);

/**
 * A provider answer option retained only in the server event journal so a
 * sanitized renderer label can be translated back to the provider's exact
 * callback value after restart. It is deliberately absent from WorkRequest
 * and every HTTP contract.
 */
const WorkRequestProviderOptionValue = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(16_384),
);
const WorkRequestProviderOptionValues = Schema.Array(WorkRequestProviderOptionValue).pipe(
  Schema.maxItems(8),
);
export type WorkRequestProviderOptionValues = typeof WorkRequestProviderOptionValues.Type;

// Tabs and line breaks are a plan's layout; every other control character is refused.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
      return true;
  }
  return false;
}

export const WorkRequestKind = Schema.Literal("approval", "user-input");
export type WorkRequestKind = typeof WorkRequestKind.Type;

export const WorkRequestStatus = Schema.Literal(
  "pending",
  "resolved",
  "cancelled",
  "interrupted",
  "expired",
);
export type WorkRequestStatus = typeof WorkRequestStatus.Type;

export const MAX_WORK_REQUEST_OPTIONS = 8;

const safeQuestionId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
const safeRequestText = Schema.is(WorkRequestSanitizedText);
export const WorkQuestionnaire = Questionnaire.pipe(
  Schema.filter(({ questions }) =>
    questions.every(
      (question) =>
        safeQuestionId(question.id) &&
        safeRequestText(question.prompt) &&
        question.options.every(
          (option) =>
            safeQuestionId(option.id) &&
            safeRequestText(option.label) &&
            (option.description === undefined || safeRequestText(option.description)),
        ),
    ),
  ),
);
export const WorkQuestionnaireResponse = QuestionnaireResponse.pipe(
  Schema.filter(
    (response) =>
      (response.comment === undefined || safeRequestText(response.comment)) &&
      response.answers.every(
        (answer) =>
          safeQuestionId(answer.questionId) &&
          answer.selectedOptionIds.every(safeQuestionId) &&
          (answer.customAnswer === undefined || safeRequestText(answer.customAnswer)),
      ),
  ),
);
export const decodeWorkQuestionnaireResponse = Schema.decodeUnknownSync(WorkQuestionnaireResponse);

/**
 * The plan an agent asks the person to approve when it asks to leave Plan,
 * shown whole on the card. Unlike request text it keeps paths and links: a
 * plan names the files it would change, and the person must read exactly
 * what they approve. The host redacts known secret formats before recording
 * it, and it is bounded as a runtime's plan is.
 */
export const WorkLevelChangePlan = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_PROVIDER_PLAN_CHARACTERS),
  Schema.filter((value) => !hasControlCharacter(value)),
);
export type WorkLevelChangePlan = typeof WorkLevelChangePlan.Type;

/**
 * An approval that asks to change the thread's level instead of to run a
 * tool: the agent's own ask to plan first (`to: "plan"`), or to leave Plan
 * for the level the thread returns to, with the plan it hands over.
 */
export const WorkLevelChangeRequest = Schema.Struct({
  to: WorkAccess,
  plan: Schema.optional(WorkLevelChangePlan),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (change) =>
        change.to !== "full-access" && (change.to !== "plan" || change.plan === undefined),
      {
        jsonSchema: {},
      },
    ),
  );
export type WorkLevelChangeRequest = typeof WorkLevelChangeRequest.Type;

/**
 * Sanitized request detail. `approval` carries the action/description a
 * provider tool call wants to perform, and `levelChange` when the call asks
 * to move the thread into or out of Plan; `user-input` carries the prompt and
 * bounded option list a provider question offers. Action, description,
 * prompt and options are sanitized free text with no path/URL leakage; only
 * up to 8 options are retained.
 */
export const WorkRequestDetail = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("approval"),
    action: WorkRequestSanitizedText,
    description: WorkRequestSanitizedText,
    levelChange: Schema.optional(WorkLevelChangeRequest),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("user-input"),
    prompt: WorkRequestSanitizedText,
    options: Schema.Array(WorkRequestSanitizedText).pipe(Schema.maxItems(MAX_WORK_REQUEST_OPTIONS)),
    questionnaire: Schema.optional(WorkQuestionnaire),
  }).annotations(strict),
);
export type WorkRequestDetail = typeof WorkRequestDetail.Type;

/**
 * The user's answer to a request. `resolution.kind` must match the owning
 * request's `detail.kind`; a mismatched pairing is rejected structurally so
 * an approval can never be "resolved" with a user-input answer or vice versa.
 */
export const WorkRequestResolution = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("approval"), approved: Schema.Boolean }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("user-input"),
    answer: Schema.Union(WorkRequestSanitizedText, WorkQuestionnaireResponse),
  }).annotations(strict),
);
export type WorkRequestResolution = typeof WorkRequestResolution.Type;

/**
 * A durable, server-internal delivery intent. It is written before Octant
 * answers or cancels a provider callback, closing the otherwise unrecoverable
 * provider-success/journal-failure gap. A successful provider call is durably
 * confirmed before the request terminalizes, so a later terminal-journal
 * failure can reconcile without sending the same answer twice. The intent is
 * removed only by the terminal request frame (or a failed-delivery release
 * frame).
 */
export const WorkRequestDelivery = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("resolve"),
    resolution: WorkRequestResolution,
    /** The provider accepted this intent and that acknowledgement is journaled. */
    confirmed: Schema.optional(Schema.Literal(true)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cancel"),
    /** The provider accepted this intent and that acknowledgement is journaled. */
    confirmed: Schema.optional(Schema.Literal(true)),
  }).annotations(strict),
);
export type WorkRequestDelivery = typeof WorkRequestDelivery.Type;

/**
 * Server-authoritative, Project- and thread-scoped Work request. `status`
 * moves from `pending` to exactly one terminal status (`resolved`,
 * `cancelled`, `interrupted`, `expired`); `resolution` and `settledAt` are
 * present if and only if the request has settled, and a `resolved` request's
 * resolution kind must match its detail kind. No host path, provider
 * payload, credential, or authority token travels in any field.
 */
export const WorkRequest = Schema.Struct({
  requestId: WorkRequestId,
  projectId: ProjectId,
  threadId: WorkThreadId,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: ProviderSessionId,
  providerRequestId: WorkRequestProviderRequestId,
  detail: WorkRequestDetail,
  status: WorkRequestStatus,
  resolution: Schema.optional(WorkRequestResolution),
  /**
   * On a resolved level change the person approved: whether the new level
   * applied inside the running turn (`in-place`, entering Plan on a provider
   * that can hold its session to it) or from the next turn, the asking turn
   * ending (`next-turn`). Set by the host, never by an answer; absent on
   * every other request and in older journals.
   */
  levelChangeApplied: Schema.optional(Schema.Literal("in-place", "next-turn")),
  delivery: Schema.optional(WorkRequestDelivery),
  requestedAt: UtcTimestamp,
  settledAt: Schema.optional(UtcTimestamp),
  version: AggregateVersion,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (request) => {
        if (request.status === "pending") {
          return (
            request.resolution === undefined &&
            request.settledAt === undefined &&
            request.levelChangeApplied === undefined
          );
        }
        if (request.settledAt === undefined || request.delivery !== undefined) return false;
        if (request.status === "resolved") {
          return (
            request.resolution !== undefined &&
            request.resolution.kind === request.detail.kind &&
            (request.levelChangeApplied === undefined ||
              (request.detail.kind === "approval" &&
                request.detail.levelChange !== undefined &&
                request.resolution.kind === "approval" &&
                request.resolution.approved))
          );
        }
        return request.resolution === undefined && request.levelChangeApplied === undefined;
      },
      { jsonSchema: {} },
    ),
  )
  .annotations(personDecides);
export type WorkRequest = typeof WorkRequest.Type;

const RequestTransitionFields = {
  requestId: WorkRequestId,
  expectedVersion: AggregateVersion,
} as const;

/**
 * User-initiated Work request commands. Recording, interruption, and
 * expiry are server-internal transitions driven by the provider turn runtime
 * and are not exposed on this wire command, so a window can never fabricate
 * a request or force a system-only transition.
 */
export const WorkRequestCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("resolve-work-request"),
    ...RequestTransitionFields,
    resolution: WorkRequestResolution,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cancel-work-request"),
    ...RequestTransitionFields,
  }).annotations(strict),
);
export type WorkRequestCommand = typeof WorkRequestCommand.Type;

export const WorkRequestCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("work-request-resolved"),
    request: WorkRequest,
  })
    .annotations(strict)
    .pipe(Schema.filter((result) => result.request.status === "resolved", { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("work-request-cancelled"),
    request: WorkRequest,
  })
    .annotations(strict)
    .pipe(Schema.filter((result) => result.request.status === "cancelled", { jsonSchema: {} })),
);
export type WorkRequestCommandResult = typeof WorkRequestCommandResult.Type;

export const WorkRequestFailureCode = Schema.Literal(
  "invalid",
  "unauthorized",
  "stale",
  "not-found",
  "conflict",
  "unavailable",
);
export type WorkRequestFailureCode = typeof WorkRequestFailureCode.Type;

export const WorkRequestFailure = Schema.Struct({
  code: WorkRequestFailureCode,
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type WorkRequestFailure = typeof WorkRequestFailure.Type;

/**
 * Read-only, Project- and optionally thread-scoped Work request list for an
 * authenticated window. Bounded so a runaway provider cannot exhaust the
 * renderer with an unbounded backlog.
 */
export const WorkRequestList = Schema.Struct({
  requests: Schema.Array(WorkRequest).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type WorkRequestList = typeof WorkRequestList.Type;

/**
 * Journalable Work request frame. The server appends one frame per request
 * transition as a versioned `work.request-recorded@1` event; the aggregate
 * is the request and the aggregate version is the request's `version`,
 * backing optimistic concurrency on `expectedVersion`. Each frame kind must
 * carry a request whose `status` matches the frame kind, so a malformed or
 * out-of-order frame fails closed at decode time rather than corrupting the
 * rebuildable projection.
 */
export const WorkRequestFrame = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("requested"),
    request: WorkRequest,
    /** Private provider callback id; absent only in legacy request frames. */
    providerCallbackId: Schema.optional(WorkRequestProviderCallbackId),
    providerOptionValues: Schema.optional(WorkRequestProviderOptionValues),
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (frame) =>
          frame.request.status === "pending" &&
          frame.request.delivery === undefined &&
          (frame.providerOptionValues === undefined
            ? true
            : frame.request.detail.kind === "user-input" &&
              frame.providerOptionValues.length === frame.request.detail.options.length),
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({ kind: Schema.Literal("delivery-requested"), request: WorkRequest })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (frame) =>
          frame.request.status === "pending" &&
          frame.request.delivery !== undefined &&
          frame.request.delivery.confirmed === undefined,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({ kind: Schema.Literal("delivery-confirmed"), request: WorkRequest })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (frame) => frame.request.status === "pending" && frame.request.delivery?.confirmed === true,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({ kind: Schema.Literal("delivery-released"), request: WorkRequest })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (frame) => frame.request.status === "pending" && frame.request.delivery === undefined,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({ kind: Schema.Literal("resolved"), request: WorkRequest })
    .annotations(strict)
    .pipe(Schema.filter((frame) => frame.request.status === "resolved", { jsonSchema: {} })),
  Schema.Struct({ kind: Schema.Literal("cancelled"), request: WorkRequest })
    .annotations(strict)
    .pipe(Schema.filter((frame) => frame.request.status === "cancelled", { jsonSchema: {} })),
  Schema.Struct({ kind: Schema.Literal("interrupted"), request: WorkRequest })
    .annotations(strict)
    .pipe(Schema.filter((frame) => frame.request.status === "interrupted", { jsonSchema: {} })),
  Schema.Struct({ kind: Schema.Literal("expired"), request: WorkRequest })
    .annotations(strict)
    .pipe(Schema.filter((frame) => frame.request.status === "expired", { jsonSchema: {} })),
);
export type WorkRequestFrame = typeof WorkRequestFrame.Type;

export const WORK_REQUEST_EVENT_NAMES = ["work.request-recorded@1"] as const;
export type WorkRequestEventName = (typeof WORK_REQUEST_EVENT_NAMES)[number];

/**
 * Server-internal input for recording a newly observed provider approval or
 * user-input request. Not part of `WorkRequestCommand`: recording is driven
 * by the trusted provider turn runtime reacting to a normalized
 * `ProviderRuntimeEvent`, never by a window-issued wire command.
 */
export const WorkRequestRecordInput = Schema.Struct({
  requestId: WorkRequestId,
  projectId: ProjectId,
  threadId: WorkThreadId,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: ProviderSessionId,
  /** Private provider callback identity, never exposed through WorkRequest. */
  providerCallbackId: WorkRequestProviderCallbackId,
  detail: WorkRequestDetail,
  /** Private, bounded provider values aligned with sanitized user-input options. */
  providerOptionValues: Schema.optional(WorkRequestProviderOptionValues),
}).annotations(strict);
export type WorkRequestRecordInput = typeof WorkRequestRecordInput.Type;

export const decodeWorkRequestId = Schema.decodeUnknownSync(WorkRequestId);
export const decodeWorkRequestDetail = Schema.decodeUnknownSync(WorkRequestDetail);
export const decodeWorkRequestResolution = Schema.decodeUnknownSync(WorkRequestResolution);
export const decodeWorkRequest = Schema.decodeUnknownSync(WorkRequest);
export const decodeWorkRequestCommand = Schema.decodeUnknownSync(WorkRequestCommand);
export const decodeWorkRequestCommandResult = Schema.decodeUnknownSync(WorkRequestCommandResult);
export const decodeWorkRequestFailure = Schema.decodeUnknownSync(WorkRequestFailure);
export const decodeWorkRequestList = Schema.decodeUnknownSync(WorkRequestList);
export const decodeWorkRequestFrame = Schema.decodeUnknownSync(WorkRequestFrame);
export const decodeWorkRequestRecordInput = Schema.decodeUnknownSync(WorkRequestRecordInput);

export function decodeWorkRequestEventPayload(
  eventName: WorkRequestEventName | string,
  payload: unknown,
): unknown {
  switch (eventName) {
    case "work.request-recorded@1":
      return decodeWorkRequestFrame(payload);
    default:
      throw new Error("Unknown Work request persistence event");
  }
}
