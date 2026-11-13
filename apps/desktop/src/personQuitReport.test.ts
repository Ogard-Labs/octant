import { describe, expect, it, vi } from "vitest";
import {
  PERSON_QUIT_ROUTE,
  reportPersonQuit,
  watchSystemShutdown,
  type PersonQuitReportInput,
} from "./personQuitReport";

const ownedHost: PersonQuitReportInput["host"] = {
  state: "running",
  ownership: "desktop-owned",
  url: "http://127.0.0.1:4567",
};
const brokerHeaders = { "x-octant-desktop-secret": "bridge-secret" };

function report(
  input: Partial<PersonQuitReportInput>,
  fetch = vi.fn<typeof globalThis.fetch>(async () => new Response()),
) {
  return {
    fetch,
    outcome: reportPersonQuit({
      interactive: true,
      systemShuttingDown: false,
      host: ownedHost,
      ...input,
      brokerHeaders,
      fetch,
    }),
  };
}

describe("reporting a person's quit to the host", () => {
  it("tells the host this app stops that a person quit it, with the bridge secret", async () => {
    const { fetch, outcome } = report({});
    expect(await outcome).toBe("recorded");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      new URL(PERSON_QUIT_ROUTE, ownedHost.url),
      expect.objectContaining({ method: "POST", headers: brokerHeaders }),
    );
  });

  it("reports nothing when the system is restarting or shutting down", async () => {
    const { fetch, outcome } = report({ systemShuttingDown: true });
    expect(await outcome).toBe("not-a-person-quit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports nothing for a quit the person did not start, such as a signal or a system quit", async () => {
    const { fetch, outcome } = report({ interactive: false });
    expect(await outcome).toBe("not-a-person-quit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports nothing when the background service keeps the host running", async () => {
    const { fetch, outcome } = report({ host: { ...ownedHost, ownership: "managed" } });
    expect(await outcome).toBe("not-a-person-quit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets the quit go on when the host does not answer in time", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const outcome = reportPersonQuit({
      interactive: true,
      systemShuttingDown: false,
      host: ownedHost,
      brokerHeaders,
      fetch,
      boundMs: 5,
    });
    expect(await outcome).toBe("failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("watching for a system restart or shutdown", () => {
  it("latches on the power monitor's shutdown, and on a window's session end", () => {
    const power: Array<() => void> = [];
    const shuttingDown = watchSystemShutdown({
      powerMonitor: { on: (_event, listener) => power.push(listener) },
      onSessionEnd: () => undefined,
    });
    expect(shuttingDown()).toBe(false);
    power[0]?.();
    expect(shuttingDown()).toBe(true);

    const sessionEnds: Array<() => void> = [];
    const sessionEnding = watchSystemShutdown({
      powerMonitor: { on: () => undefined },
      onSessionEnd: (listener) => sessionEnds.push(listener),
    });
    expect(sessionEnding()).toBe(false);
    sessionEnds[0]?.();
    expect(sessionEnding()).toBe(true);
  });
});
