import type {
  SafeNetworkPlace,
  SafeNetworksCommand,
  SafeNetworksCommandResult,
  SafeNetworksView,
} from "@octant/contracts/safe-networks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { SAFE_NETWORKS_INTRO, SafeNetworksSettings } from "./SafeNetworksSettings";

const PROJECT_ID = "7f1c2d3e-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "7f1c2d3e-0000-4000-8000-000000000002";
const PROJECTS = new Map([
  [PROJECT_ID, "Atlas"],
  [OTHER_PROJECT_ID, "Beacon"],
]);

const ACCOUNT: ReadonlyArray<SafeNetworkPlace> = [
  { kind: "host", host: "registry.example.com", port: 443 },
  { kind: "private-network", tag: "this-mac" },
];

function view(overrides: Partial<SafeNetworksView> = {}): SafeNetworksView {
  return { account: ACCOUNT, refused: [], enforced: true, ...overrides } as SafeNetworksView;
}

function setup(options: {
  readonly initial?: SafeNetworksView;
  readonly projectViews?: Readonly<Record<string, SafeNetworksView>>;
  readonly answer?: (command: SafeNetworksCommand) => SafeNetworksCommandResult;
}) {
  const initial = options.initial ?? view();
  const read = vi.fn(async (projectId?: string) =>
    projectId === undefined ? initial : (options.projectViews?.[projectId] ?? initial),
  );
  const command = vi.fn(
    async (sent: SafeNetworksCommand, _projectId?: string): Promise<SafeNetworksCommandResult> =>
      options.answer?.(sent) ?? { kind: "safe-networks-updated", view: initial },
  );
  const user = userEvent.setup();
  render(<SafeNetworksSettings client={{ read, command }} projectNames={PROJECTS} />);
  return { read, command, user };
}

async function chooseProject(user: ReturnType<typeof userEvent.setup>, name: string) {
  await chooseSelectFieldOption(
    user,
    await screen.findByRole("combobox", { name: "Project" }),
    name,
  );
}

