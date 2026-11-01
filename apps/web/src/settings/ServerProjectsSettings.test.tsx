import type {
  ServerProject,
  ServerProjectsCommand,
  ServerProjectsCommandResult,
  ServerProjectsView,
} from "@octant/contracts/server-projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ServerAccessSettings, ServerProjectsSettings } from "./ServerProjectsSettings";

const WEB: ShieldServer = {
  serverId: "5e7e0000-0000-4000-8000-000000000001" as ShieldServer["serverId"],
  alias: "web-1",
  user: "deploy",
  profile: "operate",
  deployCommands: [],
};

const SITE: ServerProject = {
  id: "11111111-1111-4111-8111-111111111111" as ServerProject["id"],
  name: "Website",
  serverId: WEB.serverId,
  folder: "/srv/website",
  boundAt: "2026-11-01T12:00:00.000Z" as ServerProject["boundAt"],
};

function setup(options: {
  readonly initial?: ServerProjectsView;
  readonly servers?: ReadonlyArray<ShieldServer>;
  readonly answer?: (command: ServerProjectsCommand) => ServerProjectsCommandResult;
}) {
  const initial = options.initial ?? { projects: [SITE] };
  const read = vi.fn(async () => initial);
  const command = vi.fn(
    async (sent: ServerProjectsCommand): Promise<ServerProjectsCommandResult> =>
      options.answer?.(sent) ?? { kind: "server-projects-updated", view: initial },
  );
  const servers = {
    read: vi.fn(async () => ({
      servers: options.servers ?? [WEB],
      sshAgent: "available" as const,
    })),
  };
  const user = userEvent.setup();
  render(<ServerProjectsSettings client={{ read, command }} servers={servers} />);
  return { command, user };
}

describe("ServerProjectsSettings", () => {
  it("lists each server Project with the server and folder it is on", async () => {
    setup({});

    const list = await screen.findByRole("list", { name: "Server Projects" });
    expect(within(list).getByText("Website")).toBeVisible();
    expect(within(list).getByText("web-1:/srv/website")).toBeVisible();
  });

  it("binds a folder on the chosen server and shows the host's refusal as it arrived", async () => {
    const { command, user } = setup({
      initial: { projects: [] },
      answer: () => ({
        kind: "server-projects-refused",
        reason: "folder-not-found",
        message: "That folder does not exist on the server, or is not a folder.",
      }),
    });
    const form = await screen.findByRole("form", { name: "Bind a folder on a server" });

    await user.type(within(form).getByLabelText("Project name"), "Website");
    await user.type(within(form).getByLabelText("Folder on the server"), "/srv/missing");
    await user.click(within(form).getByRole("button", { name: "Bind folder" }));

    expect(command).toHaveBeenCalledWith({
      kind: "bind-server-project",
      name: "Website",
      serverId: WEB.serverId,
      folder: "/srv/missing",
    });
    expect(
      await screen.findByText("That folder does not exist on the server, or is not a folder."),
    ).toBeVisible();
  });

  it("removes a server Project", async () => {
    const { command, user } = setup({
      answer: () => ({ kind: "server-projects-updated", view: { projects: [] } }),
    });

    await user.click(await screen.findByRole("button", { name: "Remove Website" }));

    expect(command).toHaveBeenCalledWith({ kind: "remove-server-project", projectId: SITE.id });
    expect(await screen.findByText("No folders on a server are bound.")).toBeVisible();
  });

  it("asks for a registered server before a folder can be bound", async () => {
    setup({ initial: { projects: [] }, servers: [] });

    expect(await screen.findByText("Register a server above first.")).toBeVisible();
    expect(screen.queryByRole("form", { name: "Bind a folder on a server" })).toBeNull();
  });

  it("offers a server registered above for binding without reopening Settings", async () => {
    let registry: ReadonlyArray<ShieldServer> = [];
    const servers = {
      read: vi.fn(async () => ({ servers: registry, sshAgent: "available" as const })),
      command: vi.fn(async () => {
        registry = [WEB];
        return {
          kind: "shield-servers-updated" as const,
          view: { servers: registry, sshAgent: "available" as const },
        };
      }),
    };
    const projects = {
      read: vi.fn(async () => ({ projects: [] })),
      command: vi.fn(),
    };
    const user = userEvent.setup();
    render(
      <ServerAccessSettings
        projectNames={new Map()}
        projects={projects as never}
        servers={servers as never}
      />,
    );
    expect(await screen.findByText("Register a server above first.")).toBeVisible();

    const add = await screen.findByRole("form", { name: "Add a server" });
    await user.type(within(add).getByLabelText("Host alias"), "web-1");
    await user.type(within(add).getByLabelText("Login user"), "deploy");
    await user.click(within(add).getByRole("button", { name: "Add server" }));

    expect(await screen.findByRole("form", { name: "Bind a folder on a server" })).toBeVisible();
  });
});
