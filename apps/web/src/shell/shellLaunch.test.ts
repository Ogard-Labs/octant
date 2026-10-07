import { decodeWindowId } from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import { launchFromLocation, type LaunchMemory } from "./shellLaunch";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000601");
const launchToken = `${"A".repeat(42)}A`;

function tabMemory(): LaunchMemory {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  };
}

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

  describe("in a development tab whose renderer is not the host", () => {
    const launched = `http://localhost:5299/?serverUrl=${encodeURIComponent("http://127.0.0.1:14299/")}&developmentWebBootstrap=1`;

    it("keeps its host after a reload or in-tab navigation drops the query", () => {
      const memory = tabMemory();
      launchFromLocation(launched, memory);

      // Without this the bare Vite origin was taken for the host itself, which
      // answers none of the Machine routes: the window showed "Project
      // authority is unavailable" until someone reopened the launch URL.
      expect(launchFromLocation("http://localhost:5299/", memory)).toEqual({
        status: "accepted",
        launch: { serverUrl: "http://127.0.0.1:14299/" },
      });
      expect(launchFromLocation("http://localhost:5299/#settings", memory)).toMatchObject({
        status: "accepted",
        launch: { serverUrl: "http://127.0.0.1:14299/" },
      });
    });

    it("follows a newly named host rather than the remembered one", () => {
      const memory = tabMemory();
      launchFromLocation(launched, memory);
      launchFromLocation(
        `http://localhost:5299/?serverUrl=${encodeURIComponent("http://127.0.0.1:14300/")}`,
        memory,
      );

      expect(launchFromLocation("http://localhost:5299/", memory)).toEqual({
        status: "accepted",
        launch: { serverUrl: "http://127.0.0.1:14300/" },
      });
    });

    it("does not carry a host from one renderer origin to another", () => {
      const memory = tabMemory();
      launchFromLocation(launched, memory);

      expect(launchFromLocation("http://localhost:5300/", memory)).toEqual({
        status: "accepted",
        launch: { serverUrl: "http://localhost:5300/" },
      });
    });

    it("judges a remembered address again instead of trusting it", () => {
      const memory = tabMemory();
      memory.setItem("octant:launch-server:http://localhost:5299", "http://192.168.1.5:13773/");

      expect(launchFromLocation("http://localhost:5299/", memory)).toMatchObject({
        status: "refused",
        reason: "plain-http-off-loopback",
      });
    });

    it("still reads a bare loopback origin as the host when nothing was remembered", () => {
      expect(launchFromLocation("http://localhost:5299/", tabMemory())).toEqual({
        status: "accepted",
        launch: { serverUrl: "http://localhost:5299/" },
      });
    });
  });
});
