import { Schema } from "effect";
import { ProjectId } from "./projects";
import { UtcTimestamp } from "./events";
import { WorkThreadId } from "./workThreads";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

/**
 * Branded identity for a Work workflow. A workflow represents one bounded
 * unit of active work bound to a single Work thread; its identity is
 * independent of the thread so a thread can carry a history of distinct
 * workflow instances (e.g. reopened work after archiving) without ambiguity.
 */
export const WorkflowId = brandedUuid("WorkflowId");
export type WorkflowId = typeof WorkflowId.Type;

/**
 * Honest, provider-neutral workflow lifecycle vocabulary. Deliberately
 * excludes Code-board language ("in review", "merged", "blocked") so no Code
 * agent-board or coding-test semantics can leak into Work through this
 * field. `active` is a workflow currently backing live thread work;
 * `completed` and `cancelled` are terminal.
 */
export const WorkflowLifecycle = Schema.Literal("active", "completed", "cancelled");
export type WorkflowLifecycle = typeof WorkflowLifecycle.Type;

const WorkflowLabel = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));

/**
 * Authoritative Work workflow identity. `relatedThreadId` binds the
 * workflow to exactly one Work thread and `projectId` is that thread's
 * owning Project; both are copied from the journaled thread fact that
 * started the workflow, never invented by a reader. `version` is the
 * workflow's own aggregate version, giving bounded per-workflow ordering; a
 * workflow is created at version 1 as `active` and every lifecycle
 * transition — to `completed` or `cancelled` — strictly increases the
 * version. The `(lifecycle === "active") === (version === 1)` invariant
 * holds because a workflow never returns to `active` after a transition;
 * reopened work starts a new workflow identity instead.
 */
export const Workflow = Schema.Struct({
  workflowId: WorkflowId,
  projectId: ProjectId,
  relatedThreadId: WorkThreadId,
  label: WorkflowLabel,
  lifecycle: WorkflowLifecycle,
  startedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  version: Schema.Int.pipe(Schema.positive()),
})
  .annotations(strict)
  .pipe(
    Schema.filter((workflow) => (workflow.lifecycle === "active") === (workflow.version === 1), {
      jsonSchema: {},
    }),
  );
export type Workflow = typeof Workflow.Type;

/**
 * Journalable Work workflow frame. The server appends one frame per
 * workflow transition as a versioned `work.workflow-recorded@1` event; the
 * aggregate is the workflow and the aggregate version is the workflow's own
 * `version`, backing optimistic concurrency and idempotent replay. Each
 * variant's `kind` must agree with the carried workflow's `lifecycle` so a
 * corrupted or mismatched frame is rejected by decoding rather than silently
 * accepted.
 */
export const WorkflowFrame = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("started"),
    workflow: Workflow,
  })
    .annotations(strict)
    .pipe(Schema.filter((frame) => frame.workflow.lifecycle === "active", { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("completed"),
    workflow: Workflow,
  })
    .annotations(strict)
    .pipe(Schema.filter((frame) => frame.workflow.lifecycle === "completed", { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("cancelled"),
    workflow: Workflow,
  })
    .annotations(strict)
    .pipe(Schema.filter((frame) => frame.workflow.lifecycle === "cancelled", { jsonSchema: {} })),
);
export type WorkflowFrame = typeof WorkflowFrame.Type;

export const WORK_WORKFLOW_EVENT_NAMES = ["work.workflow-recorded@1"] as const;
export type WorkflowEventName = (typeof WORK_WORKFLOW_EVENT_NAMES)[number];

export const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);
export const decodeWorkflow = Schema.decodeUnknownSync(Workflow);
export const decodeWorkflowFrame = Schema.decodeUnknownSync(WorkflowFrame);

export function decodeWorkflowEventPayload(
  eventName: WorkflowEventName | string,
  payload: unknown,
): unknown {
  switch (eventName) {
    case "work.workflow-recorded@1":
      return decodeWorkflowFrame(payload);
    default:
      throw new Error("Unknown Work workflow persistence event");
  }
}
