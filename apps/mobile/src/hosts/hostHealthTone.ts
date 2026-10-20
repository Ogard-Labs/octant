import type { MobileHostHealthKind } from "../session/MobileHostSessionHub";

export type HostHealthTone = "neutral" | "warning" | "danger";

/** Only a host that needs attention changes colour; a ready or idle one stays quiet. */
export function hostHealthTone(kind: MobileHostHealthKind): HostHealthTone {
  if (kind === "stale") return "warning";
  if (kind === "unavailable") return "danger";
  return "neutral";
}
