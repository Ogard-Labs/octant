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

it("shows this host's load and says so when it has no battery", async () => {
  const fetchMock = vi.fn(async () => Response.json(snapshot({ gpu: { percent: 42 } })));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <VitalsModule serverUrl="http://127.0.0.1:4000" subject={{ mode: "code", threadId: "t" }} />,
  );
  await waitFor(() => expect(screen.getByText("CPU · 8 cores")).toBeVisible());
  expect(screen.getByText("54%")).toBeVisible();
  expect(screen.getByText("GPU")).toBeVisible();
  expect(screen.getByText("No battery")).toBeVisible();
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4000/api/host/resources");
});

it("reads a thread's server over its Project's route and tells a refused window plainly", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ServerCodeProjectsContext.Provider
      value={{
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
