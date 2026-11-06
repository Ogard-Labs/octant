import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ServerProject, ServerPreviewResult } from "@octant/contracts/server-projects";
import { ServerProjectPreviewTunnel } from "./ServerProjectPreviewTunnel";
const project: ServerProject = {
  id: "11111111-1111-4111-8111-111111111111" as ServerProject["id"],
  serverId: "22222222-2222-4222-8222-222222222222" as ServerProject["serverId"],
  name: "Site",
  folder: "/srv/site",
  boundAt: "2026-11-04T00:00:00.000Z" as ServerProject["boundAt"],
};
it("shows the exact endpoint and offers deliberate reconnect after a lost connection", async () => {
  const previewCommand = vi.fn(
    async (): Promise<ServerPreviewResult> => ({
      kind: "tunnel",
      view: {
        projectId: String(project.id),
        localPort: 41111,
        remotePort: 5173,
        endpoint: "http://127.0.0.1:41111",
        status: "lost",
      },
    }),
  );
  render(
    <ServerProjectPreviewTunnel
      project={project}
      client={{ previewRead: async () => null, previewCommand }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText("Dev server preview"));
  await user.click(screen.getByRole("button", { name: "Start preview" }));
  expect(previewCommand).toHaveBeenCalledWith({
    kind: "start",
    projectId: project.id,
    remotePort: 5173,
    localPort: 0,
  });
  expect(await screen.findByText(/http:\/\/127.0.0.1:41111/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Reconnect same endpoint" }));
  expect(previewCommand).toHaveBeenLastCalledWith({ kind: "reconnect", projectId: project.id });
  expect(screen.queryByRole("link", { name: "Open preview" })).not.toBeInTheDocument();
});
