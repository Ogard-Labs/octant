// The stylesheet draws every high-contrast rule under
// `data-octant-increased-contrast`. The system half is owned here, outside the
// settings provider: loading, pairing, recovery, and disconnected screens
// render before the provider mounts, and unmounting it (returning to the
// disconnected screen) must not strip the person's system preference.

export const SYSTEM_INCREASED_CONTRAST = "(prefers-contrast: more)";

let settingAsks = false;

function systemAsks(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.(SYSTEM_INCREASED_CONTRAST).matches === true
  );
}

function publish(): void {
  document.documentElement.dataset.octantIncreasedContrast = String(settingAsks || systemAsks());
}

/** Records whether the in-app setting asks for increased contrast. */
export function publishIncreasedContrastSetting(asks: boolean): void {
  settingAsks = asks;
  publish();
}

/**
 * Keeps the attribute on while the system asks for more contrast, from before
 * the first render. Returns a function that stops following the system.
 */
export function followSystemIncreasedContrast(): () => void {
  publish();
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia(SYSTEM_INCREASED_CONTRAST);
  media.addEventListener("change", publish);
  return () => media.removeEventListener("change", publish);
}
