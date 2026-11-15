import { Schema } from "effect";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

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
export const PersonInstructionsText = Schema.String.pipe(
  Schema.maxLength(PERSON_INSTRUCTIONS_MAX_CHARACTERS),
);
export const ProjectInstructionsText = Schema.String.pipe(
  Schema.maxLength(PROJECT_INSTRUCTIONS_MAX_CHARACTERS),
);

export const PERSON_INSTRUCTIONS_AGGREGATE_TYPE = "person-instructions";
export const PROJECT_INSTRUCTIONS_AGGREGATE_TYPE = "project-instructions";

export const PERSON_INSTRUCTIONS_CHANGED = "person-instructions.changed@1";
export const PROJECT_INSTRUCTIONS_CHANGED = "project-instructions.changed@1";

/** The person's whole record as changed: every change carries the whole new text. */
export const PersonInstructionsChanged = Schema.Struct({
  instructions: PersonInstructionsText,
}).annotations(strict);
export type PersonInstructionsChanged = typeof PersonInstructionsChanged.Type;

/**
 * One Project's instructions as changed. The aggregate is the Project, so
 * deleting the Project erases its instructions with it.
 */
export const ProjectInstructionsChanged = Schema.Struct({
  projectId: ProjectId,
  instructions: ProjectInstructionsText,
}).annotations(strict);
export type ProjectInstructionsChanged = typeof ProjectInstructionsChanged.Type;

const RecordVersion = Schema.Int.pipe(Schema.nonNegative());

/** What Settings shows. `canChange` is false where the principal may read but not change. */
export const OctantInstructionsView = Schema.Struct({
  kind: Schema.Literal("octant-instructions"),
  instructions: PersonInstructionsText,
  /** The person record's version; a change names the one it read. */
  version: RecordVersion,
  canChange: Schema.Boolean,
}).annotations(strict);
export type OctantInstructionsView = typeof OctantInstructionsView.Type;

/** One Project's instructions, as its settings show them. */
export const ProjectInstructionsView = Schema.Struct({
  kind: Schema.Literal("project-instructions"),
  projectId: ProjectId,
  instructions: ProjectInstructionsText,
  /** The Project record's version; a change names the one it read. */
  version: RecordVersion,
  canChange: Schema.Boolean,
}).annotations(strict);
export type ProjectInstructionsView = typeof ProjectInstructionsView.Type;

export const OctantInstructionsCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("change-person-instructions"),
    expectedVersion: RecordVersion,
    instructions: PersonInstructionsText,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("read-project-instructions"),
    projectId: ProjectId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-project-instructions"),
    projectId: ProjectId,
    expectedVersion: RecordVersion,
    instructions: ProjectInstructionsText,
  }).annotations(strict),
);
export type OctantInstructionsCommand = typeof OctantInstructionsCommand.Type;

export const OctantInstructionsRefusalReason = Schema.Literal(
  "malformed",
  "stale-version",
  "not-the-person",
  "project-not-found",
);
export type OctantInstructionsRefusalReason = typeof OctantInstructionsRefusalReason.Type;

export const OctantInstructionsResult = Schema.Union(
  OctantInstructionsView,
  ProjectInstructionsView,
  Schema.Struct({
    kind: Schema.Literal("octant-instructions-refused"),
    reason: OctantInstructionsRefusalReason,
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type OctantInstructionsResult = typeof OctantInstructionsResult.Type;

export const decodePersonInstructionsChanged = Schema.decodeUnknownSync(PersonInstructionsChanged);
export const decodeProjectInstructionsChanged = Schema.decodeUnknownSync(
  ProjectInstructionsChanged,
);
export const decodeOctantInstructionsCommand = Schema.decodeUnknownSync(OctantInstructionsCommand);
export const decodeOctantInstructionsResult = Schema.decodeUnknownSync(OctantInstructionsResult);
