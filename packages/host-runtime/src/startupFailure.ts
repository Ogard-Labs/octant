import { HostRuntimePathError } from "./paths";

/**
 * Exit code for a start-up failure the operator has to fix before the host can
 * run at all (`EX_CONFIG`). A path validation failure is not a crash: retrying
 * the same environment cannot succeed, so launchers stop and report instead of
 * restarting with backoff.
 */
export const CONFIGURATION_FAILURE_EXIT_CODE = 78;

/**
 * Exit code a host process should carry when it stops during start-up. Only
 * failures that name a configuration problem are marked; everything else stays
 * a crash so supervisors keep their ordinary restart behaviour.
 */
export function startupFailureExitCode(error: unknown): number {
  return error instanceof HostRuntimePathError ? CONFIGURATION_FAILURE_EXIT_CODE : 1;
}
