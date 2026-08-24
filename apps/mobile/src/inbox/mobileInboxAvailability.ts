import type { MobileInboxHostFailure } from "@octant/client-runtime";

export function summarizeMobileInboxFailures(input: {
  readonly failures: ReadonlyArray<MobileInboxHostFailure>;
  readonly hostLabels: ReadonlyMap<string, string>;
}): string | undefined {
  if (input.failures.length === 0) return undefined;
  return input.failures
    .map((failure) => {
      const label = input.hostLabels.get(failure.hostId) ?? failure.hostId;
      return `${label}: ${failure.message}`;
    })
    .join(" ");
}
