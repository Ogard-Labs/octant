import { createHash } from "node:crypto";

const MAX_WINDOW_ID_LENGTH = 64;

/** Stable provider-window identity shared by event and polling adapters. */
export function rateLimitWindowId(
  scope: string | undefined,
  slot: "primary" | "secondary",
  durationMinutes: number | null | undefined,
): string {
  const local = localWindowName(slot, durationMinutes);
  if (scope === undefined || scope.trim().length === 0) return local;
  const candidate = `${scope.trim()}:${local}`;
  if (candidate.length <= MAX_WINDOW_ID_LENGTH) return candidate;
  const suffix = createHash("sha256").update(candidate).digest("hex").slice(0, 12);
  return `${candidate.slice(0, MAX_WINDOW_ID_LENGTH - suffix.length - 1)}-${suffix}`;
}

/** Canonicalizes equivalent event/poll labels without changing provider spelling. */
export function canonicalRateLimitWindowId(value: string): string {
  return value.trim();
}

function localWindowName(
  slot: "primary" | "secondary",
  durationMinutes: number | null | undefined,
): string {
  if (durationMinutes === undefined || durationMinutes === null || durationMinutes <= 0) {
    return slot;
  }
  if (durationMinutes % 1_440 === 0) return `${slot}_${durationMinutes / 1_440}d`;
  if (durationMinutes % 60 === 0) return `${slot}_${durationMinutes / 60}h`;
  return `${slot}_${durationMinutes}m`;
}
