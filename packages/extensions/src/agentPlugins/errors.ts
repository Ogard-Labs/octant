import type { AgentPluginsDiagnostic } from "./constants";

export class AgentPluginsError extends Error {
  override readonly name = "AgentPluginsError";

  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: ReadonlyArray<AgentPluginsDiagnostic> = [],
  ) {
    super(message);
  }
}

export function fail(
  code: string,
  message: string,
  diagnostics: ReadonlyArray<AgentPluginsDiagnostic> = [],
): never {
  throw new AgentPluginsError(code, message, diagnostics);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!isRecord(value)) fail(code, message);
  return value;
}
