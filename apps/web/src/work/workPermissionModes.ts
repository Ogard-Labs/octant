import { DEFAULT_WORK_ACCESS, type PermissionMode, type WorkAccess } from "@octant/contracts";
import {
  permissionModeOf,
  workThreadAccessOf,
  workThreadAccessOfMode,
} from "@octant/domain/guardrail-policy";

/**
 * The picker's word for a Work thread's level. A thread record that carries
 * no level (one a host sent before levels existed, or a summary that leaves
 * it out) is at Ask first, as the contract decodes it.
 */
export function workModeOf(access: WorkAccess | undefined): PermissionMode {
  return permissionModeOf(workThreadAccessOf(access ?? DEFAULT_WORK_ACCESS));
}

/** The Work level a thread's picker choice stores. */
export function workAccessOfMode(mode: PermissionMode): WorkAccess {
  return workThreadAccessOfMode(mode);
}
