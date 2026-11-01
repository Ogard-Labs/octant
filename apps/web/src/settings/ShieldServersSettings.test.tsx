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
  SHIELD_PROJECT_SERVERS_NOTE,
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

const PROJECT_ID = "7f1c2d3e-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "7f1c2d3e-0000-4000-8000-000000000002";
const PROJECTS = new Map([
  [PROJECT_ID, "Atlas"],
  [OTHER_PROJECT_ID, "Beacon"],
]);

const DB: ShieldServer = {
  serverId: "5e7e0000-0000-4000-8000-000000000002" as ShieldServer["serverId"],
  alias: "db-1",
  user: "ops",
  profile: "read-only",
  deployCommands: [],
};

const WEB_FIELDS = {
  alias: "web-1",
  user: "deploy",
  profile: "operate",
  deployCommands: ["./deploy.sh"],
  runbookPath: "/Users/me/notes/web-1.md",
} as const;

function projectView(projectId: string, override: ShieldServersView["servers"] | null) {
  return view({ project: { projectId, override } } as Partial<ShieldServersView>);
}

async function chooseProject(user: ReturnType<typeof userEvent.setup>, name: string) {
  await chooseSelectFieldOption(
    user,
    await screen.findByRole("combobox", { name: "Project" }),
    name,
  );
}

