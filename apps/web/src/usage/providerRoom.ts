import type { ProviderUsageLimitsEntry } from "@octant/contracts";
import { NEAR_LIMIT_PERCENT } from "../context/composerLimitWindows";

/**
 * How much room a provider account has, from the plan windows the host last
 * observed. `unknown` means nothing was reported (an API key, a runtime that
 * does not report, a window whose reset has passed): it is never read as room
 * or as a limit, because neither was observed.
 */
export interface ProviderRoom {
  readonly standing: "room" | "near" | "limited" | "unknown";
  /** When the limit lifts (limited) or the nearest window refills (near), where the provider said. */
  readonly resetsAt?: string;
}

const UNKNOWN: ProviderRoom = { standing: "unknown" };

/**
 * The room of every provider instance that reported a plan window, by instance id.
 *
 * Read from each unexpired window's own status, not from the drawn bars: an
 * exhausted window with no utilization figure draws no bar, yet it is still a
 * limit the account has reached. The figure only decides "near" for a window
 * the provider has not flagged.
 */
export function providerRoomByInstance(
  entries: ReadonlyArray<ProviderUsageLimitsEntry>,
  now: number,
): ReadonlyMap<string, ProviderRoom> {
  const rooms = new Map<string, ProviderRoom>();
  for (const entry of entries) {
    const limits =
      entry.status === "available"
        ? entry.limits
        : entry.status === "failed"
          ? entry.staleLimits
          : undefined;
    // A window whose reset has passed says nothing about the account now.
    const windows = (limits?.rateLimitWindows ?? []).filter(
      (window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > now,
    );
    if (windows.length === 0) continue;
    const spent = windows.filter((window) => window.status === "exhausted");
    const near = windows.filter(
      (window) =>
        window.status === "warning" ||
        (window.utilization !== undefined &&
          Math.round(Math.max(0, Math.min(1, window.utilization)) * 100) >= NEAR_LIMIT_PERCENT),
    );
    // A spent window clears only when its reset comes, so the latest one
    // among the spent windows is when the account is usable again. A nearly
    // spent window warns at the soonest refill.
    const pick = (chosen: typeof spent, latest: boolean): string | undefined => {
      const times = chosen
        .flatMap((window) => window.resetsAt ?? [])
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      return latest ? times[times.length - 1] : times[0];
    };
    const resetsAt = spent.length > 0 ? pick(spent, true) : pick(near, false);
    const standing = spent.length > 0 ? "limited" : near.length > 0 ? "near" : "room";
    rooms.set(String(entry.providerInstanceId), {
      standing,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  return rooms;
}

export function roomOf(
  rooms: ReadonlyMap<string, ProviderRoom>,
  providerInstanceId: string,
): ProviderRoom {
  return rooms.get(providerInstanceId) ?? UNKNOWN;
}

/** Whether an account is at or close to its limit. */
export function isConstrained(room: ProviderRoom): boolean {
  return room.standing === "limited" || room.standing === "near";
}
