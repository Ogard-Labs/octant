// The saved theme reaches the renderer only after the host answers, and the
// theme provider mounts only inside the shell. Until then the stylesheet's own
// dark default is what paints, so a light theme opened on a black frame. The
// last window remembers the mode it drew, and the next one applies it before
// its first render; the stylesheet's `html[data-octant-theme-mode="light"]`
// tokens then carry the colours, so no colour is held here.

const STORAGE_KEY = "octant.theme-mode";

type RememberedMode = "light" | "dark" | "system";

function readStoredMode(): RememberedMode | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the mode the person chose, so the next start can paint it first. */
export function rememberThemeMode(mode: RememberedMode): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage only speeds up the first frame; the host keeps the saved theme.
  }
}

/** Paints the remembered mode before the first render. The theme provider replaces it. */
export function applyRememberedThemeMode(): void {
  const root = document.documentElement;
  if (root.dataset.octantThemeMode !== undefined) return;
  const stored = readStoredMode();
  if (stored === undefined) return;
  const mode =
    stored === "system"
      ? globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches === false
        ? "light"
        : "dark"
      : stored;
  root.dataset.octantThemeMode = mode;
  root.style.colorScheme = mode;
}
