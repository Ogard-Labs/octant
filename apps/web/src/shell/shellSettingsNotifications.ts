/**
 * Window-scoped signal that shell settings were journaled outside the shell
 * controller's own commands — today that is the Browser approval's "always
 * allow" answer, which the server writes itself. The shell controller listens
 * and re-reads, so a later settings edit does not race a stale version and
 * lose the person's write to a conflict reload.
 */
export const SHELL_SETTINGS_WRITTEN = "octant:shell-settings-written";

export function announceShellSettingsWritten(): void {
  window.dispatchEvent(new Event(SHELL_SETTINGS_WRITTEN));
}
