import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectId } from "@octant/contracts/projects";
import { RemoteProjectsSidebarGroup } from "./RemoteProjectsSidebarGroup";

const serviceId = "77777777-7777-4777-8777-777777777777" as ProjectId;

describe("RemoteProjectsSidebarGroup", () => {
  it("lists a Project on an SSH target with where it is, its connection, and its threads", async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    const onSelectThread = vi.fn();
    render(
      <RemoteProjectsSidebarGroup
        onOpenProject={onOpenProject}
        onSelectThread={onSelectThread}
        projects={[
          {
            projectId: serviceId,
            name: "Service",
            location: "build@devbox:/home/build/service",
            destination: "build@devbox",
            target: { connection: "not-connected" } as never,
          },
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

    const group = screen.getByRole("region", { name: "On SSH targets" });
    const project = within(group).getByRole("button", {
      name: "Service on build@devbox:/home/build/service, Not connected. New task",
    });
    expect(project).toHaveTextContent("build@devbox:/home/build/service");
    expect(within(group).queryByText("A local thread")).toBeNull();

    await user.click(project);
    expect(onOpenProject).toHaveBeenCalledWith(serviceId);
    await user.click(within(group).getByText("Fix the login flow"));
    expect(onSelectThread).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000001");
  });

  it("shows nothing when this window has no Project on an SSH target", () => {
    const { container } = render(
      <RemoteProjectsSidebarGroup
        onOpenProject={vi.fn()}
        onSelectThread={vi.fn()}
        projects={[]}
        threads={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
