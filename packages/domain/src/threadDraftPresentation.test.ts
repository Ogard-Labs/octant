import { describe, expect, it } from "vitest";
import { draftThreadModePresentation, welcomeGreeting } from "./threadDraftPresentation";

describe("draftThreadModePresentation", () => {
  it("returns chat-specific welcome copy", () => {
    const presentation = draftThreadModePresentation("chat");
    expect(presentation.mode).toBe("chat");
    expect(presentation.eyebrow).toBe("Octant Chat");
    expect(presentation.heading).toBe("What are you working on?");
    expect(presentation.intentCards.length).toBeGreaterThanOrEqual(2);
    expect(presentation.composerPlaceholder).toBeTruthy();
  });

  it("returns work-specific welcome copy", () => {
    const presentation = draftThreadModePresentation("work");
    expect(presentation.mode).toBe("work");
    expect(presentation.eyebrow).toBe("Octant Work");
    expect(presentation.intentCards.length).toBeGreaterThanOrEqual(2);
  });

  it("returns code-specific welcome copy", () => {
    const presentation = draftThreadModePresentation("code");
    expect(presentation.mode).toBe("code");
    expect(presentation.eyebrow).toBe("Octant Code");
    expect(presentation.heading).toBe("What should we build?");
    expect(presentation.intentCards.length).toBeGreaterThanOrEqual(2);
  });

  it("provides unique intent card IDs per mode", () => {
    for (const mode of ["chat", "work", "code"] as const) {
      const presentation = draftThreadModePresentation(mode);
      const ids = presentation.intentCards.map((card) => card.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("welcome greeting", () => {
  it("greets by the hour and by name, and stays polite without a name", () => {
    expect(welcomeGreeting({ hour: 7, name: "Henrik" })).toBe("Good morning, Henrik");
    expect(welcomeGreeting({ hour: 12, name: "Henrik" })).toBe("Good afternoon, Henrik");
    expect(welcomeGreeting({ hour: 18, name: "Henrik" })).toBe("Good evening, Henrik");
    expect(welcomeGreeting({ hour: 2, name: "Henrik" })).toBe("Good evening, Henrik");
    expect(welcomeGreeting({ hour: 9 })).toBe("Good morning");
    expect(welcomeGreeting({ hour: 9, name: "  " })).toBe("Good morning");
  });
});
