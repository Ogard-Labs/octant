import { describe, expect, it } from "vitest";
import { wholeRowScrollTop } from "./settingsRailScroll";

// A rail 100px tall whose top edge is at 0, with 28px heading rows.
const rail = { top: 0, bottom: 100, maxScrollTop: 60 } as const;

describe("wholeRowScrollTop", () => {
  it("scrolls a half-hidden heading away whole", () => {
    const next = wholeRowScrollTop({
      ...rail,
      scrollTop: 16,
      rows: [
        { top: -16, bottom: 12 },
        { top: 12, bottom: 40 },
      ],
      selected: { top: 70, bottom: 98 },
    });

    expect(next).toBe(28);
  });

  it("leaves the rail alone when no row is cut at the top", () => {
    const next = wholeRowScrollTop({
      ...rail,
      scrollTop: 28,
      rows: [
        { top: -28, bottom: 0 },
        { top: 0, bottom: 28 },
      ],
      selected: { top: 70, bottom: 98 },
    });

    expect(next).toBe(28);
  });

  it("shows the heading whole when the rail cannot scroll past it", () => {
    const next = wholeRowScrollTop({
      ...rail,
      maxScrollTop: 16,
      scrollTop: 16,
      rows: [{ top: -16, bottom: 12 }],
      selected: { top: 50, bottom: 70 },
    });

    expect(next).toBe(0);
  });

  it("keeps the selected page visible rather than reveal a heading", () => {
    const next = wholeRowScrollTop({
      ...rail,
      maxScrollTop: 16,
      scrollTop: 16,
      rows: [{ top: -16, bottom: 12 }],
      selected: { top: 76, bottom: 100 },
    });

    expect(next).toBe(16);
  });
});
