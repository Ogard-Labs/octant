import { describe, expect, it } from "vitest";
import {
  collectMobileUserFacingCopy,
  mobileThreadReadOnlyCopy,
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

  it("exposes Inbox home, All Agents, Thread, and Hosts routes", () => {
    expect([...MOBILE_ROUTE_IDS]).toEqual(["home", "agents", "thread", "hosts"]);
    expect(MOBILE_TAB_LABELS).toEqual({
      home: "Inbox",
      agents: "All Agents",
      thread: "Thread",
      hosts: "Hosts",
    });
  });

  it("keeps Work and Code read-only guidance mode-specific", () => {
    expect(mobileThreadReadOnlyCopy("work")).toMatchObject({
      footerHint: expect.stringContaining("Work"),
    });
    expect(mobileThreadReadOnlyCopy("code")).toMatchObject({
      footerHint: expect.stringContaining("Code"),
    });
    expect(mobileThreadReadOnlyCopy("code")).not.toEqual(mobileThreadReadOnlyCopy("work"));
  });
});
