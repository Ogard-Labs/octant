import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import VitalsModule from "./VitalsModule";
import { ServerCodeProjectsContext } from "../projects/serverProjectEntries";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  cores: 8,
  cpuPercent: 54,
  memory: { usedBytes: 12_100_000_000, totalBytes: 16_000_000_000 },
  sampledAt: new Date().toISOString(),
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows this host's load and draws no Energy row when it has no battery", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    Response.json(snapshot({ gpu: { percent: 42 } })),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { container } = render(
    <VitalsModule serverUrl="http://127.0.0.1:4000" subject={{ mode: "code", threadId: "t" }} />,
  );
  await waitFor(() => expect(screen.getByText("CPU · 8 cores")).toBeVisible());
  expect(screen.getByText("54%")).toBeVisible();
  // One sample is a figure, not a line: no empty chart box under it.
  expect(container.querySelector(".vitals__chart")).toBeNull();
  expect(screen.getByText("GPU")).toBeVisible();
  expect(screen.queryByText("Energy")).toBeNull();
  expect(screen.queryByText("No battery")).toBeNull();
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    "http://127.0.0.1:4000/api/host/resources?detail=vitals",
  );
});

it("shows the battery level and charging state when the host has a battery", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(snapshot({ energy: { batteryPercent: 81, charging: true } }))),
  );
  render(
    <VitalsModule serverUrl="http://127.0.0.1:4000" subject={{ mode: "code", threadId: "t" }} />,
  );
  await waitFor(() => expect(screen.getByText("Energy")).toBeVisible());
  expect(screen.getByText("81% · charging")).toBeVisible();
});

it("reads a thread's server over its Project's route and tells a refused window plainly", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("{}", { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ServerCodeProjectsContext.Provider
      value={{
        catalog: "ready",
        projects: [{ projectId: "p1" as never, name: "Box", location: "box:/srv" }],
        workProjects: [],
        refresh: () => undefined,
      }}
    >
      <VitalsModule
        serverUrl="http://127.0.0.1:4000"
        subject={{ mode: "code", threadId: "t", projectId: "p1" as never }}
      />
    </ServerCodeProjectsContext.Provider>,
  );
  await waitFor(() =>
    expect(screen.getByText("This window may not read this host's load.")).toBeVisible(),
  );
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    "http://127.0.0.1:4000/api/server-projects/resources?projectId=p1",
  );
});

it("says a server that is not Linux does not report load and stops asking", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("{}", { status: 501 }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ServerCodeProjectsContext.Provider
      value={{
        catalog: "ready",
        projects: [{ projectId: "p1" as never, name: "Box", location: "box:/srv" }],
        workProjects: [],
        refresh: () => undefined,
      }}
    >
      <VitalsModule
        serverUrl="http://127.0.0.1:4000"
        subject={{ mode: "code", threadId: "t", projectId: "p1" as never }}
      />
    </ServerCodeProjectsContext.Provider>,
  );
  await waitFor(() =>
    expect(
      screen.getByText("This server does not report load. Vitals needs a Linux server."),
    ).toBeVisible(),
  );
});

it("reads no host while the server Project catalog has not answered, instead of showing this computer's load", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json(snapshot()));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ServerCodeProjectsContext.Provider
      value={{ catalog: "failed", projects: [], workProjects: [], refresh: () => undefined }}
    >
      <VitalsModule
        serverUrl="http://127.0.0.1:4000"
        subject={{ mode: "code", threadId: "t", projectId: "p1" as never }}
      />
    </ServerCodeProjectsContext.Provider>,
  );
  expect(
    await screen.findByText("Could not read server Projects, so this thread's host is unknown."),
  ).toBeVisible();
  expect(fetchMock).not.toHaveBeenCalled();
});
