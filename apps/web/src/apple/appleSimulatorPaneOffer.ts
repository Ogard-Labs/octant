/**
 * In-app Simulator pane requests an agent stamped, and which of them the dock
 * has already shown.
 *
 * `boot`, `run`, and `open` mint a requestId on the runtime snapshot. The
 * renderer offers the dock tab once per request: a later stamp is a new ask,
 * and a tab the person closed stays closed until then.
 */
export interface SimulatorPaneOffers {
  readonly offered: ReadonlySet<string>;
}

export const NO_SIMULATOR_PANE_OFFERS: SimulatorPaneOffers = { offered: new Set() };

/**
 * Notes one pane-open request. `open` is true exactly once per requestId:
 * the first time it is seen, never after the person closed the tab that
 * showed it.
 */
export function noteSimulatorPaneRequest(
  offers: SimulatorPaneOffers,
  requestId: string,
): { readonly offers: SimulatorPaneOffers; readonly open: boolean } {
  if (offers.offered.has(requestId)) return { offers, open: false };
  const offered = new Set(offers.offered);
  offered.add(requestId);
  return { offers: { offered }, open: true };
}
