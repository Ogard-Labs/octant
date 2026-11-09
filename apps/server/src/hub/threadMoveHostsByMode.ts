// One source host and one destination host in front of each mode's own, so
// the move service sees a single host. A mode with no adapter here reads as a
// thread that cannot move, and its offers are refused.

import type { MovedThreadReference, OctantMode } from "@octant/contracts";
import type { ThreadMoveDestinationHost, ThreadMoveSourceHost } from "./threadMoveService";

type ModeHosts = {
  readonly source: ThreadMoveSourceHost;
  readonly destination: ThreadMoveDestinationHost;
};

export function threadMoveHostsByMode(hosts: Partial<Record<OctantMode, ModeHosts>>): ModeHosts {
  const of = (thread: MovedThreadReference) => hosts[thread.mode];
  return {
    source: {
      read: async (thread) => (await of(thread)?.source.read(thread)) ?? { status: "missing" },
      freeze: (thread) => of(thread)?.source.freeze(thread),
      unfreeze: (thread) => of(thread)?.source.unfreeze(thread),
      isFrozen: (thread) => of(thread)?.source.isFrozen(thread) ?? false,
      measure: async (thread) =>
        (await of(thread)?.source.measure(thread)) ?? { status: "unknown" },
      pack: async (thread, folder, moveId) =>
        (await of(thread)?.source.pack(thread, folder, moveId)) ?? {
          status: "refused",
          reason: "refused",
        },
      erase: async (input) =>
        (await of(input.thread)?.source.erase(input)) ?? { worktreeKept: false },
    },
    destination: {
      acceptsProject: async (placement) =>
        (await hosts[placement.mode]?.destination.acceptsProject(placement)) ?? false,
      arrive: async (input) =>
        (await hosts[input.thread.mode]?.destination.arrive(input)) ?? {
          status: "refused",
          reason: "no-eligible-project",
        },
      activate: async (thread) => {
        await of(thread)?.destination.activate(thread);
      },
      discard: async (thread) => {
        await of(thread)?.destination.discard(thread);
      },
    },
  };
}
