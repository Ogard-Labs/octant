/**
 * Decides which poll results may land. A timer tick never starts a request
 * while one is in flight (a slow host would otherwise stack requests), a forced
 * reload may overlap but supersedes the older request, and nothing lands after
 * dispose.
 */
export interface PollGuard {
  /** A ticket for a new request, or undefined when a timer tick must skip. */
  readonly start: (options?: { readonly force?: boolean }) => number | undefined;
  /** True when this ticket is still the newest request and may update state. */
  readonly finish: (ticket: number) => boolean;
  readonly dispose: () => void;
}

export function createPollGuard(): PollGuard {
  let latest = 0;
  let inFlight = false;
  let disposed = false;
  return {
    start(options) {
      if (disposed) return undefined;
      if (inFlight && options?.force !== true) return undefined;
      latest += 1;
      inFlight = true;
      return latest;
    },
    finish(ticket) {
      if (ticket !== latest) return false;
      inFlight = false;
      return !disposed;
    },
    dispose() {
      disposed = true;
    },
  };
}
