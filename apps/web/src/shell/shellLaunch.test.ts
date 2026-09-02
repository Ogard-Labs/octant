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

  it("opens the canonical Machine directly from its stable loopback URL", () => {
    expect(launchFromLocation("http://127.0.0.1:13773/")).toEqual({
      serverUrl: "http://127.0.0.1:13773/",
    });
  });

  it("prefers an explicit serverUrl query param over the origin", () => {
    const href = `http://127.0.0.1:13773/?serverUrl=${encodeURIComponent("http://localhost:9999")}&windowId=${windowId}`;
    const launch = launchFromLocation(href);
    expect(launch?.serverUrl).toBe("http://localhost:9999/");
    expect(launch?.windowId).toBe(windowId);
  });

  it("points a Vite renderer at the canonical Machine without changing its identity", () => {
    const href = `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent("http://127.0.0.1:13773")}`;
    expect(launchFromLocation(href)).toEqual({
      serverUrl: "http://127.0.0.1:13773/",
    });
  });
});
