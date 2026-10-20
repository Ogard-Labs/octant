export interface RequestGuard {
  readonly begin: () => number;
  readonly invalidate: () => void;
  readonly isCurrent: (request: number) => boolean;
}

/**
 * A generation counter for responses that can arrive out of order. Each request
 * takes a number from `begin`; only the newest one is still current, so a slow
 * older response cannot overwrite the result of a newer request.
 */
export function createRequestGuard(): RequestGuard {
  let generation = 0;

  return {
    begin: () => {
      generation += 1;
      return generation;
    },
    invalidate: () => {
      generation += 1;
    },
    isCurrent: (request) => request === generation,
  };
}
