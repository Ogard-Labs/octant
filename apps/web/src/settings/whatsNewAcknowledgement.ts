/**
 * Which update's notes this window has acknowledged.
 *
 * Two entry points acknowledge: the sidebar card or announcement, and the
 * Updates row in Settings. They share this one record so the bridge is written
 * once per update and the surface the other entry point left behind hides. One
 * window is one JavaScript realm, so a module holds it; nothing is global on
 * `window` and no DOM event carries it.
 */
let acknowledgedVersion: string | undefined;
const listeners = new Set<() => void>();

/**
 * Records the version as acknowledged and runs `write` only the first time it
 * is seen. The record is set before the write settles: a person who answered
 * should not keep seeing the card because a write failed.
 */
export function acknowledgeWhatsNewOnce(version: string, write: () => unknown): void {
  if (acknowledgedVersion === version) return;
  acknowledgedVersion = version;
  for (const listener of [...listeners]) listener();
  void Promise.resolve()
    .then(write)
    .catch(() => undefined);
}

export function acknowledgedWhatsNewVersion(): string | undefined {
  return acknowledgedVersion;
}

export function subscribeWhatsNewAcknowledgement(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** For tests: a fresh window has acknowledged nothing. */
export function resetWhatsNewAcknowledgement(): void {
  acknowledgedVersion = undefined;
  for (const listener of [...listeners]) listener();
}
