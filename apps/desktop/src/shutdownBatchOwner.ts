import type { MenuBarShutdownProgress } from "./menuBar";

/**
 * Which window's Prepare to shut down dialog runs the batch the menu bar
 * shows. Every window has its own dialog, and a dialog with no batch reports
 * no progress, so without an owner a second window's empty dialog would clear
 * the indicator while the first window's batch still moves, and Prepare to
 * Shut Down… would open a fresh dialog instead of the hidden running one.
 */
export class ShutdownBatchOwner {
  #owner: number | undefined;
  #progress: MenuBarShutdownProgress | undefined;

  /**
   * A window's report: a running batch's progress, or `undefined` when it
   * runs none. Only the owning window changes what is shown, and a window
   * becomes the owner by reporting progress while no batch is owned. Answers
   * whether what the menu bar shows changed.
   */
  report(windowId: number, progress: MenuBarShutdownProgress | undefined): boolean {
    if (this.#owner !== undefined && this.#owner !== windowId) return false;
    if (progress === undefined) {
      if (this.#owner === undefined) return false;
      this.#owner = undefined;
      this.#progress = undefined;
      return true;
    }
    this.#owner = windowId;
    this.#progress = progress;
    return true;
  }

  /** The window whose dialog Prepare to Shut Down… brings back; undefined when no batch runs. */
  windowToOpen(): number | undefined {
    return this.#owner;
  }

  progress(): MenuBarShutdownProgress | undefined {
    return this.#progress;
  }

  /** The owning window closed, and its dialog with it. Answers whether that changed anything. */
  windowClosed(windowId: number): boolean {
    if (this.#owner !== windowId) return false;
    this.#owner = undefined;
    this.#progress = undefined;
    return true;
  }
}
