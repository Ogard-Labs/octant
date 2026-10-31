import { DEFAULT_WORK_ACCESS, type PermissionMode, type WorkAccess } from "@octant/contracts";
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

/**
 * The picker's word for a Work thread's level. A thread record that carries
 * no level (one a host sent before levels existed, or a summary that leaves
 * it out) is at Ask first, as the contract decodes it.
 */
export function workModeOf(access: WorkAccess | undefined): PermissionMode {
  return permissionModeOf(workThreadAccessOf(access ?? DEFAULT_WORK_ACCESS));
}

/** The Work level a picker choice stores; Plan has none. */
export function workAccessOfMode(mode: PermissionMode): WorkAccess | undefined {
  return workAccessOfPermissionMode(mode);
}
