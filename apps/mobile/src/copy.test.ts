import { describe, expect, it } from "vitest";
import {
  collectMobileUserFacingCopy,
  mobileHostHealthLabel,
  mobileModelLabel,
  mobileThreadComposerCopy,
  MOBILE_PRODUCT_NAME,
  MOBILE_ROUTE_IDS,
  MOBILE_TAB_LABELS,
} from "./copy";

const retiredProductName = "OpenOr" + "bit";

describe("mobile package identity", () => {
  it("keeps Octant product naming in user-facing copy", () => {
    expect(MOBILE_PRODUCT_NAME).toBe("Octant");
    expect(collectMobileUserFacingCopy()).not.toContain(retiredProductName);
  });

  it("exposes Inbox home, Agents, Thread, and Hosts routes", () => {
    expect([...MOBILE_ROUTE_IDS]).toEqual(["home", "agents", "thread", "hosts"]);
    expect(MOBILE_TAB_LABELS).toEqual({
      home: "Inbox",
      agents: "Agents",
      thread: "Thread",
      hosts: "Hosts",
    });
  });

  it("keeps Work and Code follow-up guidance mode-specific and honest about host-only steps", () => {
    expect(mobileThreadComposerCopy("work")).toMatchObject({
      placeholder: expect.stringContaining("Work"),
    });
    expect(mobileThreadComposerCopy("code")).toMatchObject({
      placeholder: expect.stringContaining("Code"),
    });
    expect(mobileThreadComposerCopy("code").footerHint).toMatch(/approve/i);
    expect(mobileThreadComposerCopy("work").footerHint).toMatch(/desktop/i);
    expect(mobileThreadComposerCopy("code")).not.toEqual(mobileThreadComposerCopy("work"));
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