function setup(options: {
  readonly initial?: ShieldServersView;
  readonly projectViews?: Readonly<Record<string, ShieldServersView>>;
  readonly answer?: (command: ShieldServersCommand) => ShieldServersCommandResult;
}) {
  const initial = options.initial ?? view();
  const read = vi.fn(async (projectId?: string) =>
    projectId === undefined ? initial : (options.projectViews?.[projectId] ?? initial),
  );
  const command = vi.fn(
    async (sent: ShieldServersCommand): Promise<ShieldServersCommandResult> =>
      options.answer?.(sent) ?? { kind: "shield-servers-updated", view: initial },
  );
  const user = userEvent.setup();
  render(<ShieldServersSettings client={{ read, command }} projectNames={PROJECTS} />);
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
    await chooseSelectFieldOption(user, within(form).getByRole("combobox", { name: "Profile" }), "Operate");
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

  it("registers a server that signs in with a key Octant keeps", async () => {
    const { command, user } = setup({ initial: view({ servers: [] }) });
    const form = await screen.findByRole("form", { name: "Add a server" });

    await user.type(within(form).getByLabelText("Host alias"), "db-1");
    await user.type(within(form).getByLabelText("Login user"), "ops");
    await chooseSelectFieldOption(
      user,
      within(form).getByRole("combobox", { name: "Sign in with" }),
      "A key Octant keeps",
    );
    await user.click(within(form).getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith({
      kind: "register-server",
      server: {
        alias: "db-1",
        user: "ops",
        profile: "read-only",
        deployCommands: [],
        signIn: "octant-key",
      },
    });
  });

  it("shows the public line of a server's Octant key, to add on the server", async () => {
    const keyed = { ...DB, signIn: "octant-key" } as ShieldServer;
    const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample";
    const { command, user } = setup({
      initial: view({ servers: [WEB, keyed] }),
      answer: (sent) =>
        sent.kind === "show-server-key"
          ? { kind: "shield-server-key", serverId: keyed.serverId, publicKey }
          : { kind: "shield-servers-updated", view: view() },
    });

    const list = await screen.findByRole("list", { name: "Registered servers" });
    // A server that signs in with the person's agent has no key to show.
    expect(within(list).queryByRole("button", { name: "Show the key for web-1" })).toBeNull();
    await user.click(within(list).getByRole("button", { name: "Show the key for db-1" }));

    expect(await within(list).findByText(publicKey)).toBeVisible();
    expect(within(list).getByText(/for ops on db-1/)).toBeVisible();
    expect(command).toHaveBeenCalledWith({ kind: "show-server-key", serverId: keyed.serverId });
  });

  it("shows the host's refusal when the key cannot be shown", async () => {
    const keyed = { ...DB, signIn: "octant-key" } as ShieldServer;
    const { user } = setup({
      initial: view({ servers: [keyed] }),
      answer: () => ({
        kind: "shield-servers-refused",
        reason: "key-unavailable",
        message: "Octant could not reach its key store, so no key was made.",
      }),
    });

    await user.click(await screen.findByRole("button", { name: "Show the key for db-1" }));

    expect(
      await screen.findByText("Octant could not reach its key store, so no key was made."),
    ).toBeVisible();
  });

  it("hides deploy commands for a read-only server", async () => {
    const { user } = setup({ initial: view({ servers: [] }) });
    const form = await screen.findByRole("form", { name: "Add a server" });

    expect(within(form).queryByLabelText("Deploy commands (one per line)")).toBeNull();
    await chooseSelectFieldOption(user, within(form).getByRole("combobox", { name: "Profile" }), "Admin");
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
    const profile = within(form).getByRole("combobox", { name: "Profile" });
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

  it("shows a Project's own list in place of the account list", async () => {
    setup({
      projectViews: { [PROJECT_ID]: projectView(PROJECT_ID, [DB]) },
    });

    await chooseProject(userEvent.setup(), "Atlas");

    const own = await screen.findByRole("list", { name: "Atlas servers" });
    expect(within(own).getByText("ops@db-1")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Use servers for this Project only" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(SHIELD_PROJECT_SERVERS_NOTE)).toBeVisible();
  });

  it("starts a Project's own list as a copy of the account list", async () => {
    const { command, user } = setup({
      projectViews: { [PROJECT_ID]: projectView(PROJECT_ID, null) },
      answer: () => ({
        kind: "shield-servers-updated",
        view: projectView(PROJECT_ID, [WEB]),
      }),
    });

    await chooseProject(user, "Atlas");
    expect(
      await screen.findByRole("button", { name: "Use the account's servers" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Use servers for this Project only" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith({
      kind: "set-project-servers",
      projectId: PROJECT_ID,
      servers: [WEB_FIELDS],
    });
    expect(await screen.findByRole("list", { name: "Atlas servers" })).toBeVisible();
  });

  it("sends the Project's whole list when a server is added to it", async () => {
    const { command, user } = setup({
      projectViews: { [PROJECT_ID]: projectView(PROJECT_ID, [DB]) },
    });

    await chooseProject(user, "Atlas");
    const form = await screen.findByRole("form", { name: "Add a server to Atlas" });
    await user.type(within(form).getByLabelText("Host alias"), "cache-1");
    await user.type(within(form).getByLabelText("Login user"), "ops");
    await user.click(within(form).getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith({
      kind: "set-project-servers",
      projectId: PROJECT_ID,
      servers: [
        { alias: "db-1", user: "ops", profile: "read-only", deployCommands: [] },
        { alias: "cache-1", user: "ops", profile: "read-only", deployCommands: [] },
      ],
    });
  });

  it("sends the Project's list without a server that is removed from it", async () => {
    const { command, user } = setup({
      projectViews: { [PROJECT_ID]: projectView(PROJECT_ID, [WEB, DB]) },
    });

    await chooseProject(user, "Atlas");
    await user.click(await screen.findByRole("button", { name: "Remove web-1 for Atlas" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith({
      kind: "set-project-servers",
      projectId: PROJECT_ID,
      servers: [{ alias: "db-1", user: "ops", profile: "read-only", deployCommands: [] }],
    });
  });

  it("sends a Project back to the account list by clearing its own", async () => {
    const { command, user } = setup({
      projectViews: { [PROJECT_ID]: projectView(PROJECT_ID, [DB]) },
      answer: () => ({
        kind: "shield-servers-updated",
        view: projectView(PROJECT_ID, null),
      }),
    });

    await chooseProject(user, "Atlas");
    await user.click(await screen.findByRole("button", { name: "Use the account's servers" }));

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: "clear-project-override",
        projectId: PROJECT_ID,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("list", { name: "Atlas servers" })).toBeNull());
    expect(screen.getByRole("button", { name: "Use the account's servers" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows nothing it could save for the newly chosen Project until that Project's list is read", async () => {
    let finishBeacon: (value: ShieldServersView) => void = () => undefined;
    const beacon = new Promise<ShieldServersView>((resolve) => {
      finishBeacon = resolve;
    });
    const read = vi.fn(async (projectId?: string) =>
      projectId === PROJECT_ID
        ? projectView(PROJECT_ID, [DB])
        : projectId === OTHER_PROJECT_ID
          ? beacon
          : view(),
    );
    const command = vi.fn(
      async (): Promise<ShieldServersCommandResult> => ({
        kind: "shield-servers-updated",
        view: view(),
      }),
    );
    const user = userEvent.setup();
    render(<ShieldServersSettings client={{ read, command }} projectNames={PROJECTS} />);

    await chooseProject(user, "Atlas");
    expect(await screen.findByRole("list", { name: "Atlas servers" })).toBeVisible();
    await chooseProject(user, "Beacon");

    expect(await screen.findByText("Reading this Project's servers…")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Atlas servers" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use the account's servers" })).toBeNull();
    expect(command).not.toHaveBeenCalled();

    finishBeacon(projectView(OTHER_PROJECT_ID, null));
    expect(
      await screen.findByRole("button", { name: "Use the account's servers" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("drops a late answer about the Project that was chosen before", async () => {
    let answerAtlas: (value: ShieldServersCommandResult) => void = () => undefined;
    const atlasAnswer = new Promise<ShieldServersCommandResult>((resolve) => {
      answerAtlas = resolve;
    });
    const read = vi.fn(async (projectId?: string) =>
      projectId === PROJECT_ID
        ? projectView(PROJECT_ID, [DB])
        : projectId === OTHER_PROJECT_ID
          ? projectView(OTHER_PROJECT_ID, null)
          : view(),
    );
    const command = vi.fn(async () => atlasAnswer);
    const user = userEvent.setup();
    render(<ShieldServersSettings client={{ read, command }} projectNames={PROJECTS} />);

    await chooseProject(user, "Atlas");
    await user.click(await screen.findByRole("button", { name: "Remove db-1 for Atlas" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    await chooseProject(user, "Beacon");
    expect(
      await screen.findByRole("button", { name: "Use the account's servers" }),
    ).toHaveAttribute("aria-pressed", "true");

    answerAtlas({ kind: "shield-servers-updated", view: projectView(PROJECT_ID, []) });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Use the account's servers" })).toBeEnabled(),
    );
    expect(screen.getByRole("button", { name: "Use the account's servers" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("list", { name: "Atlas servers" })).toBeNull();
    expect(screen.queryByText("No servers registered.")).toBeNull();
  });

  it("says servers are managed on the host computer when there is no client", () => {
    render(<ShieldServersSettings client={undefined} projectNames={PROJECTS} />);

    expect(screen.getByText(/managed on the host computer/)).toBeVisible();
  });
});
