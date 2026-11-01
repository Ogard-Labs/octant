import type {
  ShieldServer,
  ShieldServersCommand,
  ShieldServersCommandResult,
  ShieldServersView,
} from "@octant/contracts/shield-servers";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import {
  SHIELD_SERVERS_ALWAYS_ASK_NOTE,
  SHIELD_SSH_AGENT_MISSING_NOTE,
  ShieldServersSettings,
} from "./ShieldServersSettings";

const WEB: ShieldServer = {
  serverId: "5e7e0000-0000-4000-8000-000000000001" as ShieldServer["serverId"],
  alias: "web-1",
  user: "deploy",
  profile: "operate",
  deployCommands: ["./deploy.sh"],
  runbookPath: "/Users/me/notes/web-1.md",
};

function view(overrides: Partial<ShieldServersView> = {}): ShieldServersView {
  return { servers: [WEB], sshAgent: "available", ...overrides } as ShieldServersView;
}

function setup(options: {
  readonly initial?: ShieldServersView;
  readonly answer?: (command: ShieldServersCommand) => ShieldServersCommandResult;
}) {
  const initial = options.initial ?? view();
  const read = vi.fn(async () => initial);
  const command = vi.fn(
    async (sent: ShieldServersCommand): Promise<ShieldServersCommandResult> =>
      options.answer?.(sent) ?? { kind: "shield-servers-updated", view: initial },
  );
  const user = userEvent.setup();
  render(<ShieldServersSettings client={{ read, command }} />);
  return { read, command, user };
}

describe("ShieldServersSettings", () => {
  it("lists each registered server with its login, profile, runbook and deploy count", async () => {
    setup({});

    const list = await screen.findByRole("list", { name: "Registered servers" });
    expect(within(list).getByText("deploy@web-1")).toBeVisible();
    expect(within(list).getByText("Operate")).toBeVisible();
    expect(within(list).getByText("/Users/me/notes/web-1.md")).toBeVisible();
    expect(within(list).getByText("1 deploy command")).toBeVisible();
    expect(screen.getByText(SHIELD_SERVERS_ALWAYS_ASK_NOTE)).toBeVisible();
    expect(screen.queryByText(SHIELD_SSH_AGENT_MISSING_NOTE)).toBeNull();
  });

  it("says when no SSH agent is running", async () => {
    setup({ initial: view({ servers: [], sshAgent: "missing" }) });

    expect(await screen.findByText(SHIELD_SSH_AGENT_MISSING_NOTE)).toBeVisible();
    expect(screen.getByText("No servers registered.")).toBeVisible();
  });

  it("registers a server with the typed fields, one deploy command per non-empty line", async () => {
    const { command, user } = setup({ initial: view({ servers: [] }) });
    const form = await screen.findByRole("form", { name: "Add a server" });

    await user.type(within(form).getByLabelText("Host alias"), "db-1");
    await user.type(within(form).getByLabelText("Login user"), "ops");
    await chooseSelectFieldOption(user, within(form).getByRole("combobox"), "Operate");
    await user.type(
      within(form).getByLabelText("Deploy commands (one per line)"),
      "systemctl restart app{Enter}{Enter}  ./deploy.sh  ",
    );
    await user.type(within(form).getByLabelText("Runbook notes file (optional)"), "/notes/db-1.md");
    await user.click(within(form).getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith({
      kind: "register-server",
      server: {
        alias: "db-1",
        user: "ops",
        profile: "operate",
        deployCommands: ["systemctl restart app", "./deploy.sh"],
        runbookPath: "/notes/db-1.md",
      },
    });
  });

  it("hides deploy commands for a read-only server", async () => {
    const { user } = setup({ initial: view({ servers: [] }) });
    const form = await screen.findByRole("form", { name: "Add a server" });

    expect(within(form).queryByLabelText("Deploy commands (one per line)")).toBeNull();
    await chooseSelectFieldOption(user, within(form).getByRole("combobox"), "Admin");
    expect(within(form).getByLabelText("Deploy commands (one per line)")).toBeVisible();
  });

  it("shows the host's refusal beside the form", async () => {
    const { user } = setup({
      initial: view({ servers: [] }),
      answer: () => ({
        kind: "shield-servers-refused",
        reason: "duplicate-alias",
        message: "A server named web-1 is already registered.",
      }),
    });
    const form = await screen.findByRole("form", { name: "Add a server" });

    await user.type(within(form).getByLabelText("Host alias"), "web-1");
    await user.type(within(form).getByLabelText("Login user"), "deploy");
    await user.click(within(form).getByRole("button", { name: "Add server" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A server named web-1 is already registered.",
    );
  });

  it("changes a server through the same form", async () => {
    const { command, user } = setup({});

    await user.click(await screen.findByRole("button", { name: "Change web-1" }));
    const form = screen.getByRole("form", { name: "Change web-1" });
    const profile = within(form).getByRole("combobox");
    await chooseSelectFieldOption(user, profile, "Admin");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith({
      kind: "change-server",
      serverId: WEB.serverId,
      server: {
        alias: "web-1",
        user: "deploy",
        profile: "admin",
        deployCommands: ["./deploy.sh"],
        runbookPath: "/Users/me/notes/web-1.md",
      },
    });
  });

  it("removes a server", async () => {
    const { command, user } = setup({
      answer: () => ({ kind: "shield-servers-updated", view: view({ servers: [] }) }),
    });

    await user.click(await screen.findByRole("button", { name: "Remove web-1" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith({ kind: "remove-server", serverId: WEB.serverId });
    expect(await screen.findByText("No servers registered.")).toBeVisible();
  });

  it("says servers are managed on the host computer when there is no client", () => {
    render(<ShieldServersSettings client={undefined} />);

    expect(screen.getByText(/managed on the host computer/)).toBeVisible();
  });
});
