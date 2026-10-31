import type { PermissionMode, WorkAccess } from "@octant/contracts";
import {
  permissionModeOf,
  workAccessOfPermissionMode,
  workThreadAccessOf,
} from "@octant/domain/guardrail-policy";

/**
 * The modes a Work thread's composer offers, in Code's picker order. Work
 * shares Code's levels and has no Plan overlay.
 */
export const WORK_PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
  "auto",
  "ask-first",
  "accept-edits",
  "full-access",
];

/** The picker's word for a Work thread's level. */
export function workModeOf(access: WorkAccess): PermissionMode {
  return permissionModeOf(workThreadAccessOf(access));
}

/** The Work level a picker choice stores; Plan has none. */
export function workAccessOfMode(mode: PermissionMode): WorkAccess | undefined {
  return workAccessOfPermissionMode(mode);
}
