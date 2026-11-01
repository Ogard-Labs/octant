import type { PermissionMode } from "@octant/contracts/providers";
import type { WorkAccess } from "@octant/contracts";
import { threadAccessOf, workAccessOfPermissionMode } from "@octant/domain/guardrail-policy";

export interface FirstRunModeWriters {
  /** Saves Code's default for new threads; false when Code settings are not loaded or the save failed. */
  readonly saveCode: (access: ReturnType<typeof threadAccessOf>) => Promise<boolean>;
  /** Saves Work's default; absent when Work is off or its settings are unreadable. */
  readonly saveWork?: ((access: WorkAccess) => Promise<boolean>) | undefined;
}

/**
 * Records the first-run answer as the default for new Code threads and new
 * Work threads. Work has no Plan, so a Plan answer leaves Work asking first.
 * The answer counts as recorded only when every default that exists took it.
 */
export async function recordFirstRunMode(
  mode: PermissionMode,
  writers: FirstRunModeWriters,
): Promise<boolean> {
  const codeSaved = await writers.saveCode(threadAccessOf(mode));
  if (writers.saveWork === undefined) return codeSaved;
  const workSaved = await writers.saveWork(workAccessOfPermissionMode(mode) ?? "ask-first");
  return codeSaved && workSaved;
}
