import { Schema } from "effect";
import { NonEmptyTrimmedString, NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProjectId } from "./projects";

/**
 * Octant instructions: the texts a person writes for Octant itself, which
 * travel as standing context beside each provider's own instruction files.
 * The rules (where they reach, who changes them, where they are kept) are in
 * the Octant instructions design.
 */

export const PERSON_INSTRUCTIONS_MAX_CHARACTERS = 8_000;
export const PROJECT_INSTRUCTIONS_MAX_CHARACTERS = 4_000;
export const ORCHESTRATION_INSTRUCTIONS_MAX_CHARACTERS = 4_000;

/** Plain text as the person wrote it. Empty means the text is off and sends nothing. */
export const PersonInstructionsText = Schema.String.check(
  Schema.isMaxLength(PERSON_INSTRUCTIONS_MAX_CHARACTERS),
);
export const ProjectInstructionsText = Schema.String.check(
  Schema.isMaxLength(PROJECT_INSTRUCTIONS_MAX_CHARACTERS),
);
export const OrchestrationInstructionsText = Schema.String.check(
  Schema.isMaxLength(ORCHESTRATION_INSTRUCTIONS_MAX_CHARACTERS),
);

export const PERSON_INSTRUCTIONS_AGGREGATE_TYPE = "person-instructions";
export const PROJECT_INSTRUCTIONS_AGGREGATE_TYPE = "project-instructions";
export const ORCHESTRATION_INSTRUCTIONS_AGGREGATE_TYPE = "orchestration-instructions";

export const PERSON_INSTRUCTIONS_CHANGED = "person-instructions.changed@1";
export const PROJECT_INSTRUCTIONS_CHANGED = "project-instructions.changed@1";
export const ORCHESTRATION_INSTRUCTIONS_CHANGED = "orchestration-instructions.changed@1";

/** The person's whole record as changed: every change carries the whole new text. */
export const PersonInstructionsChanged = Schema.Struct({
  instructions: PersonInstructionsText,
});
export type PersonInstructionsChanged = typeof PersonInstructionsChanged.Type;

/**
 * The orchestration text as changed, on its own record: saving it never makes
 * an open edit of your instructions stale, and the person record's event keeps
 * the shape every earlier build decodes.
 */
export const OrchestrationInstructionsChanged = Schema.Struct({
  orchestration: OrchestrationInstructionsText,
});
export type OrchestrationInstructionsChanged = typeof OrchestrationInstructionsChanged.Type;

/**
 * One Project's instructions as changed. The aggregate is the Project, so
 * deleting the Project erases its instructions with it.
 */
export const ProjectInstructionsChanged = Schema.Struct({
  projectId: ProjectId,
  instructions: ProjectInstructionsText,
});
export type ProjectInstructionsChanged = typeof ProjectInstructionsChanged.Type;

const RecordVersion = NonNegativeInt;

/** What Settings shows. `canChange` is false where the principal may read but not change. */
export const OctantInstructionsView = Schema.Struct({
  kind: Schema.Literal("octant-instructions"),
  instructions: PersonInstructionsText,
  orchestration: OrchestrationInstructionsText,
  /** The person record's version; a change to your instructions names the one it read. */
  version: RecordVersion,
  /** The orchestration record's version; a change to orchestration names the one it read. */
  orchestrationVersion: RecordVersion,
  canChange: Schema.Boolean,
});
export type OctantInstructionsView = typeof OctantInstructionsView.Type;

/** One Project's instructions, as its settings show them. */
export const ProjectInstructionsView = Schema.Struct({
  kind: Schema.Literal("project-instructions"),
  projectId: ProjectId,
  instructions: ProjectInstructionsText,
  /** The Project record's version; a change names the one it read. */
  version: RecordVersion,
  canChange: Schema.Boolean,
});
export type ProjectInstructionsView = typeof ProjectInstructionsView.Type;

export const OctantInstructionsCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("change-person-instructions"),
    expectedVersion: RecordVersion,
    instructions: PersonInstructionsText,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-orchestration-instructions"),
    /** The orchestration record's version, not the person record's. */
    expectedVersion: RecordVersion,
    orchestration: OrchestrationInstructionsText,
  }),
  Schema.Struct({
    kind: Schema.Literal("read-project-instructions"),
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-project-instructions"),
    projectId: ProjectId,
    expectedVersion: RecordVersion,
    instructions: ProjectInstructionsText,
  }),
]);
export type OctantInstructionsCommand = typeof OctantInstructionsCommand.Type;

export const OctantInstructionsRefusalReason = Schema.Literals([
  "malformed",
  "stale-version",
  "not-the-person",
  "project-not-found",
]);
export type OctantInstructionsRefusalReason = typeof OctantInstructionsRefusalReason.Type;

export const OctantInstructionsResult = Schema.Union([
  OctantInstructionsView,
  ProjectInstructionsView,
  Schema.Struct({
    kind: Schema.Literal("octant-instructions-refused"),
    reason: OctantInstructionsRefusalReason,
    message: NonEmptyTrimmedString,
  }),
]);
export type OctantInstructionsResult = typeof OctantInstructionsResult.Type;

export const decodePersonInstructionsChanged = Schema.decodeUnknownSync(
  PersonInstructionsChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeProjectInstructionsChanged = Schema.decodeUnknownSync(
  ProjectInstructionsChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeOrchestrationInstructionsChanged = Schema.decodeUnknownSync(
  OrchestrationInstructionsChanged,
  STRICT_DECODE_OPTIONS,
);
export const decodeOctantInstructionsCommand = Schema.decodeUnknownSync(
  OctantInstructionsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeOctantInstructionsResult = Schema.decodeUnknownSync(
  OctantInstructionsResult,
  STRICT_DECODE_OPTIONS,
);
