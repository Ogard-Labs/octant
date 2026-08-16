export interface ProjectRequestGuard {
  readonly begin: () => number;
  readonly invalidate: () => void;
  readonly isCurrent: (request: number) => boolean;
}

export function createProjectRequestGuard(): ProjectRequestGuard {
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
