import { Schema } from "effect";

const AcpTerminalEnvironment = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
});

const AcpExitStatus = Schema.Struct({
  exitCode: Schema.optional(Schema.Int),
  signal: Schema.optional(Schema.String),
});

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
});
export type AcpClientReadTextFileInput = typeof AcpClientReadTextFileInput.Type;

export const AcpClientReadTextFileResult = Schema.Struct({
  content: Schema.String,
});
export type AcpClientReadTextFileResult = typeof AcpClientReadTextFileResult.Type;

export const AcpClientWriteTextFileInput = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});
export type AcpClientWriteTextFileInput = typeof AcpClientWriteTextFileInput.Type;

export const AcpClientWriteTextFileResult = Schema.Struct({});
export type AcpClientWriteTextFileResult = typeof AcpClientWriteTextFileResult.Type;

export const AcpClientTerminalCreateInput = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(AcpTerminalEnvironment)),
  cwd: Schema.optional(Schema.String),
  outputByteLimit: Schema.optional(Schema.Int),
});
export type AcpClientTerminalCreateInput = typeof AcpClientTerminalCreateInput.Type;

export const AcpClientTerminalCreateResult = Schema.Struct({
  terminalId: Schema.String,
});
export type AcpClientTerminalCreateResult = typeof AcpClientTerminalCreateResult.Type;

export const AcpClientTerminalOutputInput = Schema.Struct({
  terminalId: Schema.String,
});
export type AcpClientTerminalOutputInput = typeof AcpClientTerminalOutputInput.Type;

export const AcpClientTerminalOutputResult = Schema.Struct({
  output: Schema.String,
  truncated: Schema.Boolean,
  exitStatus: Schema.optional(AcpExitStatus),
});
export type AcpClientTerminalOutputResult = typeof AcpClientTerminalOutputResult.Type;

export const AcpClientTerminalWaitForExitInput = Schema.Struct({
  terminalId: Schema.String,
});
export type AcpClientTerminalWaitForExitInput = typeof AcpClientTerminalWaitForExitInput.Type;

export const AcpClientTerminalWaitForExitResult = AcpExitStatus;
export type AcpClientTerminalWaitForExitResult = typeof AcpClientTerminalWaitForExitResult.Type;

export const AcpClientTerminalKillInput = Schema.Struct({
  terminalId: Schema.String,
});
export type AcpClientTerminalKillInput = typeof AcpClientTerminalKillInput.Type;

export const AcpClientTerminalKillResult = Schema.Struct({});
export type AcpClientTerminalKillResult = typeof AcpClientTerminalKillResult.Type;

export const AcpClientTerminalReleaseInput = Schema.Struct({
  terminalId: Schema.String,
});
export type AcpClientTerminalReleaseInput = typeof AcpClientTerminalReleaseInput.Type;

export const AcpClientTerminalReleaseResult = Schema.Struct({});
export type AcpClientTerminalReleaseResult = typeof AcpClientTerminalReleaseResult.Type;
