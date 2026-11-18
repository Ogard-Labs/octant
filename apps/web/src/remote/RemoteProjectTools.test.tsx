import type { ProjectBrowserClient } from "@octant/client-runtime/project-browser-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { decodeProjectSummary } from "@octant/contracts/projects";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteProjectTools } from "./RemoteProjectTools";

const project = decodeProjectSummary({
  id: "80000000-0000-4000-8000-000000000001",
  type: "code",
  name: "Notes",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 3,
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
  binding: { canonicalRoot: "/repositories/notes" },
  bindingRevisionId: "80000000-0000-4000-8000-000000000002",
  codeAccessPersistence: "current-session",
});

function projectClient(): ProjectClient {
  return {
    bootstrap: async () => ({ active: [project], archived: [], availability: [], memory: [] }),
  } as unknown as ProjectClient;
}

afterEach(cleanup);

describe("a paired browser's Project tools", () => {
  it("starts the device's own shell in the chosen Project and shows the host's refusal", async () => {
    const execute = vi.fn<ProjectTerminalClient["execute"]>(async () => ({
      kind: "project-terminal-refused",
      reason: "unavailable",
      message: "Turn on Developer tools for this Project to open a terminal.",
    }));
    render(
      <RemoteProjectTools
        mode="code"
        projectBrowserClient={{} as ProjectBrowserClient}
        projectClient={projectClient()}
        projectTerminalClient={{ execute }}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Terminal" }));

    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      kind: "start",
      projectId: project.id,
    });
    expect(
      await screen.findByText("Turn on Developer tools for this Project to open a terminal."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browser" })).toBeInTheDocument();
  });

  it("offers nothing when the mode has no active Project", async () => {
    const { container } = render(
      <RemoteProjectTools
        mode="work"
        projectBrowserClient={{} as ProjectBrowserClient}
        projectClient={projectClient()}
        projectTerminalClient={{ execute: vi.fn() }}
      />,
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
