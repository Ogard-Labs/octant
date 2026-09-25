import { Schema } from "effect";
import { CodeTerminalId } from "./code";
import { MAX_CODE_OPERATION_TERMINAL_INPUT_BYTES } from "./codeOperations";
import { UtcTimestamp } from "./events";
import { BindingRevisionId, ProjectId } from "./projects";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();

/**
 * How much of a Project terminal's output one read hands back. It matches the
 * live window a Code thread's terminal is replayed with, so a reader that fell
 * behind is caught up with the same bounded tail rather than the whole
 * transcript the host keeps.
 */
export const MAX_PROJECT_TERMINAL_OUTPUT_CHARACTERS = 64 * 1024;

export const PROJECT_TERMINAL_EVENT_NAMES = {
  started: "code.project-terminal-started@1",
  ended: "code.project-terminal-ended@1",
} as const;

const TerminalGeometry = {
  columns: Schema.Int.pipe(Schema.between(1, 500)),
  rows: Schema.Int.pipe(Schema.between(1, 500)),
} as const;

const Target = {
  projectId: ProjectId,
  terminalId: CodeTerminalId,
} as const;

/**
 * What a Project terminal runs under. It is the posture a new Code thread in
 * the same Project starts with, never Plan: nothing plans in a Project
 * terminal, and a shell a person opens is not read-only.
 */
export const ProjectTerminalPosture = Schema.Literal("approval-gated", "full-access");
export type ProjectTerminalPosture = typeof ProjectTerminalPosture.Type;

/**
 * A person's command to a terminal that belongs to a Code Project rather than
 * to a thread.
 *
 * The command names the Project and the terminal and nothing else: the host
 * resolves the root, the posture, and the owning window itself, so a caller
 * cannot describe its way to a folder, a credential, or someone else's shell.
 */
export const ProjectTerminalCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("start"),
    ...Target,
    ...TerminalGeometry,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("attach"), ...Target }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("write"),
    ...Target,
    data: Schema.String.pipe(
      Schema.filter(
        (value) =>
          !value.includes("\0") &&
          encoder.encode(value).byteLength <= MAX_CODE_OPERATION_TERMINAL_INPUT_BYTES,
      ),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("resize"),
    ...Target,
    ...TerminalGeometry,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("stop"), ...Target }).annotations(strict),
  /**
   * What the shell printed after an absolute character offset. The reader
   * holds the offset, so catching up costs what was printed since it last
   * looked.
   */
  Schema.Struct({
    kind: Schema.Literal("read-output"),
    ...Target,
    afterCharacters: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
);
export type ProjectTerminalCommand = typeof ProjectTerminalCommand.Type;

export const ProjectTerminalView = Schema.Struct({
  ...Target,
  state: Schema.Literal("running", "exited", "interrupted"),
  exitCode: Schema.optional(Schema.Int),
  posture: ProjectTerminalPosture,
}).annotations(strict);
export type ProjectTerminalView = typeof ProjectTerminalView.Type;

/**
 * Output since the reader's offset. `replace` means the offset is no longer in
 * what the host keeps, so `text` is the bounded tail and replaces what the
 * reader shows; `characters` is where the next read starts.
 */
export const ProjectTerminalOutput = Schema.Struct({
  text: Schema.String.pipe(Schema.maxLength(MAX_PROJECT_TERMINAL_OUTPUT_CHARACTERS)),
  replace: Schema.Boolean,
  characters: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type ProjectTerminalOutput = typeof ProjectTerminalOutput.Type;

/**
 * Why the host would not act. Each reason is one the caller can do something
 * about: `unauthorized` is not this window's Project or shell, `unavailable`
 * is a Project or shell that is not there to act on, `authority-revoked` is a
 * shell the host ended because its Project was archived or rebound.
 */
export const ProjectTerminalRefusalReason = Schema.Literal(
  "unauthorized",
  "unavailable",
  "authority-revoked",
);
export type ProjectTerminalRefusalReason = typeof ProjectTerminalRefusalReason.Type;

export const ProjectTerminalResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("project-terminal"),
    terminal: ProjectTerminalView,
    output: Schema.optional(ProjectTerminalOutput),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-terminal-refused"),
    reason: ProjectTerminalRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type ProjectTerminalResult = typeof ProjectTerminalResult.Type;

/**
 * Journaled when a Project terminal's shell is running. It records who owns
 * the shell and which binding it was opened against; the output is not part
 * of any record.
 */
export const ProjectTerminalStarted = Schema.Struct({
  kind: Schema.Literal("project-terminal-started"),
  ...Target,
  windowId: WindowId,
  bindingRevisionId: BindingRevisionId,
  posture: ProjectTerminalPosture,
  startedAt: UtcTimestamp,
}).annotations(strict);
export type ProjectTerminalStarted = typeof ProjectTerminalStarted.Type;

export const ProjectTerminalEndReason = Schema.Literal(
  "stopped",
  "exited",
  "authority-revoked",
  "host-restarted",
);
export type ProjectTerminalEndReason = typeof ProjectTerminalEndReason.Type;

export const ProjectTerminalEnded = Schema.Struct({
  kind: Schema.Literal("project-terminal-ended"),
  ...Target,
  reason: ProjectTerminalEndReason,
  exitCode: Schema.optional(Schema.Int),
  endedAt: UtcTimestamp,
}).annotations(strict);
export type ProjectTerminalEnded = typeof ProjectTerminalEnded.Type;

export const decodeProjectTerminalCommand = Schema.decodeUnknownSync(ProjectTerminalCommand);
export const decodeProjectTerminalResult = Schema.decodeUnknownSync(ProjectTerminalResult);
export const decodeProjectTerminalStarted = Schema.decodeUnknownSync(ProjectTerminalStarted);
export const decodeProjectTerminalEnded = Schema.decodeUnknownSync(ProjectTerminalEnded);
