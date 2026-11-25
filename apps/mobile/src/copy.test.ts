import { describe, expect, it } from "vitest";
import {
  collectMobileUserFacingCopy,
  mobileHostHealthLabel,
  mobileModelLabel,
  mobileThreadHint,
  MOBILE_PRODUCT_NAME,
  MOBILE_SCREEN_TITLES,
} from "./copy";

const retiredProductName = "OpenOr" + "bit";

describe("mobile package identity", () => {
  it("keeps Octant product naming in user-facing copy", () => {
    expect(MOBILE_PRODUCT_NAME).toBe("Octant");
    expect(collectMobileUserFacingCopy()).not.toContain(retiredProductName);
  });

  it("names every screen's title", () => {
    expect(MOBILE_SCREEN_TITLES).toEqual({
      home: "Octant",
      threads: "Threads",
      inbox: "Inbox",
      thread: "Thread",
      settings: "Settings",
      todos: "To-dos",
    });
  });

  it("keeps Work and Code follow-up guidance mode-specific and honest about host-only steps", () => {
    expect(mobileThreadHint("code")).toMatch(/approve/i);
    expect(mobileThreadHint("work")).toMatch(/stay there/i);
  });

  it("uses host-advertised model labels instead of inventing display names", () => {
    const options = [{ modelId: "gpt-5.6", label: "OpenAI flagship" }];

    expect(mobileModelLabel(options, "gpt-5.6")).toBe("OpenAI flagship");
    expect(mobileModelLabel(options, "provider-model")).toBe("provider-model");
  });

  it("maps supported host health kinds to user-facing labels", () => {
    expect(mobileHostHealthLabel("ready")).toBe("Ready");
    expect(mobileHostHealthLabel("stale")).toBe("Stale");
    expect(mobileHostHealthLabel("unavailable")).toBe("Unavailable");
  });
});
