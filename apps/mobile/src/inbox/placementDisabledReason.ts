import type { MobileHostHealthKind } from "../session/MobileHostSessionHub";

/**
 * The one line under the composer that says why the chosen host cannot take a
 * new thread. A model list that failed to load is shown too: before, the
 * picker just went empty and the person could not tell why.
 */
export function presentPlacementDisabledReason(input: {
  readonly hostLabel: string | undefined;
  readonly health: MobileHostHealthKind;
  readonly healthDetail: string | undefined;
  readonly modelsFailed: boolean;
}): string | undefined {
  const label = input.hostLabel ?? "This host";
  if (input.health === "stale") {
    const detail = input.healthDetail?.replace(/^Last host refresh was /i, "last refresh ");
    return `${label} is stale — ${detail ?? "last refresh is unknown"}. Refresh the host to send.`;
  }
  if (input.health === "unavailable") return `${label} is unavailable.`;
  if (input.modelsFailed) return `Couldn't load models from ${label}.`;
  return undefined;
}
