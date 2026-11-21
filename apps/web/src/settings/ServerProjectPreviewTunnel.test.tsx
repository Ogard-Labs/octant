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

it("lists what the login serves from the Project's folder and previews one in a click", async () => {
  const user = userEvent.setup();
  const previewCommand = vi.fn(async () => ({
    kind: "tunnel" as const,
    view: {
      projectId: project.id,
      remotePort: 5432,
      localPort: 49152,
      endpoint: "http://127.0.0.1:49152",
      status: "listening" as const,
    },
  }));
  render(
    <ServerProjectPreviewTunnel
      project={project}
      client={{
        previewRead: async () => null,
        previewCommand,
        listeners: async () => ({
          status: "listed",
          listeners: [{ port: 5432, processName: "postgres" }],
        }),
      }}
    />,
  );
  await user.click(screen.getByText("Dev server preview"));
  await user.click(await screen.findByRole("button", { name: "Preview postgres on port 5432" }));
  expect(previewCommand).toHaveBeenCalledWith({
    kind: "start",
    projectId: project.id,
    remotePort: 5432,
    localPort: 0,
  });
  // Who can reach the forwarded port is said plainly.
  expect(screen.getByText(/guarded commands can't reach it/)).toBeInTheDocument();
});

it("opens a host-relayed preview through the signed forwarder callback and never renders an unsigned raw link", async () => {
  const grantId = `rsg_${"a".repeat(64)}`;
  const relayedView: Extract<ServerPreviewResult, { kind: "tunnel" }>["view"] = {
    projectId: String(project.id),
    localPort: 0,
    remotePort: 5173,
    endpoint: `/api/server-proxy/${grantId}/`,
    grantId: grantId as NonNullable<
      Extract<ServerPreviewResult, { kind: "tunnel" }>["view"]["grantId"]
    >,
    status: "listening",
  };
  const previewCommand = vi.fn(
    async (): Promise<ServerPreviewResult> => ({
      kind: "tunnel",
      view: relayedView,
    }),
  );
  const onOpenRelayedPreview = vi.fn(async () => ({ kind: "opened" as const }));
  const { rerender } = render(
    <ServerProjectPreviewTunnel
      project={project}
      client={{ previewRead: async () => null, previewCommand }}
      onOpenRelayedPreview={onOpenRelayedPreview}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByText("Dev server preview"));
  await user.click(screen.getByRole("button", { name: "Start preview" }));
  expect(screen.queryByRole("link", { name: "Open preview" })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Open preview" }));
  expect(onOpenRelayedPreview).toHaveBeenCalledWith(relayedView);

  // Without a desktop forwarder opener (plain browser tab), no broken unsigned link is rendered.
  rerender(
    <ServerProjectPreviewTunnel
      project={project}
      client={{ previewRead: async () => relayedView, previewCommand }}
    />,
  );
  expect(screen.queryByRole("link", { name: "Open preview" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open preview" })).not.toBeInTheDocument();
  expect(screen.getByText(/Octant's desktop app/i)).toBeInTheDocument();
});
