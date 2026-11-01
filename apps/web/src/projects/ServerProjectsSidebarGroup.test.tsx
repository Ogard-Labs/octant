import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectId } from "@octant/contracts/projects";
import { ServerProjectsSidebarGroup } from "./ServerProjectsSidebarGroup";

const serviceId = "77777777-7777-4777-8777-777777777777" as ProjectId;

describe("ServerProjectsSidebarGroup", () => {
  it("lists a Project on a server with where it is and its threads, and opens a new thread in it", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    const onSelectThread = vi.fn();
    render(
      <ServerProjectsSidebarGroup
        onOpenProject={onOpenProject}
        onSelectThread={onSelectThread}
        projects={[
          { projectId: serviceId, name: "Service", location: "devbox:/home/build/service" },
        ]}
        threads={[
          {
            threadId: "10000000-0000-4000-8000-000000000001",
            title: "Fix the login flow",
            projectId: String(serviceId),
          },
          {
            threadId: "10000000-0000-4000-8000-000000000002",
            title: "A local thread",
            projectId: "20000000-0000-4000-8000-000000000001",
          },
        ]}
      />,
    );

    const group = screen.getByRole("region", { name: "On your servers" });
    const project = within(group).getByRole("button", {
      name: "Service on devbox:/home/build/service. New task",
    });
    expect(project).toHaveTextContent("devbox:/home/build/service");
    expect(within(group).queryByText("A local thread")).toBeNull();

    await user.click(project);
    expect(onOpenProject).toHaveBeenCalledWith(serviceId);
    await user.click(within(group).getByText("Fix the login flow"));
    expect(onSelectThread).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001");
  });

  it("shows nothing when no Project is bound on a server", () => {
    const { container } = render(
      <ServerProjectsSidebarGroup
        onOpenProject={vi.fn()}
        onSelectThread={vi.fn()}
        projects={[]}
        threads={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
