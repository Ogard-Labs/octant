import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ArtifactsModule from "./ArtifactsModule";

const projectId = "20000000-0000-4000-8000-000000000001";

const listing = {
  kind: "artifact-library-listing",
  entries: [
    {
      canvasId: "10000000-0000-4000-8000-00000000000a",
      projectId,
      projectName: "Storefront",
      mode: "work",
      kind: "chart",
      title: "Launch plan",
      versionCount: 3,
      currentVersionId: "30000000-0000-4000-8000-000000000001",
      currentSequence: 3,
      updatedAt: "2026-08-18T06:00:00.000Z",
      shared: false,
    },
  ],
  projects: [{ projectId, name: "Storefront", mode: "work", artifactCount: 1 }],
  matchCount: 1,
  truncated: false,
  generatedAt: "2026-08-18T09:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("asks the host for the thread's Project's artifacts and opens one beside the thread", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(listing),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ArtifactsModule
      serverUrl="http://127.0.0.1:4000"
      subject={{ mode: "work", threadId: "t", projectId: projectId as never }}
      windowCapability="cap"
    />,
  );

  const open = await screen.findByRole("button", { name: /Launch plan/ });
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ tab: "all", projectId });

  fireEvent.click(open);
  fireEvent.click(screen.getByRole("button", { name: "All artifacts" }));
  expect(await screen.findByRole("button", { name: /Launch plan/ })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("button", { name: /Launch plan/ });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("lists nothing for a thread outside every Project", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ArtifactsModule
      serverUrl="http://127.0.0.1:4000"
      subject={{ mode: "work", threadId: "t" }}
      windowCapability="cap"
    />,
  );
  expect(await screen.findByText("Artifacts are unavailable")).toBeVisible();
  expect(fetchMock).not.toHaveBeenCalled();
});
