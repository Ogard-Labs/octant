import { describe, expect, it } from "vitest";
import { placeTourCard } from "./guidedTourSteps";

const viewport = { width: 1440, height: 900 };
const card = { width: 336, height: 270 };

describe("placeTourCard", () => {
  it("slides a card beside a control at the foot of the sidebar up above the account row", () => {
    const gear = { left: 6, top: 856, width: 32, height: 32 };
    const account = { left: 44, top: 836, width: 328, height: 44 };
    const spot = placeTourCard(gear, card, viewport, ["right", "above"], "center", [account]);
    expect(spot.left).toBeGreaterThan(gear.left + gear.width);
    expect(spot.top + card.height).toBeLessThanOrEqual(account.top);
  });

  it("leaves the card level with its control when nothing is in the way", () => {
    const button = { left: 6, top: 300, width: 32, height: 32 };
    const spot = placeTourCard(button, card, viewport, ["right", "below"]);
    expect(spot.top).toBe(button.top + button.height / 2 - card.height / 2);
  });

  it("never covers the control it points at", () => {
    const control = { left: 600, top: 800, width: 200, height: 60 };
    const spot = placeTourCard(control, card, viewport, ["above", "right"]);
    const covers =
      spot.left < control.left + control.width &&
      spot.left + card.width > control.left &&
      spot.top < control.top + control.height &&
      spot.top + card.height > control.top;
    expect(covers).toBe(false);
  });
});
