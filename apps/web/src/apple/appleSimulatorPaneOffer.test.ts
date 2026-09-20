import { describe, expect, it } from "vitest";
import { NO_SIMULATOR_PANE_OFFERS, noteSimulatorPaneRequest } from "./appleSimulatorPaneOffer";

describe("noteSimulatorPaneRequest", () => {
  it("opens the in-app pane once per request, and not again after it was shown", () => {
    const first = noteSimulatorPaneRequest(
      NO_SIMULATOR_PANE_OFFERS,
      "10000000-0000-4000-8000-000000000001",
    );
    expect(first.open).toBe(true);
    const again = noteSimulatorPaneRequest(first.offers, "10000000-0000-4000-8000-000000000001");
    expect(again.open).toBe(false);
    const later = noteSimulatorPaneRequest(again.offers, "10000000-0000-4000-8000-000000000002");
    expect(later.open).toBe(true);
  });
});
