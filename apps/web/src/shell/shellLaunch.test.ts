import { decodeWindowId } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import { launchFromLocation } from "./shellLaunch";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000601");

describe("launchFromLocation", () => {
  it("derives the host URL from the browser origin when only a launch token fragment is present", () => {
    const launchToken = `${"A".repeat(42)}A`;
    const href = `http://127.0.0.1:13773/#launchToken=${launchToken}`;
    const launch = launchFromLocation(href);
    expect(launch).toEqual({ serverUrl: "http://127.0.0.1:13773/", windowId: undefined });
  });

  it("returns undefined when neither serverUrl nor a launch token fragment is present", () => {
    expect(launchFromLocation("http://127.0.0.1:13773/")).toBeUndefined();
  });

  it("prefers an explicit serverUrl query param over the origin", () => {
    const href = `http://127.0.0.1:13773/?serverUrl=${encodeURIComponent("http://localhost:9999")}&windowId=${windowId}`;
    const launch = launchFromLocation(href);
    expect(launch?.serverUrl).toBe("http://localhost:9999/");
    expect(launch?.windowId).toBe(windowId);
  });

  it("recognizes an explicit development web bootstrap launch without a token", () => {
    const href = `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent("http://127.0.0.1:13773")}&developmentWebBootstrap=1`;
    expect(launchFromLocation(href)).toEqual({
      serverUrl: "http://127.0.0.1:13773/",
      developmentWebBootstrap: true,
    });
  });
});
