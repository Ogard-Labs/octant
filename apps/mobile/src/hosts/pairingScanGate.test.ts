import { describe, expect, it } from "vitest";
import { createPairingScanGate } from "./pairingScanGate";

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