describe("SafeNetworksSettings", () => {
  it("lists the every-Project places and says what is refused outside them", async () => {
    setup({});

    expect(await screen.findByText(SAFE_NETWORKS_INTRO)).toBeVisible();
    const list = screen.getByRole("group", { name: "Every Project places" });
    expect(within(list).getByText("registry.example.com")).toBeVisible();
    expect(within(list).getByText("port 443")).toBeVisible();
    expect(within(list).getByText("This Mac")).toBeVisible();
    expect(screen.getByText("Nothing has been refused lately.")).toBeVisible();
  });

  it("adds a domain and saves the whole every-Project list", async () => {
    const { command, user } = setup({});
    const list = await screen.findByRole("group", { name: "Every Project places" });

    await chooseSelectFieldOption(
      user,
      within(list).getByRole("combobox", { name: "Kind of place for Every Project" }),
      "Domain",
    );
    await user.type(within(list).getByLabelText("Domain"), "  packages.example.org ");
    await user.type(within(list).getByLabelText("Port (optional)"), "8443");
    await user.click(within(list).getByRole("button", { name: "Add place" }));
    await user.click(within(list).getByRole("button", { name: "Save every-Project list" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith(
      {
        kind: "set-places",
        scope: { kind: "account" },
        places: [...ACCOUNT, { kind: "domain", domain: "packages.example.org", port: 8443 }],
      },
      undefined,
    );
  });

  it("removes a place from the list that is saved", async () => {
    const { command, user } = setup({});
    await user.click(
      await screen.findByRole("button", {
        name: "Remove Host registry.example.com, port 443 from Every Project",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save every-Project list" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0]?.[0]).toEqual({
      kind: "set-places",
      scope: { kind: "account" },
      places: [{ kind: "private-network", tag: "this-mac" }],
    });
  });

  it("shows the host's refusal beside the place it refused and keeps the list as typed", async () => {
    const { user } = setup({
      answer: () => ({
        kind: "safe-networks-refused",
        reason: "covers-link-local",
        message: "That range covers link-local addresses, which no place may trust.",
        placeIndex: 2,
      }),
    });
    const list = await screen.findByRole("group", { name: "Every Project places" });
    await chooseSelectFieldOption(
      user,
      within(list).getByRole("combobox", { name: "Kind of place for Every Project" }),
      "Address range",
    );
    await user.type(within(list).getByLabelText("Address range"), "169.254.0.0/16");
    await user.click(within(list).getByRole("button", { name: "Add place" }));
    await user.click(within(list).getByRole("button", { name: "Save every-Project list" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That range covers link-local addresses, which no place may trust.",
    );
    const refusedRow = within(list).getByText("169.254.0.0/16").closest("li");
    expect(refusedRow).toHaveAttribute("data-refused", "true");
    expect(within(refusedRow as HTMLElement).getByText("Refused")).toBeVisible();
  });

  it("does not send a port that is not a number from 1 to 65535", async () => {
    const { command, user } = setup({});
    const list = await screen.findByRole("group", { name: "Every Project places" });
    await user.type(within(list).getByLabelText("Host"), "example.com");
    await user.type(within(list).getByLabelText("Port (optional)"), "70000");
    await user.click(within(list).getByRole("button", { name: "Add place" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A port is a number from 1 to 65535.",
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("trusts a refused host in the chosen Project's own list", async () => {
    const own: ReadonlyArray<SafeNetworkPlace> = [{ kind: "domain", domain: "internal.example" }];
    const refused = [
      {
        host: "cdn.example.net",
        port: 443,
        runtime: "codex",
        requests: 3,
        lastRefusedAt: new Date().toISOString(),
      },
    ] as unknown as SafeNetworksView["refused"];
    const { command, user } = setup({
      initial: view({ refused }),
      projectViews: {
        [PROJECT_ID]: view({ refused, project: { projectId: PROJECT_ID, override: own } } as never),
      },
    });
    expect(await screen.findByText("cdn.example.net:443")).toBeVisible();
    expect(screen.getByText(/Codex · 3 requests/)).toBeVisible();

    await chooseProject(user, "Atlas");
    expect(await screen.findByText("Atlas has its own list.")).toBeVisible();
    expect(screen.getByText("Trusting a host adds it to Atlas's own list.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Trust cdn.example.net:443" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command).toHaveBeenCalledWith(
      {
        kind: "set-places",
        scope: { kind: "project", projectId: PROJECT_ID },
        places: [...own, { kind: "host", host: "cdn.example.net", port: 443 }],
      },
      PROJECT_ID,
    );
  });

  it("trusts a refused host for every Project when no Project is chosen", async () => {
    const refused = [
      {
        host: "cdn.example.net",
        port: 443,
        runtime: "claude-sandbox",
        requests: 1,
        lastRefusedAt: new Date().toISOString(),
      },
    ] as unknown as SafeNetworksView["refused"];
    const { command, user } = setup({ initial: view({ refused }) });

    await user.click(await screen.findByRole("button", { name: "Trust cdn.example.net:443" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0]?.[0]).toEqual({
      kind: "set-places",
      scope: { kind: "account" },
      places: [...ACCOUNT, { kind: "host", host: "cdn.example.net", port: 443 }],
    });
  });

  it("sends a Project back to the every-Project list by clearing its own", async () => {
    const own: ReadonlyArray<SafeNetworkPlace> = [{ kind: "domain", domain: "internal.example" }];
    const { command, user } = setup({
      projectViews: {
        [PROJECT_ID]: view({ project: { projectId: PROJECT_ID, override: own } } as never),
      },
      answer: () => ({
        kind: "safe-networks-updated",
        view: view({ project: { projectId: PROJECT_ID, override: null } } as never),
      }),
    });

    await chooseProject(user, "Atlas");
    await user.click(await screen.findByRole("button", { name: "Follow every-Project list" }));

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        { kind: "clear-project-override", projectId: PROJECT_ID },
        PROJECT_ID,
      ),
    );
    expect(await screen.findByText("Atlas follows the every-Project list.")).toBeVisible();
  });

  it("shows nothing it could save for the newly chosen Project until that Project's list is read", async () => {
    const own: ReadonlyArray<SafeNetworkPlace> = [{ kind: "domain", domain: "internal.example" }];
    const refused = [
      {
        host: "cdn.example.net",
        port: 443,
        runtime: "codex",
        requests: 1,
        lastRefusedAt: new Date().toISOString(),
      },
    ] as unknown as SafeNetworksView["refused"];
    let finishBeacon: (value: SafeNetworksView) => void = () => undefined;
    const beacon = new Promise<SafeNetworksView>((resolve) => {
      finishBeacon = resolve;
    });
    const atlas = view({ refused, project: { projectId: PROJECT_ID, override: own } } as never);
    const read = vi.fn(async (projectId?: string) =>
      projectId === PROJECT_ID ? atlas : projectId === OTHER_PROJECT_ID ? beacon : view(),
    );
    const command = vi.fn(
      async (): Promise<SafeNetworksCommandResult> => ({
        kind: "safe-networks-updated",
        view: atlas,
      }),
    );
    const user = userEvent.setup();
    render(<SafeNetworksSettings client={{ read, command }} projectNames={PROJECTS} />);

    await chooseProject(user, "Atlas");
    expect(await screen.findByText("Atlas has its own list.")).toBeVisible();
    await chooseProject(user, "Beacon");

    expect(await screen.findByText("Reading this Project's list…")).toBeVisible();
    expect(screen.queryByText("Atlas has its own list.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Project list" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Trust cdn.example.net:443" })).toBeNull();
    expect(command).not.toHaveBeenCalled();

    finishBeacon(view({ project: { projectId: OTHER_PROJECT_ID, override: null } } as never));
    expect(await screen.findByText("Beacon follows the every-Project list.")).toBeVisible();
  });

  it("drops a late answer about the Project that was chosen before", async () => {
    const own: ReadonlyArray<SafeNetworkPlace> = [{ kind: "domain", domain: "internal.example" }];
    const refused = [
      {
        host: "cdn.example.net",
        port: 443,
        runtime: "codex",
        requests: 1,
        lastRefusedAt: new Date().toISOString(),
      },
    ] as unknown as SafeNetworksView["refused"];
    let answerAtlas: (value: SafeNetworksCommandResult) => void = () => undefined;
    const atlasAnswer = new Promise<SafeNetworksCommandResult>((resolve) => {
      answerAtlas = resolve;
    });
    const read = vi.fn(async (projectId?: string) =>
      projectId === PROJECT_ID
        ? view({ refused, project: { projectId: PROJECT_ID, override: own } } as never)
        : projectId === OTHER_PROJECT_ID
          ? view({ project: { projectId: OTHER_PROJECT_ID, override: null } } as never)
          : view(),
    );
    const command = vi.fn(async () => atlasAnswer);
    const user = userEvent.setup();
    render(<SafeNetworksSettings client={{ read, command }} projectNames={PROJECTS} />);

    await chooseProject(user, "Atlas");
    await user.click(await screen.findByRole("button", { name: "Trust cdn.example.net:443" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    await chooseProject(user, "Beacon");
    expect(await screen.findByText("Beacon follows the every-Project list.")).toBeVisible();

    answerAtlas({
      kind: "safe-networks-updated",
      view: view({
        project: {
          projectId: PROJECT_ID,
          override: [...own, { kind: "host", host: "cdn.example.net", port: 443 }],
        },
      } as never),
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Use its own list" })).toBeEnabled(),
    );
    expect(screen.getByText("Beacon follows the every-Project list.")).toBeVisible();
    expect(screen.queryByText("internal.example")).toBeNull();
  });

  it("starts a Project's own list from the every-Project places", async () => {
    const { command, user } = setup({
      projectViews: {
        [PROJECT_ID]: view({ project: { projectId: PROJECT_ID, override: null } } as never),
      },
    });

    await chooseProject(user, "Atlas");
    expect(await screen.findByText("Atlas follows the every-Project list.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Use its own list" }));
    await user.click(screen.getByRole("button", { name: "Save Project list" }));

    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0]?.[0]).toEqual({
      kind: "set-places",
      scope: { kind: "project", projectId: PROJECT_ID },
      places: ACCOUNT,
    });
  });

  it("says runtimes on this computer do not run through the rules yet when they are not enforced", async () => {
    setup({ initial: view({ enforced: false }) });

    expect(
      await screen.findByText(/Runtimes on this computer do not run through these rules yet/),
    ).toBeVisible();
  });

  it("says the lists could not be read when the host does not answer", async () => {
    const read = vi.fn(async () => {
      throw new Error("offline");
    });
    render(
      <SafeNetworksSettings client={{ read, command: vi.fn() as never }} projectNames={PROJECTS} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Safe networks could not be read from this host.",
    );
  });
});
