/**
 * Renderer chrome a native page must never be painted over. A native view is a
 * window-level sibling rather than a node in the document, so nothing drawn in
 * React can cover it; while any of these is up the page leaves the window.
 */
export const RENDERER_OVERLAY_SELECTOR = [
  ".code-board-layer",
  // A divider being dragged across a tile, or a tab being dragged onto the dock.
  ".dock-tiles__drag-shield",
  // A shell or split divider mid-drag: the native page would swallow the pointer.
  ".shell-resize-shield",
  ".rail-placeholder",
  ".workspace-drag-preview",
  ".workspace-drop-overlay",
  // A kept capture being drawn on: the page leaves the window for as long as it is up.
  ".browser-markup",
  ".octant-dialog__backdrop",
  ".octant-dialog__viewport",
  ".octant-dialog__popup",
  // Settings floats over a workspace that stays mounted, Browser pane and all.
  ".octant-sheet__backdrop",
  ".octant-sheet__viewport",
  ".octant-sheet__popup",
  // Floating chrome a click opens over the page area: notices, menus,
  // popovers and disclosures. Tooltips stay out on purpose: they open on
  // hover, and the page leaving the window whenever any tooltip in the window
  // opened would flash it away. The Browser toolbar uses native titles, which
  // the system draws above the native view.
  ".toast-stack",
  '[data-slot="popover-content"]',
  '[data-slot="combobox-content"]',
  '[data-slot="select-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
  ".thread-info__panel:not([hidden])",
  ".window-chrome__disclosure",
  ".zen-panel",
].join(", ");
