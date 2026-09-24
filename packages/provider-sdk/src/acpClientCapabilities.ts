import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const AcpTerminalEnvironment = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
}).annotations(strict);

const AcpExitStatus = Schema.Struct({
  exitCode: Schema.optional(Schema.Int),
  signal: Schema.optional(Schema.String),
}).annotations(strict);

export const ACP_CLIENT_TOOL_NAMES = {
  readTextFile: "octant_acp_fs_read_text_file",
  writeTextFile: "octant_acp_fs_write_text_file",
  terminalCreate: "octant_acp_terminal_create",
  terminalOutput: "octant_acp_terminal_output",
  terminalWaitForExit: "octant_acp_terminal_wait_for_exit",
  terminalKill: "octant_acp_terminal_kill",
  terminalRelease: "octant_acp_terminal_release",
} as const;

export const ACP_CLIENT_TERMINAL_TOOL_NAMES: ReadonlyArray<string> = [
  ACP_CLIENT_TOOL_NAMES.terminalCreate,
  ACP_CLIENT_TOOL_NAMES.terminalOutput,
  ACP_CLIENT_TOOL_NAMES.terminalWaitForExit,
  ACP_CLIENT_TOOL_NAMES.terminalKill,
  ACP_CLIENT_TOOL_NAMES.terminalRelease,
];

export const AcpClientReadTextFileInput = Schema.Struct({
  path: Schema.String,
  line: Schema.optional(Schema.Int),
  limit: Schema.optional(Schema.Int),
}).annotations(strict);
export type AcpClientReadTextFileInput = typeof AcpClientReadTextFileInput.Type;

export const AcpClientReadTextFileResult = Schema.Struct({
  content: Schema.String,
}).annotations(strict);
export type AcpClientReadTextFileResult = typeof AcpClientReadTextFileResult.Type;

export const AcpClientWriteTextFileInput = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
}).annotations(strict);
export type AcpClientWriteTextFileInput = typeof AcpClientWriteTextFileInput.Type;

export const AcpClientWriteTextFileResult = Schema.Struct({}).annotations(strict);
export type AcpClientWriteTextFileResult = typeof AcpClientWriteTextFileResult.Type;

export const AcpClientTerminalCreateInput = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(AcpTerminalEnvironment)),
  cwd: Schema.optional(Schema.String),
  outputByteLimit: Schema.optional(Schema.Int),
}).annotations(strict);
export type AcpClientTerminalCreateInput = typeof AcpClientTerminalCreateInput.Type;

export const AcpClientTerminalCreateResult = Schema.Struct({
  terminalId: Schema.String,
}).annotations(strict);
export type AcpClientTerminalCreateResult = typeof AcpClientTerminalCreateResult.Type;

export const AcpClientTerminalOutputInput = Schema.Struct({
  terminalId: Schema.String,
}).annotations(strict);
export type AcpClientTerminalOutputInput = typeof AcpClientTerminalOutputInput.Type;

export const AcpClientTerminalOutputResult = Schema.Struct({
  output: Schema.String,
  truncated: Schema.Boolean,
  exitStatus: Schema.optional(AcpExitStatus),
}).annotations(strict);
export type AcpClientTerminalOutputResult = typeof AcpClientTerminalOutputResult.Type;

export const AcpClientTerminalWaitForExitInput = Schema.Struct({
  terminalId: Schema.String,
}).annotations(strict);
export type AcpClientTerminalWaitForExitInput = typeof AcpClientTerminalWaitForExitInput.Type;

export const AcpClientTerminalWaitForExitResult = AcpExitStatus;
export type AcpClientTerminalWaitForExitResult = typeof AcpClientTerminalWaitForExitResult.Type;

export const AcpClientTerminalKillInput = Schema.Struct({
  terminalId: Schema.String,
}).annotations(strict);
export type AcpClientTerminalKillInput = typeof AcpClientTerminalKillInput.Type;

export const AcpClientTerminalKillResult = Schema.Struct({}).annotations(strict);
export type AcpClientTerminalKillResult = typeof AcpClientTerminalKillResult.Type;

export const AcpClientTerminalReleaseInput = Schema.Struct({
  terminalId: Schema.String,
}).annotations(strict);
export type AcpClientTerminalReleaseInput = typeof AcpClientTerminalReleaseInput.Type;

export const AcpClientTerminalReleaseResult = Schema.Struct({}).annotations(strict);
export type AcpClientTerminalReleaseResult = typeof AcpClientTerminalReleaseResult.Type;
