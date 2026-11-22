import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ServerProject, ServerPortForwardResult } from "@octant/contracts/server-projects";
import { remoteForwardNote } from "../home/runningServices";
import { ServerProjectPortForward } from "./ServerProjectPortForward";

const project: ServerProject = {
  id: "11111111-1111-4111-8111-111111111111" as ServerProject["id"],
  serverId: "22222222-2222-4222-8222-222222222222" as ServerProject["serverId"],
  name: "Site",
  folder: "/srv/site",
  boundAt: "2026-11-04T00:00:00.000Z" as ServerProject["boundAt"],
};

it("offers Forward a port for a server Project and states that anything on this computer can reach it", async () => {
  const forwardCommand = vi.fn(
    async (): Promise<ServerPortForwardResult> => ({
      kind: "forward",
      view: {
        projectId: String(project.id),
        remotePort: 5432,
        localPort: 5432,
        status: "listening",
      },
    }),
  );
  render(
    <ServerProjectPortForward
      project={project}
      client={{ forwardRead: async () => null, forwardCommand }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText("Forward a port"));
  await user.type(screen.getByLabelText("Port on the server"), "5432");
  await user.click(screen.getByRole("button", { name: "Forward port" }));
  expect(forwardCommand).toHaveBeenCalledWith({
    kind: "start",
    projectId: project.id,
    remotePort: 5432,
  });
  // The same sentence a forward from another Octant computer shows.
  expect(await screen.findByRole("button", { name: "Stop forward" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(remoteForwardNote(5432));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Anything running on this computer can connect to it.",
  );
  await user.click(screen.getByRole("button", { name: "Stop forward" }));
  expect(forwardCommand).toHaveBeenLastCalledWith({ kind: "stop", projectId: project.id });
});

it("offers no forward where the client has none, as off this computer", () => {
  const { container } = render(<ServerProjectPortForward project={project} client={{}} />);
  expect(container).toBeEmptyDOMElement();
});
