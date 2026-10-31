import type { ProviderUsageLimitsEntry } from "@octant/contracts";
import { railUsageReadings } from "./railUsageReading";

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

/** The room of every provider instance that reported a plan window, by instance id. */
export function providerRoomByInstance(
  entries: ReadonlyArray<ProviderUsageLimitsEntry>,
  now: number,
): ReadonlyMap<string, ProviderRoom> {
  return new Map(
    railUsageReadings(entries, now).map((reading) => {
      const spent = reading.windows.filter((window) => window.level === "spent");
      const near = reading.windows.filter((window) => window.level === "near");
      // A spent window clears only when its reset comes, so the latest one
      // among the spent windows is when the account is usable again. A nearly
      // spent window warns at the soonest refill.
      const pick = (windows: typeof spent, latest: boolean): string | undefined => {
        const times = windows
          .flatMap((window) => reading.resetsAt.get(window.window) ?? [])
          .sort((a, b) => Date.parse(a) - Date.parse(b));
        return latest ? times[times.length - 1] : times[0];
      };
      const resetsAt = spent.length > 0 ? pick(spent, true) : pick(near, false);
      const standing = spent.length > 0 ? "limited" : near.length > 0 ? "near" : "room";
      return [
        reading.providerInstanceId,
        { standing, ...(resetsAt === undefined ? {} : { resetsAt }) },
      ] as const;
    }),
  );
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
