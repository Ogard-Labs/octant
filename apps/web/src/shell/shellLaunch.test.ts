import { decodeWindowId } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import { launchFromLocation } from "./shellLaunch";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000601");
const launchToken = `${"A".repeat(42)}A`;

describe("launchFromLocation", () => {
  it("derives the host URL from the browser origin when only a launch token fragment is present", () => {
    const href = `http://127.0.0.1:13773/#launchToken=${launchToken}`;
    expect(launchFromLocation(href)).toEqual({
      status: "accepted",
      launch: { serverUrl: "http://127.0.0.1:13773/", windowId: undefined },
    });
  });

  it("opens the canonical Machine directly from its stable loopback URL", () => {
    expect(launchFromLocation("http://127.0.0.1:13773/")).toEqual({
      status: "accepted",
      launch: { serverUrl: "http://127.0.0.1:13773/" },
    });
    expect(launchFromLocation("http://[::1]:13773/")).toEqual({
      status: "accepted",
      launch: { serverUrl: "http://[::1]:13773/" },
    });
  });

  it("prefers an explicit serverUrl query param over the origin", () => {
    const href = `http://127.0.0.1:13773/?serverUrl=${encodeURIComponent("http://localhost:9999")}&windowId=${windowId}`;
    const launch = launchFromLocation(href);
    expect(launch).toEqual({
      status: "accepted",
      launch: { serverUrl: "http://localhost:9999/", windowId },
    });
  });

  it("points a Vite renderer at the canonical Machine without changing its identity", () => {
    const href = `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent("http://127.0.0.1:13773")}`;
    expect(launchFromLocation(href)).toEqual({
      status: "accepted",
      launch: { serverUrl: "http://127.0.0.1:13773/" },
    });
  });

  it("accepts an https Machine address wherever it points", () => {
    const href = `https://host.tailnet:8443/#launchToken=${launchToken}`;
    expect(launchFromLocation(href)).toEqual({
      status: "accepted",
      launch: { serverUrl: "https://host.tailnet:8443/", windowId: undefined },
    });
  });

  it("refuses a serverUrl that is plain HTTP to a host off loopback, and says which host", () => {
    const href = `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent("http://192.168.1.5:13773")}`;
    expect(launchFromLocation(href)).toMatchObject({
      status: "refused",
      reason: "plain-http-off-loopback",
      host: "192.168.1.5:13773",
      message: expect.stringContaining("over plain HTTP to 192.168.1.5:13773"),
    });
  });

  it("refuses its own origin when a launch token arrives over plain HTTP off loopback", () => {
    const href = `http://octant-host.lan:13773/#launchToken=${launchToken}`;
    expect(launchFromLocation(href)).toMatchObject({
      status: "refused",
      reason: "plain-http-off-loopback",
      host: "octant-host.lan:13773",
    });
  });

  it("refuses before it reads anything else about the launch", () => {
    const href = `http://127.0.0.1:5173/?serverUrl=${encodeURIComponent("http://10.0.0.2")}&windowId=not-a-window`;
    expect(launchFromLocation(href).status).toBe("refused");
  });

  it("reports a page nothing launched as absent rather than refused", () => {
    expect(launchFromLocation("https://example.test/")).toEqual({ status: "absent" });
    expect(launchFromLocation("http://192.168.1.5:13773/")).toEqual({ status: "absent" });
    expect(launchFromLocation("file:///Applications/Octant.app/index.html")).toEqual({
      status: "absent",
    });
  });
});
