/** The most launch links held before a Nightly window exists; older ones are dropped first. */
export const NIGHTLY_LAUNCH_LINK_LIMIT = 8;

export interface NightlyLaunchLinks {
  /** Holds a link delivered before the client can take it, or hands it on once it can. */
  readonly receive: (url: string) => void;
  /** Sends every held link, then every later one, to the client. */
  readonly handOff: (accept: (url: string) => void) => void;
  /** Stops holding links, for a launch that is not the Nightly client. */
  readonly stop: () => void;
}

/**
 * macOS delivers the `open-url` that launched Nightly while the entry is still
 * checking Octant's host, long before the client module loads, and the link is
 * not in argv to read again. The entry holds those links here from its first
 * synchronous step. Only strings in Nightly's own scheme are kept, and at most
 * a few; the client still parses each one and drops any it would not open.
 */
export function createNightlyLaunchLinks(
  scheme: string,
  limit = NIGHTLY_LAUNCH_LINK_LIMIT,
): NightlyLaunchLinks {
  const held: string[] = [];
  let accept: ((url: string) => void) | undefined;
  let stopped = false;
  return {
    receive: (url) => {
      if (stopped || !url.startsWith(`${scheme}://`)) return;
      if (accept !== undefined) {
        accept(url);
        return;
      }
      held.push(url);
      if (held.length > limit) held.splice(0, held.length - limit);
    },
    handOff: (client) => {
      accept = client;
      for (const url of held.splice(0)) client(url);
    },
    stop: () => {
      stopped = true;
      held.length = 0;
    },
  };
}
