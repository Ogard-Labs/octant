/** How long a first ⌘Q waits for the second press. */
export const QUIT_SHORTCUT_WINDOW_MS = 1500;

export interface QuitShortcutGuardOptions {
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** Shows the "press again" notice; false when no window could show it. */
  readonly showNotice: () => boolean;
  /** Starts the guarded shutdown. */
  readonly quit: () => void;
}

/**
 * Only the ⌘Q keyboard accelerator needs a second press. A menu accelerator
 * cannot tell a held key from a tap, so a short double-press window stands in
 * for hold-to-quit. Choosing Quit with the pointer is deliberate and quits at
 * once. With no window to carry the notice, the first press quits directly: a
 * hint nobody can see would only make the app seem to ignore the key.
 */
export function createQuitShortcutGuard(options: QuitShortcutGuardOptions): {
  readonly request: (request: { readonly viaShortcut: boolean }) => void;
} {
  let firstPressAt: number | undefined;
  return {
    request: ({ viaShortcut }) => {
      const at = options.now();
      const confirmed = firstPressAt !== undefined && at - firstPressAt <= QUIT_SHORTCUT_WINDOW_MS;
      firstPressAt = undefined;
      if (!viaShortcut || confirmed || !options.showNotice()) {
        options.quit();
        return;
      }
      firstPressAt = at;
    },
  };
}
