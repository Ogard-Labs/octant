let clearDrafts: (() => void) | undefined;

export function registerComposerThreadDraftReset(reset: () => void): void {
  clearDrafts = reset;
}

/** Test seam: reset the shared draft store only when a test actually loaded it. */
export function resetComposerThreadDrafts(): void {
  clearDrafts?.();
}
