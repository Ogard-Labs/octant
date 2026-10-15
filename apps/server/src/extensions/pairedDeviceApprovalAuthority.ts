/**
 * Whether a device registration still pairs its device right now. The
 * projection's `state` moves to `expired` only when the expiry reconciliation
 * runs, so a registration past its deadline can still read `active`; the
 * deadline is compared here too, and one that cannot be read fails closed.
 */
export function isDeviceRegistrationCurrent(
  registration: { readonly state: string; readonly expiresAt: string } | undefined,
  nowMs: number,
): boolean {
  if (registration?.state !== "active") return false;
  const expiresAtMs = Date.parse(registration.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

/**
 * Whether a Chat thread still stands where a prompt recorded it: active, and
 * in the same Chat Project, or in none when the prompt recorded none. A thread
 * archived or moved since the call was made no longer carries its authority.
 */
export function chatThreadStandsInProject(
  thread: { readonly lifecycle: string; readonly projectId?: unknown } | undefined,
  projectId: string | undefined,
): boolean {
  if (thread === undefined || thread.lifecycle !== "active") return false;
  const current = thread.projectId === undefined ? undefined : String(thread.projectId);
  return current === projectId;
}
