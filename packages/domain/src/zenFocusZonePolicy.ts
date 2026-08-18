import {
  MAX_ZEN_SPACES_PER_WINDOW,
  type AggregateVersion,
  type UtcTimestamp,
  type WindowId,
  type ZenFocusZone,
  type ZenFocusZoneCommand,
  type ZenSpaceId,
  type ZenSpaceSummary,
} from "@octant/contracts";

export { MAX_ZEN_SPACES_PER_WINDOW };

export type ZenFocusZoneRejectionCode =
  | "stale-version"
  | "unknown-space"
  | "duplicate-space"
  | "space-limit-reached"
  | "last-space"
  | "invalid-position";

export class ZenFocusZoneRejected extends Error {
  override readonly name = "ZenFocusZoneRejected";

  constructor(
    readonly code: ZenFocusZoneRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: ZenFocusZoneRejectionCode, message: string): never {
  throw new ZenFocusZoneRejected(code, message);
}

/**
 * What one focus-zone command changed.
 *
 * `activated` and `deactivated` name the spaces whose own showing flag the
 * caller has to move. The zone is the authority for which space is in front;
 * the flag on a space says whether the focus zone is replacing the shell, and
 * only the caller can write it, so the policy reports the pair rather than
 * leaving the caller to work it out.
 */
export interface ZenFocusZoneTransition {
  readonly zone: ZenFocusZone;
  readonly activated: ZenSpaceId;
  readonly deactivated?: ZenSpaceId;
}

function nextVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}

/** Renumber positions 0..n-1 in list order, so the order is the positions. */
function positioned(spaces: ReadonlyArray<ZenSpaceSummary>): ReadonlyArray<ZenSpaceSummary> {
  return spaces.map((space, position) => ({ ...space, position }));
}

function ordered(zone: ZenFocusZone): ReadonlyArray<ZenSpaceSummary> {
  return [...zone.spaces].sort((left, right) => left.position - right.position);
}

function requireSpace(zone: ZenFocusZone, spaceId: ZenSpaceId): ZenSpaceSummary {
  const found = zone.spaces.find((space) => String(space.spaceId) === String(spaceId));
  if (found === undefined) reject("unknown-space", "This window holds no such space.");
  return found;
}

function requireVersion(zone: ZenFocusZone, expected: AggregateVersion): void {
  if (zone.version !== expected) {
    reject("stale-version", "The focus zone moved under this command; reload and retry.");
  }
}

/** The first space of a window's focus zone, in front from the moment it opens. */
export function createZenFocusZone(
  windowId: WindowId,
  spaceId: ZenSpaceId,
  name: string,
  now: UtcTimestamp,
): ZenFocusZone {
  return {
    windowId,
    version: 1 as AggregateVersion,
    spaces: [{ spaceId, name, position: 0 }],
    activeSpaceId: spaceId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The space one step away in the switcher, wrapping at both ends.
 *
 * Wrapping is what makes a single keystroke reach every space; stopping at the
 * ends would make the last space reachable only by counting.
 */
export function cycleZenSpace(zone: ZenFocusZone, step: 1 | -1): ZenSpaceId {
  const list = ordered(zone);
  const index = list.findIndex((space) => String(space.spaceId) === String(zone.activeSpaceId));
  const from = index === -1 ? 0 : index;
  const next = (from + step + list.length) % list.length;
  return (list[next] ?? list[0])!.spaceId;
}

/**
 * Apply one command to a window's focus zone.
 *
 * The zone holds only which spaces exist, in what order, and which is in front.
 * What is pinned to a space lives with the space, so a switch never rewrites
 * anyone's work and the switcher can list every space without loading one.
 */
export function applyZenFocusZoneCommand(
  zone: ZenFocusZone,
  command: ZenFocusZoneCommand,
  context: { readonly now: UtcTimestamp; readonly spaceId?: ZenSpaceId },
): ZenFocusZoneTransition {
  requireVersion(zone, command.expectedVersion);
  const base = { version: nextVersion(zone.version), updatedAt: context.now };

  switch (command.command) {
    case "add-space": {
      const spaceId = context.spaceId;
      if (spaceId === undefined) reject("unknown-space", "A new space needs its own identity.");
      if (zone.spaces.some((space) => String(space.spaceId) === String(spaceId))) {
        reject("duplicate-space", "This window already holds a space with that identity.");
      }
      if (zone.spaces.length >= MAX_ZEN_SPACES_PER_WINDOW) {
        reject(
          "space-limit-reached",
          `A window holds at most ${String(MAX_ZEN_SPACES_PER_WINDOW)} spaces.`,
        );
      }
      const spaces = positioned([
        ...ordered(zone),
        { spaceId, name: command.name, position: zone.spaces.length },
      ]);
      // A space you just made is a space you want to be in.
      return {
        zone: { ...zone, ...base, spaces, activeSpaceId: spaceId },
        activated: spaceId,
        deactivated: zone.activeSpaceId,
      };
    }
    case "rename-space": {
      requireSpace(zone, command.spaceId);
      const spaces = ordered(zone).map((space) =>
        String(space.spaceId) === String(command.spaceId)
          ? { ...space, name: command.name }
          : space,
      );
      return {
        zone: { ...zone, ...base, spaces: positioned(spaces) },
        activated: zone.activeSpaceId,
      };
    }
    case "reorder-space": {
      requireSpace(zone, command.spaceId);
      if (command.position >= zone.spaces.length) {
        reject("invalid-position", "That position is past the end of this window's spaces.");
      }
      const list = ordered(zone);
      const moving = list.filter((space) => String(space.spaceId) !== String(command.spaceId));
      const target = requireSpace(zone, command.spaceId);
      moving.splice(command.position, 0, target);
      return {
        zone: { ...zone, ...base, spaces: positioned(moving) },
        activated: zone.activeSpaceId,
      };
    }
    case "activate-space": {
      requireSpace(zone, command.spaceId);
      if (String(zone.activeSpaceId) === String(command.spaceId)) {
        return { zone: { ...zone, ...base }, activated: command.spaceId };
      }
      return {
        zone: { ...zone, ...base, activeSpaceId: command.spaceId },
        activated: command.spaceId,
        deactivated: zone.activeSpaceId,
      };
    }
    case "remove-space": {
      requireSpace(zone, command.spaceId);
      if (zone.spaces.length === 1) {
        reject("last-space", "A window keeps its last space; a zone with none cannot be shown.");
      }
      const list = ordered(zone);
      const index = list.findIndex((space) => String(space.spaceId) === String(command.spaceId));
      const remaining = positioned(list.filter((_space, at) => at !== index));
      const leaving = String(zone.activeSpaceId) === String(command.spaceId);
      // The front goes to the neighbour that took the removed space's place,
      // or to the new last space when the end was removed.
      const successor = leaving
        ? (remaining[Math.min(index, remaining.length - 1)] ?? remaining[0])!.spaceId
        : zone.activeSpaceId;
      return {
        zone: { ...zone, ...base, spaces: remaining, activeSpaceId: successor },
        activated: successor,
        ...(leaving ? { deactivated: command.spaceId } : {}),
      };
    }
  }
}
