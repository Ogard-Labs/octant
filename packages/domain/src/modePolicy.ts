import type { OctantMode, ProductSurfaceSettings } from "@octant/contracts/modes";

export function enabledModes(settings: ProductSurfaceSettings): ReadonlyArray<OctantMode> {
  const modes: Array<OctantMode> = [];
  if (settings.chatEnabled) modes.push("chat");
  if (settings.workEnabled) modes.push("work");
  modes.push("code");
  return modes;
}

export function resolveAvailableMode(
  requested: OctantMode,
  settings: ProductSurfaceSettings,
): OctantMode {
  return enabledModes(settings).includes(requested) ? requested : "code";
}
