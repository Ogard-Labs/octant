import { describe, expect, it } from "vitest";
import { createPairingScanGate, pairingCodeAfterTogglingDetails } from "./pairingScanGate";

describe("the pairing scanner", () => {
  it("hands over one pairing code per opening and scans again after it reopens", () => {
    const gate = createPairingScanGate();

    expect(gate.offer("https://example.com")).toBe("other");
    expect(gate.offer("octant-pair-1.AAAA")).toBe("deliver");
    expect(gate.offer("octant-pair-1.AAAA")).toBe("ignored");
    gate.reset();
    expect(gate.offer("octant-pair-1.AAAA")).toBe("deliver");
  });
});

describe("choosing to type the details after a scan failed", () => {
  it("drops the failed scan so submitting uses the typed details", () => {
    expect(pairingCodeAfterTogglingDetails("octant-pair-1.AAAA", true)).toBe("");
  });

  it("keeps a pasted code when the details form is closed again", () => {
    expect(pairingCodeAfterTogglingDetails("octant-pair-1.AAAA", false)).toBe("octant-pair-1.AAAA");
  });
});
