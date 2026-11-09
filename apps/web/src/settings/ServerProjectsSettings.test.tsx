import type {
  ServerProject,
  ServerProjectsCommand,
  ServerProjectsCommandResult,
  ServerProjectsView,
} from "@octant/contracts/server-projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import {
  decodeAggregateVersion,
  decodeProjectId,
  decodeProjectActionId,
  decodeProjectTerminalResult,
  type ProjectId,
} from "@octant/contracts";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import { render, screen, within, waitFor } from "@testing-library/react";
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
const TEST_ACTION = {
  id: decodeProjectActionId("93000000-0000-4000-8000-000000000001"),
  name: "Test",
  command: "bun run test",
  directory: ".",
};

function setup(options: {
  readonly initial?: ServerProjectsView;
  readonly read?: () => ServerProjectsView;
  readonly servers?: ReadonlyArray<ShieldServer>;
  readonly answer?: (command: ServerProjectsCommand) => ServerProjectsCommandResult;
  readonly terminalClient?: ProjectTerminalClient;
  readonly codeProjectId?: ProjectId;
  readonly onOpenServerProject?: (project: ServerProject) => void;
}) {
  const initial = options.initial ?? { projects: [SITE] };
  const read = vi.fn(async () => options.read?.() ?? initial);
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
  render(
    <ServerProjectsSettings
      client={{ read, command }}
      servers={servers}
      {...(options.terminalClient === undefined ? {} : { terminalClient: options.terminalClient })}
      {...(options.codeProjectId === undefined ? {} : { codeProjectId: options.codeProjectId })}
      {...(options.onOpenServerProject === undefined
        ? {}
        : { onOpenServerProject: options.onOpenServerProject })}
    />,
  );
  return { command, user };
}

describe("ServerProjectsSettings", () => {
  it.each([undefined, decodeProjectId("11111111-1111-4111-8111-222222222222")])(
    "offers an explicit Project open before requesting actions outside the window binding",
    async (codeProjectId) => {
      const execute = vi.fn(async () => {
        throw Error("This window cannot read that Project's action files.");
      });
      const onOpenServerProject = vi.fn();
      const { user } = setup({
        initial: {
          projects: [
            {
              ...SITE,
              actions: [TEST_ACTION],
            },
          ],
        },
        terminalClient: { execute },
        ...(codeProjectId === undefined ? {} : { codeProjectId }),
        onOpenServerProject,
      });
      await screen.findByRole("button", { name: "Actions" });
      expect(screen.queryByRole("button", { name: "Run Test" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Actions" }));
      expect(screen.getByRole("textbox", { name: "Action command" })).toHaveValue("bun run test");
      expect(execute).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Open Website" }));
      expect(onOpenServerProject).toHaveBeenCalledWith(expect.objectContaining({ id: SITE.id }));
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("requests review without starting an action in the window's bound Project", async () => {
    const execute = vi.fn(async () =>
      decodeProjectTerminalResult({
        kind: "project-action-preview",
        projectId: SITE.id,
        projectVersion: 0,
        action: {
          actionId: TEST_ACTION.id,
          name: TEST_ACTION.name,
          folder: SITE.folder,
          branch: "main",
        },
      }),
    );
    const { user } = setup({
      initial: { projects: [{ ...SITE, actions: [TEST_ACTION] }] },
      codeProjectId: SITE.id,
      terminalClient: { execute },
    });
    await user.click(await screen.findByRole("button", { name: "Run Test" }));
    expect(await screen.findByRole("button", { name: "Run action" })).toBeEnabled();
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      kind: "preview-action",
      projectId: SITE.id,
      actionId: TEST_ACTION.id,
    });
  });
  it("shows a binding refusal after the Project whose action editor was open is removed", async () => {
    const { user } = setup({
      answer: (command) =>
        command.kind === "remove-server-project"
          ? { kind: "server-projects-updated", view: { projects: [] } }
          : {
              kind: "server-projects-refused",
              reason: "folder-not-found",
              message: "That folder is missing on the server.",
            },
    });
    await user.click(await screen.findByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Remove Website" }));
    expect(await screen.findByText("No folders on a server are bound.")).toBeVisible();
    const form = screen.getByRole("form", { name: "Bind a folder on a server" });
    await user.type(within(form).getByLabelText("Project name"), "Replacement");
    await user.type(within(form).getByLabelText("Folder on the server"), "/srv/missing");
    await user.click(within(form).getByRole("button", { name: "Bind folder" }));
    expect(await screen.findByText("That folder is missing on the server.")).toBeVisible();
  });
  it("retains a refused action draft until the person reloads the current saved list", async () => {
    let current: ServerProjectsView = { projects: [SITE] };
    const { user } = setup({
      read: () => current,
      answer: () => {
        current = {
          projects: [{ ...SITE, actionsVersion: decodeAggregateVersion(1), actions: [] }],
        };
        return {
          kind: "server-projects-refused",
          reason: "actions-changed",
          message: "Review the current actions.",
        };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Add action" }));
    await user.type(screen.getByRole("textbox", { name: "Action name" }), "Test");
    await user.type(screen.getByRole("textbox", { name: "Action command" }), "npm test");
    await user.click(screen.getByRole("button", { name: "Save actions" }));
    expect(await screen.findByText("Review the current actions.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Action command" })).toHaveValue("npm test");
    await user.click(screen.getByRole("button", { name: "Reload current actions" }));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Action command" })).toBeNull(),
    );
  });
  it("saves only explicitly accepted remote suggestions at the reviewed action version", async () => {
    const execute = vi.fn(async () => ({
      kind: "project-action-suggestions" as const,
      projectId: SITE.id,
      suggestions: [
        { name: "Test", command: "bun run test", directory: ".", source: "package.json" as const },
      ],
    }));
    const { user, command } = setup({ terminalClient: { execute }, codeProjectId: SITE.id });
    await user.click(await screen.findByRole("button", { name: "Actions" }));
    const suggestion = await screen.findByRole("button", { name: /bun run test/ });
    expect(command).not.toHaveBeenCalled();
    await user.click(suggestion);
    expect(command).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save actions" }));
    expect(command).toHaveBeenCalledWith({
      kind: "set-server-project-actions",
      projectId: SITE.id,
      expectedVersion: 0,
      actions: [{ id: expect.any(String), name: "Test", command: "bun run test", directory: "." }],
    });
    expect(execute).toHaveBeenCalledWith(
      { kind: "suggest-actions", projectId: SITE.id },
      expect.any(AbortSignal),
    );
  });
  it("lists each server Project with the server and folder it is on", async () => {
    setup({});

    const list = await screen.findByRole("list", { name: "Server Projects" });
    expect(within(list).getByText("Website")).toBeVisible();
    expect(within(list).getByText("Code · web-1:/srv/website")).toBeVisible();
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

  it("binds a Work Project on a server when Work is the kind chosen", async () => {
    const { command, user } = setup({ initial: { projects: [] } });
    const form = await screen.findByRole("form", { name: "Bind a folder on a server" });

    await user.click(within(form).getByRole("combobox", { name: "Project kind" }));
    await user.click(await screen.findByRole("option", { name: "Work" }));
    await user.type(within(form).getByLabelText("Project name"), "Notes");
    await user.type(within(form).getByLabelText("Folder on the server"), "/srv/notes");
    await user.click(within(form).getByRole("button", { name: "Bind folder" }));

    expect(command).toHaveBeenCalledWith({
      kind: "bind-server-project",
      name: "Notes",
      serverId: WEB.serverId,
      folder: "/srv/notes",
      mode: "work",
    });
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
